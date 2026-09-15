#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { boundToolResultText } from "./vendor/result-bounds.js";
import { gateSkills, loadSkillsLevelMap, isSkillName, readSkillContent, scanSkills } from "./skills.js";

const skillsDir = resolve(process.env.SKILLS_MCP_DIR ?? resolve(homedir(), ".agents", "skills"));
const level = process.env.SKILLS_MCP_LEVEL === undefined || process.env.SKILLS_MCP_LEVEL.length === 0
  ? undefined
  : process.env.SKILLS_MCP_LEVEL;

const server = new McpServer(
  { name: "skills-mcp", version: "0.1.0" },
  { capabilities: { logging: {} } },
);

// Stream leveled MCP log notifications (and progress when the caller supplies
// a progressToken) for every tool call. See learning-mcp for the pattern.
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
    await server.server.sendLoggingMessage({ level: "debug", logger: "skills-mcp", data: { tool: name, phase: "start" } });
    await progress("start", 0);
    try {
      const result = await handler(input, extra);
      await server.server.sendLoggingMessage({ level: "info", logger: "skills-mcp", data: { tool: name, phase: "done" } });
      await progress("done", 2);
      // Plan Task E1: bound every tool result's model-visible text (48k
      // middle-cut parity) so any MCP host inherits the token economy.
      return boundToolResultText(result);
    } catch (error) {
      await server.server.sendLoggingMessage({ level: "error", logger: "skills-mcp", data: { tool: name, phase: "error", message: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }) as never)) as typeof server.registerTool;

const skillNameSchema = z.string().min(1).refine(isSkillName, "skill name must be a single path segment");

server.registerTool(
  "list_skills",
  {
    description: "List available skills (metadata only). Skill content is never returned here — it costs a read_skill call.",
    inputSchema: {},
    outputSchema: {
      skills: z.array(z.object({ name: z.string(), description: z.string() })),
      gating: z.enum(["off", "active", "closed"]),
      level: z.string().nullable(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const gated = gateSkills(scanSkills(skillsDir), loadSkillsLevelMap(skillsDir), level);
    const structuredContent = {
      skills: [...gated.skills],
      gating: gated.gating,
      level: gated.level === undefined ? null : gated.level,
    };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "read_skill",
  {
    description: "Read one skill's full content by name. This is the only delivery path for skill content.",
    inputSchema: { name: skillNameSchema },
    outputSchema: {
      name: z.string(),
      content: z.string(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (input: { name: string }) => {
    const content = readSkillContent(skillsDir, input.name);
    const structuredContent = { name: input.name, content };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());