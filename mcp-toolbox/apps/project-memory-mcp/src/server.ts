#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createLoggingServer, installToolStreaming } from "@agent-tools/mcp-server-kit";

import { defaultDataRoot, isMemoryStampConfig, MEMORY_KINDS, MEMORY_ORIGINS, MEMORY_WRITER_AUTHORITIES, ProjectMemoryStore, resolveRetentionWindowMs, type MemoryStampConfig } from "./project-memory.js";
import { boundToolResultText } from "./vendor/result-bounds.js";

const server = createLoggingServer(
  { name: "project-memory-mcp", version: "0.1.0" },
);

// Stream leveled MCP log notifications (and progress when the caller supplies
// a progressToken) for every tool call, and bound the model-visible text of
// every result. The scaffolding lives in @agent-tools/mcp-server-kit.
installToolStreaming(server, { logger: "project-memory-mcp", transform: boundToolResultText });
const store = new ProjectMemoryStore(defaultDataRoot(), stampFromEnv(process.env), resolveRetentionWindowMs(process.env));
const memoryKind = z.enum(MEMORY_KINDS);
const memoryOrigin = z.enum(MEMORY_ORIGINS);
const memoryRecord = z.object({
  id: z.string(), kind: memoryKind, content: z.string(), paths: z.array(z.string()), createdAt: z.number(),
  supersedes: z.string().optional(), supersededAt: z.number().optional(), status: z.enum(["current", "superseded"]),
  evidenceClass: z.literal("assertion"),
  freshness: z.enum(["fresh", "stale"]),
  provenance: z.object({
    origin: memoryOrigin, workspace: z.string(),
    writer: z.string(), authority: z.enum(MEMORY_WRITER_AUTHORITIES), originSurface: z.string(), stampedAt: z.number(),
  }),
});

/**
 * The provenance stamp is launch configuration, never a tool argument: the
 * hosting surface (operator or Workflow) sets it in the child environment so
 * an agent cannot relabel its own writes in-band. Absent config leaves the
 * store unstamped and every write fails loudly; partially-set config throws
 * here so a misconfiguration is never silently half-applied.
 */
function stampFromEnv(env: NodeJS.ProcessEnv): MemoryStampConfig | undefined {
  const writer = env.PROJECT_MEMORY_WRITER;
  const authority = env.PROJECT_MEMORY_WRITER_AUTHORITY;
  const originSurface = env.PROJECT_MEMORY_ORIGIN_SURFACE;
  if (writer === undefined && authority === undefined && originSurface === undefined) return undefined;
  const candidate = { writer, authority, originSurface };
  if (!isMemoryStampConfig(candidate)) {
    throw new Error("Invalid project memory provenance stamp configuration; PROJECT_MEMORY_WRITER, PROJECT_MEMORY_WRITER_AUTHORITY, and PROJECT_MEMORY_ORIGIN_SURFACE must all be set to valid values.");
  }
  return candidate;
}

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

server.registerTool(
  "export_memory",
  {
    description: "Explicitly promote selected durable project-memory records to the human-readable repo-local .opencode/memory/project-memory.jsonl file. Call when durable knowledge should be committed and shared with the team; omit ids to snapshot all current records. Secret-shaped content is never written out.",
    inputSchema: {
      workspaceRoot: z.string().min(1).max(4096), ids: z.array(z.string().min(1).max(200)).max(100).default([]),
      path: z.string().min(1).max(500).optional(),
    },
    outputSchema: { export: z.object({ exported: z.number().int().nonnegative(), path: z.string() }) },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input, extra) => {
    const result = await store.export(input, extra.signal);
    const structuredContent = { export: result };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "import_memory",
  {
    description: "Import the repo-local .opencode/memory/project-memory.jsonl file into this project's local working-memory index. Call to synchronize local project memory with shared repository records; already-present records are skipped and secret-shaped or malformed lines are rejected.",
    inputSchema: { workspaceRoot: z.string().min(1).max(4096), path: z.string().min(1).max(500).optional() },
    outputSchema: { import: z.object({ imported: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(), path: z.string() }) },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input, extra) => {
    const result = await store.import(input, extra.signal);
    const structuredContent = { import: result };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());
