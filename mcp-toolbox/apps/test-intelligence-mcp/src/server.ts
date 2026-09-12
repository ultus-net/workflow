#!/usr/bin/env node
import { isAbsolute } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { NodeTestAdapter } from "./node-test-adapter.js";

const server = new McpServer(
  { name: "test-intelligence-mcp", version: "0.1.0" },
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
    await server.server.sendLoggingMessage({ level: "debug", logger: "test-intelligence-mcp", data: { tool: name, phase: "start" } });
    await progress("start", 0);
    try {
      const result = await handler(input, extra);
      await server.server.sendLoggingMessage({ level: "info", logger: "test-intelligence-mcp", data: { tool: name, phase: "done" } });
      await progress("done", 2);
      return result;
    } catch (error) {
      await server.server.sendLoggingMessage({ level: "error", logger: "test-intelligence-mcp", data: { tool: name, phase: "error", message: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }) as never)) as typeof server.registerTool;
const testAdapter = new NodeTestAdapter();
const workspaceRootSchema = z.string().min(1).refine(isAbsolute, "workspaceRoot must be absolute");
const limitSchema = z.number().int().positive().max(500).default(100);
const timeoutSchema = z.number().int().min(1).max(300_000).default(30_000);
const fileSchema = z.string().min(1).refine(
  (file) => !isAbsolute(file) && !file.split(/[\\/]/).includes(".."),
  "file must be a workspace-relative path without parent traversal",
);
const executionOutputSchema = {
  outcome: z.enum(["completed", "timed_out", "cancelled"]),
  exitCode: z.number().int().nullable(),
  tests: z.array(z.object({ name: z.string(), nameTruncated: z.boolean(), file: z.string(), status: z.enum(["passed", "failed", "skipped", "todo"]), durationMs: z.number().nonnegative() })),
  testsTruncated: z.boolean(),
  failures: z.array(z.object({ name: z.string(), nameTruncated: z.boolean(), file: z.string(), message: z.string(), truncated: z.boolean() })),
  failuresTruncated: z.boolean(),
  diagnosticsTruncated: z.boolean(),
};

server.registerTool(
  "discover_tests",
  {
    description: "Discover bounded Node test-runner files without executing repository code.",
    inputSchema: { workspaceRoot: workspaceRootSchema, limit: limitSchema },
    outputSchema: {
      tests: z.array(z.object({ id: z.string(), file: z.string(), label: z.string(), runner: z.literal("node") })),
      truncated: z.boolean(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async (input, extra) => {
    const result = await testAdapter.discoverTests(input, extra.signal);
    const structuredContent = { tests: [...result.tests], truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "find_relevant_tests",
  {
    description: "Rank bounded Node test files structurally relevant to a workspace file without executing repository code.",
    inputSchema: { workspaceRoot: workspaceRootSchema, file: fileSchema, limit: limitSchema },
    outputSchema: {
      tests: z.array(z.object({
        id: z.string(),
        file: z.string(),
        label: z.string(),
        runner: z.literal("node"),
        relevance: z.enum(["exact_file", "matching_stem", "same_project"]),
      })),
      truncated: z.boolean(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async (input, extra) => {
    const result = await testAdapter.findRelevantTests(input, extra.signal);
    const structuredContent = { tests: [...result.tests], truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "run_tests",
  {
    description: "Execute explicit discovered Node test IDs with bounded diagnostics, timeout, and cancellation cleanup.",
    inputSchema: {
      workspaceRoot: workspaceRootSchema,
      testIds: z.array(z.string().min(1)).min(1).max(500),
      timeoutMs: timeoutSchema,
    },
    outputSchema: executionOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async (input, extra) => {
    const result = await testAdapter.runTests(input, extra.signal);
    const structuredContent = {
      ...result,
      tests: [...result.tests],
      failures: [...result.failures],
    };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());
