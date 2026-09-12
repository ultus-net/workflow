#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createAuthorityPorts } from "./authority-ports.js";
import { defaultDataRoot, VerificationStore, type RecordVerificationInput } from "./verification.js";

const server = new McpServer(
  { name: "verification-accountability-mcp", version: "0.1.0" },
  { capabilities: { logging: {} } },
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
const localSource = z.object({ kind: z.literal("local_test"), capability: z.literal("test-intelligence-mcp/run_tests"), testIds: z.array(z.string()) });
const ciSource = z.object({ kind: z.literal("ci_run"), capability: z.literal("ci-intelligence-mcp/list_ci_runs"), provider: z.literal("github"), repository: z.string(), runId: z.string() });
const subject = z.union([z.object({ kind: z.literal("local_test_execution"), workspace: z.string(), contentSubject: z.literal("unavailable") }), z.object({ kind: z.literal("ci_revision"), provider: z.string(), repository: z.string(), revision: z.string() })]);
const currentSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fingerprint"), algorithm: z.string().min(1).max(100), version: z.string().min(1).max(100), scope: z.string().min(1).max(200), value: z.string().min(1).max(300) }),
  z.object({ kind: z.literal("ci_revision"), provider: z.string().min(1).max(100), repository: z.string().min(1).max(300), revision: z.string().regex(/^[0-9a-fA-F]{40}$/) }),
]);
const observation = z.object({ id: z.string(), evidenceClass: z.literal("observation"), source: z.union([localSource, ciSource]), result: z.union([localResult, ciResult]), subject, recordedAt: z.number(), freshness: z.enum(["fresh", "stale", "unknown"]), provenance: z.object({ workspace: z.string() }) });

server.registerTool("record_verification", {
  description: "Call when a new verification observation is required for changed work. Obtains bounded results directly from Test or CI Intelligence and persists the observation; caller-supplied result claims are not accepted. Local test content freshness remains unknown.",
  inputSchema: {
    workspaceRoot: z.string().min(1).max(4096),
    request: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("local_test"), testIds: z.array(z.string().min(1).max(1000)).min(1).max(500), timeoutMs: z.number().int().min(100).max(120_000).optional() }),
      z.object({ kind: z.literal("ci_run"), runId: z.string().regex(/^github:[1-9]\d*$/), revision: z.string().regex(/^[0-9a-fA-F]{40}$/).optional() }),
    ]),
  },
  outputSchema: { observation }, annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => {
  const recorded = await store.recordVerification(input as RecordVerificationInput, extra.signal); const structuredContent = { observation: recorded };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
});

server.registerTool("list_verifications", {
  description: "Proactively call before finalizing or handing off work to recover existing verification evidence and its freshness. Local Test Intelligence content freshness remains unknown because its execution contract has no content-sensitive subject.",
  inputSchema: { workspaceRoot: z.string().min(1).max(4096), currentSubject: currentSubject.optional(), limit: z.number().int().positive().max(50).default(20) },
  outputSchema: { observations: z.array(observation), truncated: z.boolean() }, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async (input, extra) => {
  const result = await store.listVerifications(input, extra.signal); const structuredContent = result;
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
});

process.once("SIGTERM", () => { void authorities.close().finally(() => process.exit(0)); });
await server.connect(new StdioServerTransport());
