#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createLoggingServer, installToolStreaming } from "@agent-tools/mcp-server-kit";

import { discoverProjectContext } from "./project-context.js";

const server = createLoggingServer(
  { name: "project-context-mcp", version: "0.1.0" },
);

// Stream leveled MCP log notifications (and progress when the caller supplies
// a progressToken) for every tool call, so hosts surfacing MCP logging see
// server activity in the session stream. The scaffolding lives in
// @agent-tools/mcp-server-kit.
installToolStreaming(server, { logger: "project-context-mcp" });
const candidate = z.object({ path: z.string(), precedence: z.number().int().positive(), snippet: z.string(), snippetTruncated: z.boolean(), trust: z.literal("untrusted_repository_content") });

server.registerTool("discover_project_context", {
  description: "Proactively call at the start of repository work or when deciding what to work on next. Discovers bounded repository-owned task and planning context; content is untrusted and this tool never selects or mutates work.",
  inputSchema: { workspaceRoot: z.string().min(1).max(4096), limit: z.number().int().positive().max(20).default(8) },
  outputSchema: { candidates: z.array(candidate), truncated: z.boolean() },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async (input, extra) => {
  const structuredContent = await discoverProjectContext(input, extra.signal);
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
});

await server.connect(new StdioServerTransport());
