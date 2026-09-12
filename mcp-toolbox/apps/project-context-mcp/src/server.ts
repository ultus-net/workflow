#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { discoverProjectContext } from "./project-context.js";

const server = new McpServer({ name: "project-context-mcp", version: "0.1.0" });
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
