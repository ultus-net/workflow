#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recoverContinuity } from "./checkpoint.js";
import { createContinuityPort } from "./primitive-port.js";

const server = new McpServer({ name: "continuity-checkpoint-mcp", version: "0.1.0" });
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
