#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { z } from "zod";

import { createAuthorityPorts } from "./authority-ports.js";
import { defaultDataRoot, VerificationStore, type RecordVerificationInput } from "./verification.js";

const server = new McpServer(
  { name: "verification-accountability-mcp", version: "0.1.0" },
  {
    capabilities: {
      logging: {},
      tasks: { requests: { tools: { call: {} } }, list: {}, cancel: {} },
    },
    taskStore: new InMemoryTaskStore(),
  },
);

// Stream leveled MCP log notifications (and progress when the caller supplies
// a progressToken) for every tool call, so hosts surfacing MCP logging see
// server activity in the session stream. See learning-mcp for the pattern.
type ToolExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: unknown) => Promise<void>;
};
const registerTool = server.registerTool.bind(server);
server.registerTool = ((name: string, config: unknown, handler: (input: never, extra: ToolExtra) => Promise<unknown>) =>
  registerTool(name as never, config as never, (async (input: never, extra: ToolExtra) => {
    const progressToken = extra._meta?.progressToken;
    const progress = async (message: string, value: number) => {
      if (progressToken === undefined) return;
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: value, total: 2, message } } as never);
    };
    await server.server.sendLoggingMessage({ level: "debug", logger: "verification-accountability-mcp", data: { tool: name, phase: "start" } });
    await progress("start", 0);
    try {
      const result = await handler(input, extra);
      await server.server.sendLoggingMessage({ level: "info", logger: "verification-accountability-mcp", data: { tool: name, phase: "done" } });
      await progress("done", 2);
      return result;
    } catch (error) {
      await server.server.sendLoggingMessage({ level: "error", logger: "verification-accountability-mcp", data: { tool: name, phase: "error", message: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }) as never)) as typeof server.registerTool;
const authorities = createAuthorityPorts();
const store = new VerificationStore(defaultDataRoot(), authorities);
const localResult = z.object({ outcome: z.enum(["completed", "timed_out", "cancelled"]), exitCode: z.number().int().nullable(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), todo: z.number().int().nonnegative(), testsTruncated: z.boolean(), failuresTruncated: z.boolean(), diagnosticsTruncated: z.boolean() });
const ciResult = z.object({ revision: z.string().regex(/^[0-9a-fA-F]{40}$/), state: z.enum(["queued", "in_progress", "completed"]), conclusion: z.enum(["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "unknown"]).optional(), listingTruncated: z.boolean() });
const browserResult = z.object({ outcome: z.enum(["passed", "failed", "inconclusive"]), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), truncated: z.boolean() });
const localSource = z.object({ kind: z.literal("local_test"), capability: z.literal("test-intelligence-mcp/run_tests"), testIds: z.array(z.string()) });
const ciSource = z.object({ kind: z.literal("ci_run"), capability: z.literal("ci-intelligence-mcp/list_ci_runs"), provider: z.literal("github"), repository: z.string(), runId: z.string() });
const browserSource = z.object({ kind: z.literal("browser_verification"), capability: z.literal("browser-verification-mcp/run_verification"), evidenceId: z.string(), evidenceHash: z.string(), observedAt: z.number() });
const subject = z.union([
  z.object({ kind: z.literal("local_test_execution"), workspace: z.string(), contentSubject: z.literal("unavailable") }),
  z.object({ kind: z.literal("ci_revision"), provider: z.string(), repository: z.string(), revision: z.string() }),
  z.object({ kind: z.literal("browser_page"), url: z.string(), origin: z.string(), pageHash: z.string() }),
]);
const currentSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fingerprint"), algorithm: z.string().min(1).max(100), version: z.string().min(1).max(100), scope: z.string().min(1).max(200), value: z.string().min(1).max(300) }),
  z.object({ kind: z.literal("ci_revision"), provider: z.string().min(1).max(100), repository: z.string().min(1).max(300), revision: z.string().regex(/^[0-9a-fA-F]{40}$/) }),
  z.object({ kind: z.literal("browser_page"), url: z.string().min(1).max(2048), pageHash: z.string().regex(/^[0-9a-fA-F]{64}$/) }),
]);
const observation = z.object({ id: z.string(), evidenceClass: z.literal("observation"), source: z.union([localSource, ciSource, browserSource]), result: z.union([localResult, ciResult, browserResult]), subject, recordedAt: z.number(), freshness: z.enum(["fresh", "stale", "unknown"]), provenance: z.object({ workspace: z.string() }) });

server.registerTool("record_verification", {
  description: "Call when a new verification observation is required for changed work. Obtains bounded results directly from Test, CI, or Browser Verification and persists the observation; caller-supplied result claims are not accepted. Local test content freshness remains unknown. Browser observations preserve the page identity the browser tool observed (its hash-stamped evidence id and observed-at time), never a caller-asserted page state.",
  inputSchema: {
    workspaceRoot: z.string().min(1).max(4096),
    request: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("local_test"), testIds: z.array(z.string().min(1).max(1000)).min(1).max(500), timeoutMs: z.number().int().min(100).max(120_000).optional() }),
      z.object({ kind: z.literal("ci_run"), runId: z.string().regex(/^github:[1-9]\d*$/), revision: z.string().regex(/^[0-9a-fA-F]{40}$/).optional() }),
      z.object({ kind: z.literal("browser_verification"), url: z.string().min(1).max(2048), assertions: z.array(z.record(z.string(), z.unknown())).max(20).default([]) }),
    ]),
  },
  outputSchema: { observation }, annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => {
  const recorded = await store.recordVerification(input as RecordVerificationInput, extra.signal); const structuredContent = { observation: recorded };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
});

server.registerTool("list_verifications", {
  description: "Proactively call before finalizing or handing off work to recover existing verification evidence and its freshness. Local Test Intelligence content freshness remains unknown because its execution contract has no content-sensitive subject. Browser observations are fresh only when the current page identity (url plus page hash) matches the observed one; otherwise they are stale or unknown.",
  inputSchema: { workspaceRoot: z.string().min(1).max(4096), currentSubject: currentSubject.optional(), limit: z.number().int().positive().max(50).default(20) },
  outputSchema: { observations: z.array(observation), truncated: z.boolean() }, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async (input, extra) => {
  const result = await store.listVerifications(input, extra.signal); const structuredContent = result;
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
});

const asyncVerificationInputSchema = {
  workspaceRoot: z.string().min(1).max(4096),
  request: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local_test"), testIds: z.array(z.string().min(1).max(1000)).min(1).max(500), timeoutMs: z.number().int().min(100).max(120_000).optional() }),
    z.object({ kind: z.literal("ci_run"), runId: z.string().regex(/^github:[1-9]\d*$/), revision: z.string().regex(/^[0-9a-fA-F]{40}$/).optional() }),
  ]),
};

// Long-running verification as a Tasks-extension tool (MCP 2026-07-28,
// SEP-2663). The bounded authority-backed observation is obtained
// out-of-band; hosts poll tasks/get, observe task status transitions, and see
// the same leveled log notifications as the synchronous tools. Cancellation
// follows the request AbortSignal.
server.experimental.tasks.registerToolTask("run_verification_async", {
  description: "Long-running variant of record_verification for Tasks-capable hosts. Creates a task, obtains bounded authority-backed verification evidence out-of-band, and reports status through tasks/get plus the existing leveled log conventions. Caller-supplied result claims are not accepted.",
  inputSchema: asyncVerificationInputSchema,
  outputSchema: { observation },
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
}, {
  async createTask(input, extra) {
    const options = extra.taskRequestedTtl === undefined
      ? { pollInterval: 1000 }
      : { ttl: extra.taskRequestedTtl, pollInterval: 1000 };
    const task = await extra.taskStore.createTask(options);
    void (async () => {
      const log = async (level: "debug" | "info" | "error", phase: string, message?: string) => {
        await server.server.sendLoggingMessage({
          level,
          logger: "verification-accountability-mcp",
          data: { tool: "run_verification_async", phase, taskId: task.taskId, ...(message === undefined ? {} : { message }) },
        });
      };
      try {
        await log("debug", "start");
        const recorded = await store.recordVerification(input as RecordVerificationInput, extra.signal);
        const structuredContent = { observation: recorded };
        await extra.taskStore.storeTaskResult(task.taskId, "completed", {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        } as never);
        await log("info", "done");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await extra.taskStore.storeTaskResult(task.taskId, "failed", {
          content: [{ type: "text", text: message }],
          isError: true,
        } as never);
        await log("error", "error", message);
      }
    })();
    return { task };
  },
  async getTask(_input, extra) {
    return extra.taskStore.getTask(extra.taskId);
  },
  async getTaskResult(_input, extra) {
    return (await extra.taskStore.getTaskResult(extra.taskId)) as never;
  },
});

process.once("SIGTERM", () => { void authorities.close().finally(() => process.exit(0)); });
await server.connect(new StdioServerTransport());