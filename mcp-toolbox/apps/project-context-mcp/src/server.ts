#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { discoverProjectContext } from "./project-context.js";

const server = new McpServer(
  { name: "project-context-mcp", version: "0.1.0" },
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
    await server.server.sendLoggingMessage({ level: "debug", logger: "project-context-mcp", data: { tool: name, phase: "start" } });
    await progress("start", 0);
    try {
      const result = await handler(input, extra);
      await server.server.sendLoggingMessage({ level: "info", logger: "project-context-mcp", data: { tool: name, phase: "done" } });
      await progress("done", 2);
      return result;
    } catch (error) {
      await server.server.sendLoggingMessage({ level: "error", logger: "project-context-mcp", data: { tool: name, phase: "error", message: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }) as never)) as typeof server.registerTool;
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
