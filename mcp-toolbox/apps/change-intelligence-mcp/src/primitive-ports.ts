import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

import type { CodeSemanticPort, GitStatusPort, TestRelevancePort } from "./assessment.js";

const changeState = z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed", "unmerged", "untracked", "none"]);
const statusEntry = z.object({
    path: z.string(),
    originalPath: z.string().optional(),
    staged: changeState,
    unstaged: changeState,
    conflict: z.string().optional(),
});
const relevantTest = z.object({
    id: z.string(),
    file: z.string(),
    relevance: z.enum(["exact_file", "matching_stem", "same_project"]),
});
const diffFile = z.object({
    path: z.string(), originalPath: z.string().optional(),
    change: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed", "unmerged"]),
    binary: z.boolean(), patch: z.string().optional(), patchTruncated: z.boolean(),
});
const location = z.object({
  file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(),
  endLine: z.number().int().positive(), endColumn: z.number().int().positive(),
});
const testRunResult = z.object({
  outcome: z.enum(["completed", "timed_out", "cancelled"]), exitCode: z.number().int().nullable(),
  tests: z.array(z.object({ name: z.string(), nameTruncated: z.boolean(), file: z.string(), status: z.enum(["passed", "failed", "skipped", "todo"]), durationMs: z.number() })).max(1000),
  testsTruncated: z.boolean(),
  failures: z.array(z.object({ name: z.string(), nameTruncated: z.boolean(), file: z.string(), message: z.string(), truncated: z.boolean() })).max(100),
  failuresTruncated: z.boolean(), diagnosticsTruncated: z.boolean(),
});

class PrimitiveClient {
  private client?: Client;

  constructor(
    private readonly name: string,
    private readonly command: string,
    private readonly args: string[],
  ) {}

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.client) {
      this.client = new Client({ name: "change-intelligence-mcp", version: "0.1.0" });
      await this.client.connect(new StdioClientTransport({ command: this.command, args: this.args, stderr: "pipe" }));
    }
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal });
    if (result.isError || result.structuredContent === undefined) {
      throw new Error(`${this.name}.${name} failed`);
    }
    return result.structuredContent;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}

export function createPrimitivePorts(): { git: GitStatusPort; tests: TestRelevancePort; code: CodeSemanticPort; close: () => Promise<void> } {
  const git = new PrimitiveClient("git", process.env.CHANGE_INTELLIGENCE_GIT_COMMAND ?? "git-intelligence-mcp", parseArgs("CHANGE_INTELLIGENCE_GIT_ARGS"));
  const tests = new PrimitiveClient("test", process.env.CHANGE_INTELLIGENCE_TEST_COMMAND ?? "test-intelligence-mcp", parseArgs("CHANGE_INTELLIGENCE_TEST_ARGS"));
  const code = new PrimitiveClient("code", process.env.CHANGE_INTELLIGENCE_CODE_COMMAND ?? "code-intelligence-mcp", parseArgs("CHANGE_INTELLIGENCE_CODE_ARGS"));
  return {
    git: {
      workingTreeStatus: async (query, signal) => callRequired(
        "git.working_tree_status",
        async () => z.object({ entries: z.array(statusEntry).max(query.limit), truncated: z.boolean() }).parse(await git.callTool("working_tree_status", query, signal)),
      ),
      localDiff: async (query, signal) => callRequired(
        "git.local_diff",
        async () => z.object({ files: z.array(diffFile).max(query.limit), truncated: z.boolean(), evidenceTruncated: z.boolean() }).parse(await git.callTool("local_diff", query, signal)),
      ),
    },
    tests: {
      findRelevantTests: async (query, signal) => callRequired(
        "test.find_relevant_tests",
        async () => z.object({ tests: z.array(relevantTest).max(query.limit), truncated: z.boolean() }).parse(await tests.callTool("find_relevant_tests", query, signal)),
      ),
      runTests: async (query, signal) => callRequired(
        "test.run_tests",
        async () => testRunResult.parse(await tests.callTool("run_tests", query, signal)),
      ),
    },
    code: {
      documentSymbols: async (query, signal) => callRequired(
        "code.document_symbols",
        async () => z.object({ symbols: z.array(location.extend({ name: z.string(), kind: z.string() })).max(query.limit), truncated: z.boolean() }).parse(await code.callTool("document_symbols", query, signal)),
      ),
      findReferences: async (query, signal) => callRequired(
        "code.find_references",
        async () => z.object({ locations: z.array(location).max(query.limit), truncated: z.boolean() }).parse(await code.callTool("find_references", query, signal)),
      ),
    },
    close: async () => Promise.all([git.close(), tests.close(), code.close()]).then(() => undefined),
  };
}

async function callRequired<T>(capability: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new Error(`required capability ${capability} failed`, { cause: error });
  }
}

function parseArgs(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed;
}
