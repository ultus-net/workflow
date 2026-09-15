#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { boundToolResultText } from "./vendor/result-bounds.js";
import { screenSkillContent } from "./screening.js";
import {
  gateSkills,
  loadSkillsLevelMap,
  isSkillName,
  readSkillContent,
  scanSkills,
  skillReadableAt,
  type SkillMeta,
} from "./skills.js";

const skillsDir = resolve(process.env.SKILLS_MCP_DIR ?? resolve(homedir(), ".agents", "skills"));
const level = process.env.SKILLS_MCP_LEVEL === undefined || process.env.SKILLS_MCP_LEVEL.length === 0
  ? undefined
  : process.env.SKILLS_MCP_LEVEL;
// Operator trust decision: screening is heuristic and can false-positive on
// security-guidance skills that quote attack patterns defensively. An
// operator who curates their own skills directory may disable it.
const screeningEnabled = process.env.SKILLS_MCP_SCREENING !== "off";

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
    description: "List available skills (metadata only). Skill content is never returned here — it costs a read_skill call. Screened (malicious-shaped) skills are quarantined and surfaced with their findings.",
    inputSchema: {},
    outputSchema: {
      skills: z.array(z.object({ name: z.string(), description: z.string() })),
      quarantined: z.array(z.object({ name: z.string(), findings: z.array(z.string()) })),
      gating: z.enum(["off", "active", "closed"]),
      level: z.string().nullable(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    // Operator safety check: web-fetched or manually loaded skills are
    // untrusted input. Screened skills are quarantined — excluded from
    // discovery and refused at delivery — with findings surfaced.
    const scanned = scanSkills(skillsDir);
    const clean: SkillMeta[] = [];
    const quarantined: { name: string; findings: string[] }[] = [];
    for (const skill of scanned) {
      if (screeningEnabled) {
        const screening = screenSkillContent(readSkillContent(skillsDir, skill.name));
        if (screening.verdict === "flagged") {
          quarantined.push({ name: skill.name, findings: [...screening.findings] });
          continue;
        }
      }
      clean.push(skill);
    }
    const gated = gateSkills(clean, loadSkillsLevelMap(skillsDir), level);
    const structuredContent = {
      skills: [...gated.skills],
      quarantined,
      gating: gated.gating,
      level: gated.level === undefined ? null : gated.level,
    };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "read_skill",
  {
    description: "Read one skill's full content by name. This is the only delivery path for skill content. Quarantined (malicious-shaped) or level-locked skills are refused.",
    inputSchema: { name: skillNameSchema },
    outputSchema: {
      name: z.string(),
      content: z.string(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (input: { name: string }) => {
    // Level enforcement happens at read time too: list gating alone would
    // let a learner read a locked skill by guessing its name.
    const readable = skillReadableAt(loadSkillsLevelMap(skillsDir), level, input.name);
    if (!readable.allowed) throw new Error(readable.reason ?? `skill '${input.name}' is not readable`);
    // Re-screen at delivery time: the file may have changed since discovery.
    const content = readSkillContent(skillsDir, input.name);
    if (screeningEnabled) {
      const screening = screenSkillContent(content);
      if (screening.verdict === "flagged") {
        throw new Error(`skill '${input.name}' is quarantined by safety screening: ${screening.findings.join("; ")}`);
      }
    }
    const structuredContent = { name: input.name, content };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());