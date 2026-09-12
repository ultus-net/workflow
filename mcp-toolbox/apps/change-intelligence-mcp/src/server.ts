#!/usr/bin/env node
import { isAbsolute } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { assessLocalChange } from "./assessment.js";
import { createPrimitivePorts } from "./primitive-ports.js";

const server = new McpServer(
  { name: "change-intelligence-mcp", version: "0.1.0" },
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
    await server.server.sendLoggingMessage({ level: "debug", logger: "change-intelligence-mcp", data: { tool: name, phase: "start" } });
    await progress("start", 0);
    try {
      const result = await handler(input, extra);
      await server.server.sendLoggingMessage({ level: "info", logger: "change-intelligence-mcp", data: { tool: name, phase: "done" } });
      await progress("done", 2);
      return result;
    } catch (error) {
      await server.server.sendLoggingMessage({ level: "error", logger: "change-intelligence-mcp", data: { tool: name, phase: "error", message: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }) as never)) as typeof server.registerTool;
const ports = createPrimitivePorts();
process.once("SIGINT", () => void ports.close().finally(() => process.exit(130)));
process.once("SIGTERM", () => void ports.close().finally(() => process.exit(143)));
const state = z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed", "unmerged", "untracked", "none"]);
const provenance = z.object({ capability: z.string(), id: z.string() });

server.registerTool(
  "assess_local_change",
  {
    description: "Proactively call after meaningful local edits or before finalizing changed work to assess bounded change evidence, verification gaps, and recommended checks. Relevant tests are only executed when runRelevantTests is explicitly true.",
    inputSchema: {
      workspaceRoot: z.string().min(1).refine(isAbsolute, "workspaceRoot must be absolute"),
      pathLimit: z.number().int().positive().max(500).default(100),
      testLimit: z.number().int().positive().max(100).default(20),
      symbolLimit: z.number().int().positive().max(100).default(20),
      referenceLimit: z.number().int().positive().max(500).default(100),
      recommendationLimit: z.number().int().positive().max(100).default(20),
      testExecutionLimit: z.number().int().positive().max(500).default(20),
      runRelevantTests: z.boolean().default(false),
      testTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
    },
    outputSchema: {
      paths: z.array(z.object({
        path: z.string(),
        originalPath: z.string().optional(),
        staged: state,
        unstaged: state,
        conflict: z.string().optional(),
        source: provenance,
        relevantTests: z.array(z.object({
          id: z.string(),
          file: z.string(),
          relevance: z.enum(["exact_file", "matching_stem", "same_project"]),
          source: provenance,
        })).nullable(),
        testsTruncated: z.boolean().nullable(),
        affectedSymbols: z.array(z.object({
          name: z.string(), kind: z.string(),
          file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), endLine: z.number().int().positive(), endColumn: z.number().int().positive(),
          sources: z.array(provenance),
          consumers: z.array(z.object({
            file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), endLine: z.number().int().positive(), endColumn: z.number().int().positive(),
            source: provenance,
          })).nullable(),
          consumersTruncated: z.boolean().nullable(),
        })).nullable(),
        symbolsTruncated: z.boolean().nullable(),
      })),
      pathsTruncated: z.boolean(),
      incomplete: z.boolean(),
      testRun: z.object({
        outcome: z.enum(["completed", "timed_out", "cancelled"]), exitCode: z.number().int().nullable(),
        tests: z.array(z.object({ name: z.string(), nameTruncated: z.boolean(), file: z.string(), status: z.enum(["passed", "failed", "skipped", "todo"]), durationMs: z.number() })),
        testsTruncated: z.boolean(), failures: z.array(z.object({ name: z.string(), nameTruncated: z.boolean(), file: z.string(), message: z.string(), truncated: z.boolean() })),
        failuresTruncated: z.boolean(), diagnosticsTruncated: z.boolean(), source: provenance,
        requestedTestIds: z.array(z.string()),
      }).nullable(),
      verificationGaps: z.array(z.object({ kind: z.enum(["no_relevant_tests", "relevant_tests_not_run", "failed_test", "incomplete_evidence"]), path: z.string().optional(), testId: z.string().optional(), file: z.string().optional(), sources: z.array(provenance) })),
      recommendedChecks: z.array(z.object({ kind: z.enum(["run_test", "review_test_gap"]), testId: z.string().optional(), file: z.string().optional(), sources: z.array(provenance) })),
      recommendationsTruncated: z.boolean(),
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (input, extra) => {
    const structuredContent = await assessLocalChange(input, ports, extra.signal);
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());
