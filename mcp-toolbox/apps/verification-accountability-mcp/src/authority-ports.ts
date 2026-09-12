import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

import type { VerificationAuthorities } from "./verification.js";

const testResult = z.object({
  outcome: z.enum(["completed", "timed_out", "cancelled"]), exitCode: z.number().int().nullable(),
  tests: z.array(z.object({ status: z.enum(["passed", "failed", "skipped", "todo"]) }).passthrough()).max(1000), testsTruncated: z.boolean(),
  failures: z.array(z.unknown()).max(100), failuresTruncated: z.boolean(), diagnosticsTruncated: z.boolean(),
});
const ciResult = z.object({
  runs: z.array(z.object({ id: z.string(), revision: z.string().regex(/^[0-9a-fA-F]{40}$/), state: z.enum(["queued", "in_progress", "completed"]), conclusion: z.enum(["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "unknown"]).optional() }).passthrough()).max(100),
  truncated: z.boolean(),
});

class PrimitiveClient {
  private client?: Client;
  constructor(private readonly command: string, private readonly args: string[], private readonly env?: Record<string, string>) {}
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.client) {
      this.client = new Client({ name: "verification-accountability-mcp", version: "0.1.0" });
      await this.client.connect(new StdioClientTransport({ command: this.command, args: this.args, stderr: "pipe", ...(this.env ? { env: this.env } : {}) }));
    }
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal });
    if (result.isError || result.structuredContent === undefined) throw new Error(`verification authority ${name} failed`);
    return result.structuredContent;
  }
  async close(): Promise<void> { await this.client?.close(); this.client = undefined; }
}

function parseArgs(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  try { const parsed = JSON.parse(raw) as unknown; if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) throw new Error(); return parsed; }
  catch { throw new Error(`${name} must be a JSON array of strings.`); }
}

export function createAuthorityPorts(): VerificationAuthorities & { close(): Promise<void> } {
  const tests = new PrimitiveClient(process.env.VERIFICATION_ACCOUNTABILITY_TEST_COMMAND ?? "test-intelligence-mcp", parseArgs("VERIFICATION_ACCOUNTABILITY_TEST_ARGS"));
  const ciEnv = Object.fromEntries(["CI_GITHUB_REPOSITORY", "CI_GITHUB_TOKEN", "CI_GITHUB_API_URL"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  const ci = new PrimitiveClient(process.env.VERIFICATION_ACCOUNTABILITY_CI_COMMAND ?? "ci-intelligence-mcp", parseArgs("VERIFICATION_ACCOUNTABILITY_CI_ARGS"), ciEnv);
  return {
    runTests: async (input, signal) => testResult.parse(await tests.call("run_tests", input, signal)),
    listCiRuns: async (input, signal) => ciResult.parse(await ci.call("list_ci_runs", input, signal)),
    ciRepository: () => process.env.CI_GITHUB_REPOSITORY,
    close: async () => { await Promise.all([tests.close(), ci.close()]); },
  };
}
