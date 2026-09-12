#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { defaultDataRoot, MEMORY_KINDS, ProjectMemoryStore } from "./project-memory.js";

const server = new McpServer({ name: "project-memory-mcp", version: "0.1.0" });
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
