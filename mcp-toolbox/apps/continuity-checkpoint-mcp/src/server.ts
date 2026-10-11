#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createLoggingServer, installToolStreaming } from "@agent-tools/mcp-server-kit";

import { recoverContinuity } from "./checkpoint.js";
import { createContinuityPort } from "./primitive-port.js";

const server = createLoggingServer(
  { name: "continuity-checkpoint-mcp", version: "0.1.0" },
);

// Stream leveled MCP log notifications (and progress when the caller supplies
// a progressToken) for every tool call, so hosts surfacing MCP logging see
// server activity in the session stream. The scaffolding lives in
// @agent-tools/mcp-server-kit.
installToolStreaming(server, { logger: "continuity-checkpoint-mcp" });
const port = createContinuityPort();
const source = z.enum(["review", "verification", "project_context", "project_memory"]);

server.registerTool("recover_continuity", {
  description: "Recover a deterministic, read-only, globally bounded checkpoint from existing review, verification, project-context, and project-memory evidence. Sources are consumed in that priority order; this tool does not persist state, select work, execute verification, or inject host context.",
  inputSchema: {
    workspaceRoot: z.string().min(1).max(4096).refine(isAbsolute, "workspaceRoot must be absolute"),
    memoryQuery: z.string().min(1).max(500),
    maxChars: z.number().int().positive().max(100_000).default(12_000),
    sourceLimit: z.number().int().positive().max(20).default(8),
  },
  outputSchema: {
    context: z.string(), includedSources: z.array(source), omittedSources: z.array(source), truncated: z.boolean(), sourceOrder: z.array(source),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async (input, extra) => {
  const structuredContent = await recoverContinuity(input, port, extra.signal);
  return { content: [{ type: "text", text: structuredContent.context }], structuredContent };
});

process.once("SIGINT", () => void port.close().finally(() => process.exit(130)));
process.once("SIGTERM", () => void port.close().finally(() => process.exit(143)));
await server.connect(new StdioServerTransport());
