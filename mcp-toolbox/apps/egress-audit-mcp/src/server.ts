#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { boundToolResultText } from "./vendor/result-bounds.js";
import {
  defaultDataRoot,
  EGRESS_ANOMALY_FLAGS,
  EGRESS_TOKEN_CLASSES,
  EgressAuditLedger,
  SUGGESTED_FUNCTION_CLASSES,
} from "./egress-ledger.js";

const server = new McpServer(
  { name: "egress-audit-mcp", version: "0.1.0" },
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
    await server.server.sendLoggingMessage({ level: "debug", logger: "egress-audit-mcp", data: { tool: name, phase: "start" } });
    await progress("start", 0);
    try {
      const result = await handler(input, extra);
      await server.server.sendLoggingMessage({ level: "info", logger: "egress-audit-mcp", data: { tool: name, phase: "done" } });
      await progress("done", 2);
      return boundToolResultText(result);
    } catch (error) {
      await server.server.sendLoggingMessage({ level: "error", logger: "egress-audit-mcp", data: { tool: name, phase: "error", message: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }) as never)) as typeof server.registerTool;

const ledger = new EgressAuditLedger(defaultDataRoot());
const tokenClass = z.enum(EGRESS_TOKEN_CLASSES);
const anomaly = z.enum(EGRESS_ANOMALY_FLAGS);
const reach = z.object({
  id: z.string(), domain: z.string(), functionClass: z.string(), tokenClass,
  source: z.string(), observedAt: z.number(), recordedAt: z.number(), anomalies: z.array(anomaly),
});

server.registerTool(
  "append_egress_reach",
  {
    description:
      `Record one observed egress reach: a destination domain, the function class reached on it, and the token class that carried it. ` +
      `The ledger is append-only and bounded; it records evidence and never enforces egress policy. ` +
      `Suggested function classes: ${SUGGESTED_FUNCTION_CLASSES.join(", ")} (a new class is exactly what the anomaly flag surfaces).`,
    inputSchema: {
      domain: z.string().min(1).max(253),
      functionClass: z.string().min(1).max(120),
      tokenClass,
      source: z.string().min(1).max(120).default("unspecified"),
      observedAt: z.number().int().nonnegative().optional(),
    },
    outputSchema: { reach },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (input, extra) => {
    const record = await ledger.append(input, extra.signal);
    const structuredContent = { reach: record };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "query_egress_reaches",
  {
    description:
      "Read recorded egress reaches, newest first, bounded by limit. Results are advisory evidence about what was reported, not a complete or authoritative egress record.",
    inputSchema: {
      domain: z.string().min(1).max(253).optional(),
      functionClass: z.string().min(1).max(120).optional(),
      flaggedOnly: z.boolean().optional(),
      since: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(200).default(50),
    },
    outputSchema: { reaches: z.array(reach), truncated: z.boolean() },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (input, extra) => {
    const result = await ledger.query(input, extra.signal);
    const structuredContent = { reaches: result.reaches, truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "summarize_egress",
  {
    description:
      "Summarize the bounded ledger: entry count, top destination domains, function classes, token classes, and anomaly counts. Advisory evidence, never enforcement.",
    inputSchema: {},
    outputSchema: {
      entries: z.number(),
      byDomain: z.array(z.object({ key: z.string(), count: z.number() })),
      byFunctionClass: z.array(z.object({ key: z.string(), count: z.number() })),
      byTokenClass: z.array(z.object({ key: z.string(), count: z.number() })),
      anomalies: z.array(z.object({ flag: anomaly, count: z.number() })),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (_input, extra) => {
    const structuredContent = { ...(await ledger.summarize(extra.signal)) };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());