#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recoverContinuity } from "./checkpoint.js";
import { createContinuityPort } from "./primitive-port.js";

const server = new McpServer(
  { name: "continuity-checkpoint-mcp", version: "0.1.0" },
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
    await server.server.sendLoggingMessage({ level: "debug", logger: "continuity-checkpoint-mcp", data: { tool: name, phase: "start" } });
    await progress("start", 0);
    try {
      const result = await handler(input, extra);
      await server.server.sendLoggingMessage({ level: "info", logger: "continuity-checkpoint-mcp", data: { tool: name, phase: "done" } });
      await progress("done", 2);
      return result;
    } catch (error) {
      await server.server.sendLoggingMessage({ level: "error", logger: "continuity-checkpoint-mcp", data: { tool: name, phase: "error", message: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }) as never)) as typeof server.registerTool;
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
