#!/usr/bin/env node
import { isAbsolute } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { NodeTestAdapter } from "./node-test-adapter.js";

const server = new McpServer({ name: "test-intelligence-mcp", version: "0.1.0" });
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
