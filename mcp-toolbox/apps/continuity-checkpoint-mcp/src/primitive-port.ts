import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { ContinuityPort } from "./checkpoint.js";

const schemas = {
  list_reviews: z.object({ reviews: z.array(z.unknown()), openFollowUps: z.array(z.unknown()), truncated: z.boolean(), followUpsTruncated: z.boolean() }).passthrough(),
  list_verifications: z.object({ observations: z.array(z.unknown()), truncated: z.boolean() }).passthrough(),
  discover_project_context: z.object({ candidates: z.array(z.unknown()), truncated: z.boolean() }).passthrough(),
  search_memory: z.object({ records: z.array(z.unknown()), truncated: z.boolean() }).passthrough(),
} as const;

class PrimitiveClient {
  private client?: Client;
  constructor(private readonly command: string, private readonly args: string[]) {}
  async call(name: keyof typeof schemas, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.client) {
      this.client = new Client({ name: "continuity-checkpoint-mcp", version: "0.1.0" });
      await this.client.connect(new StdioClientTransport({ command: this.command, args: this.args, stderr: "pipe" }));
    }
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal });
    if (result.isError || result.structuredContent === undefined) throw new Error(`${this.command}.${name} failed`);
    return schemas[name].parse(result.structuredContent);
  }
  async close() { await this.client?.close(); this.client = undefined; }
}

export function createContinuityPort(): ContinuityPort & { close(): Promise<void> } {
  const review = client("REVIEW", "review-accountability-mcp");
  const verification = client("VERIFICATION", "verification-accountability-mcp");
  const context = client("CONTEXT", "project-context-mcp");
  const memory = client("MEMORY", "project-memory-mcp");
  return {
    review: (query, signal) => review.call("list_reviews", query, signal),
    verification: (query, signal) => verification.call("list_verifications", query, signal),
    context: (query, signal) => context.call("discover_project_context", query, signal),
    memory: (query, signal) => memory.call("search_memory", query, signal),
    close: async () => Promise.all([review.close(), verification.close(), context.close(), memory.close()]).then(() => undefined),
  };
}

function client(name: string, fallback: string): PrimitiveClient {
  const prefix = `CONTINUITY_CHECKPOINT_${name}`;
  return new PrimitiveClient(process.env[`${prefix}_COMMAND`] ?? fallback, parseArgs(`${prefix}_ARGS`));
}

function parseArgs(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${name} must be a JSON array of strings`);
  return value;
}
