#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { defaultDataRoot, MEMORY_KINDS, ProjectMemoryStore } from "./project-memory.js";

const server = new McpServer(
  { name: "project-memory-mcp", version: "0.1.0" },
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
    await server.server.sendLoggingMessage({ level: "debug", logger: "project-memory-mcp", data: { tool: name, phase: "start" } });
    await progress("start", 0);
    try {
      const result = await handler(input, extra);
      await server.server.sendLoggingMessage({ level: "info", logger: "project-memory-mcp", data: { tool: name, phase: "done" } });
      await progress("done", 2);
      return result;
    } catch (error) {
      await server.server.sendLoggingMessage({ level: "error", logger: "project-memory-mcp", data: { tool: name, phase: "error", message: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }) as never)) as typeof server.registerTool;
const store = new ProjectMemoryStore(defaultDataRoot());
const memoryKind = z.enum(MEMORY_KINDS);
const memoryRecord = z.object({
  id: z.string(), kind: memoryKind, content: z.string(), paths: z.array(z.string()), createdAt: z.number(),
  supersedes: z.string().optional(), status: z.enum(["current", "superseded"]), evidenceClass: z.literal("assertion"),
  freshness: z.enum(["fresh", "stale"]),
  provenance: z.object({ origin: z.literal("project-memory-mcp/record_memory"), workspace: z.string() }),
});

server.registerTool(
  "record_memory",
  {
    description: "Proactively record durable facts, decisions, constraints, or lessons that will matter in future sessions. Persists bounded workspace-scoped agent assertions and rejects common secret forms; do not record transient tool output or speculation.",
    inputSchema: {
      workspaceRoot: z.string().min(1).max(4096), kind: memoryKind, content: z.string().min(1).max(4096),
      paths: z.array(z.string().min(1).max(500)).max(20).default([]), supersedes: z.string().min(1).max(200).optional(),
    },
    outputSchema: { record: memoryRecord },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (input, extra) => {
    const record = await store.record(input, extra.signal);
    const structuredContent = { record };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "search_memory",
  {
    description: "Proactively search current project memory when starting related work or before making assumptions about prior decisions and constraints. Results are bounded agent assertions, not proof.",
    inputSchema: { workspaceRoot: z.string().min(1).max(4096), query: z.string().min(1).max(500), limit: z.number().int().positive().max(20).default(8) },
    outputSchema: { records: z.array(memoryRecord), truncated: z.boolean() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (input, extra) => {
    const result = await store.search(input, extra.signal);
    const structuredContent = { records: result.records, truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());
