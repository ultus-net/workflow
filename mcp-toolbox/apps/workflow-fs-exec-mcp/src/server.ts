#!/usr/bin/env node
import { isAbsolute } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { authorizeBeforeTool, runBash } from "./hub-client.js";
import { applyEdit, applyWrite } from "./fs-ops.js";
import { boundToolResultText } from "./vendor/result-bounds.js";

/**
 * Plan Task G3: tool substitution for non-cooperative agents. Hosts deny
 * their built-in mutation tools ("edit": "deny", "bash": "deny"); this server
 * becomes the model's only mutation path, and every tool call authorizes
 * through the hub FIRST (fail closed — no hub, no mutations) before acting.
 */

const server = new McpServer(
  { name: "workflow-fs-exec-mcp", version: "0.1.0" },
  { capabilities: { logging: {} } },
);

type ToolExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: unknown) => Promise<void>;
};
const registerTool = server.registerTool.bind(server);
server.registerTool = ((name: string, config: unknown, handler: (input: never, extra: ToolExtra) => Promise<unknown>) =>
  registerTool(name as never, config as never, (async (input: never, extra: ToolExtra) => {
    await server.server.sendLoggingMessage({ level: "debug", logger: "workflow-fs-exec-mcp", data: { tool: name, phase: "start" } });
    try {
      const result = await handler(input, extra);
      await server.server.sendLoggingMessage({ level: "info", logger: "workflow-fs-exec-mcp", data: { tool: name, phase: "done" } });
      return boundToolResultText(result);
    } catch (error) {
      await server.server.sendLoggingMessage({ level: "error", logger: "workflow-fs-exec-mcp", data: { tool: name, phase: "error", message: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }) as never)) as typeof server.registerTool;

const workspaceSchema = z.string().min(1).refine(isAbsolute, "workspace must be absolute");
const pathSchema = z.string().min(1);

server.registerTool(
  "workflow_write",
  {
    description: "Create or overwrite a file inside the workspace. Authorizes through the Workflow hub first (fail closed).",
    inputSchema: {
      workspace: workspaceSchema,
      path: pathSchema,
      content: z.string(),
    },
    outputSchema: { path: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async (input: { workspace: string; path: string; content: string }) => {
    await authorizeBeforeTool({
      toolCall: { toolName: "write_to_file" },
      input: { path: input.path, content: input.content },
      workspace: input.workspace,
    });
    const target = applyWrite(input);
    return {
      content: [{ type: "text", text: JSON.stringify({ path: input.path }) }],
      structuredContent: { path: input.path },
    };
    void target;
  },
);

server.registerTool(
  "workflow_edit",
  {
    description: "Replace one exact string occurrence in a workspace file. Authorizes through the Workflow hub first (fail closed).",
    inputSchema: {
      workspace: workspaceSchema,
      path: pathSchema,
      old_string: z.string().min(1),
      new_string: z.string(),
    },
    outputSchema: { path: z.string(), replacements: z.number().int() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async (input: { workspace: string; path: string; old_string: string; new_string: string }) => {
    await authorizeBeforeTool({
      toolCall: { toolName: "replace_in_file" },
      input: { path: input.path, diff: input.old_string },
      workspace: input.workspace,
    });
    applyEdit({ workspace: input.workspace, path: input.path, oldString: input.old_string, newString: input.new_string });
    return {
      content: [{ type: "text", text: JSON.stringify({ path: input.path, replacements: 1 }) }],
      structuredContent: { path: input.path, replacements: 1 },
    };
  },
);

server.registerTool(
  "workflow_bash",
  {
    description: "Run a shell command through the Workflow hub's contained execution (fail closed without the hub).",
    inputSchema: {
      cwd: z.string().min(1).refine(isAbsolute, "cwd must be absolute"),
      command: z.string().min(1),
    },
    outputSchema: { output: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async (input: { cwd: string; command: string }) => {
    const output = await runBash({ command: input.command, cwd: input.cwd });
    return {
      content: [{ type: "text", text: JSON.stringify({ output }) }],
      structuredContent: { output },
    };
  },
);

await server.connect(new StdioServerTransport());