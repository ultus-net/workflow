#!/usr/bin/env node
/**
 * `workflow-task-mcp` (W072 Stage 3): the canonical Workflow step ledger over
 * MCP. It is the host-agnostic retirement target for the native todo bridge:
 * rather than a host-specific `todowrite` shim, any MCP-capable host defines,
 * starts, completes, and cancels canonical steps through this server, which
 * drives the hub's ordinary-token `/steps/*` routes.
 *
 * THE LEDGER IS AUTHORITATIVE. A tool result reflects the hub's decision, not
 * a client-side assumption: `/steps/start|complete|cancel` answer 409 with the
 * kernel's own `StepTransitionResult` and this server surfaces it as a tool
 * error, never as a success. `/steps/complete` re-queries the real file
 * fingerprint on the hub side; this server never fabricates a change.
 *
 * ADVISORY READ, ENFORCED WRITE. The completion precondition is enforced by the
 * kernel via the hub; this server cannot loosen it. It only publishes the
 * ledger. Nothing here mints evidence, grants capabilities, or mutates state
 * outside the hub's authorized routes.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { boundToolResultText } from "./vendor/result-bounds.js";
import { callStepRoute, type StepRoute } from "./hub-client.js";

const server = new McpServer(
  { name: "workflow-task-mcp", version: "0.1.0" },
  { capabilities: { logging: {} } },
);

// Stream leveled MCP log notifications (and progress when the caller supplies a
// progressToken) for every tool call. See learning-mcp for the pattern. A tool
// refusal is THROWN (the SDK converts it to `isError`), so a declared
// outputSchema is only ever validated against a real hub success.
type ToolExtra = {
  _meta?: { progressToken?: string | number };
  signal?: AbortSignal;
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
    await server.server.sendLoggingMessage({ level: "debug", logger: "workflow-task-mcp", data: { tool: name, phase: "start" } });
    await progress("start", 0);
    try {
      const result = await handler(input, extra);
      await server.server.sendLoggingMessage({ level: "info", logger: "workflow-task-mcp", data: { tool: name, phase: "done" } });
      await progress("done", 2);
      return boundToolResultText(result);
    } catch (error) {
      await server.server.sendLoggingMessage({
        level: "error",
        logger: "workflow-task-mcp",
        data: { tool: name, phase: "error", message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }) as never)) as typeof server.registerTool;

// ── Wire shapes (the hub's `/steps/*` projections, mirrored structurally) ──
const evidenceAuthority = z.enum(["environment", "host", "mcp", "reviewer"]);
const stepProjection = z.object({
  id: z.string(),
  taskId: z.string(),
  content: z.string(),
  state: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
  requiredEvidence: z.array(z.object({ authority: evidenceAuthority, subject: z.string() })),
  requiredPostcondition: z.object({ subjects: z.array(z.object({ path: z.string(), expectedFingerprint: z.string() })) }).optional(),
});
const stepTransition = z.union([
  z.object({ kind: z.literal("accepted"), step: stepProjection }),
  z.object({ kind: z.literal("rejected"), code: z.string(), reason: z.string() }),
]);

/** `workspace` is optional; the hub resolves the default application when absent. */
function withWorkspace(input: { readonly workspace?: string | undefined }): Record<string, unknown> {
  return input.workspace === undefined ? {} : { workspace: input.workspace };
}

async function drive(route: StepRoute, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const { body } = await callStepRoute(route, payload, signal === undefined ? {} : { signal });
  return body;
}

server.registerTool(
  "step_list",
  {
    description:
      "Proactively call when deciding what canonical step to work on next. Lists the task's step ledger in order; the ledger is the authority on what should happen, not the host's local todo list.",
    inputSchema: { taskId: z.string().min(1).max(4096), workspace: z.string().min(1).max(4096).optional() },
    outputSchema: { steps: z.array(stepProjection) },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (input, extra) => {
    const body = (await drive("list", { taskId: input.taskId, ...withWorkspace(input) }, extra.signal)) as { steps?: unknown };
    const structuredContent = { steps: body.steps ?? [] };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "step_define",
  {
    description:
      "Define/replace the canonical ordered step ledger for a task. Every step must declare its done-condition (requiredEvidence, and optionally a requiredPostcondition re-queried at completion). The kernel enforces I-2 (no silent deletion of an active step) and fails the whole define when a proposal is malformed — the prior ledger is preserved.",
    inputSchema: {
      taskId: z.string().min(1).max(4096),
      steps: z.array(z.object({
        id: z.string().min(1).max(4096).optional(),
        content: z.string().min(1).max(8192),
        requiredEvidence: z.array(z.object({ authority: evidenceAuthority, subject: z.string().min(1).max(4096) })).optional(),
        requiredPostcondition: z.object({ subjects: z.array(z.object({ path: z.string().min(1).max(4096), expectedFingerprint: z.string().min(1).max(4096) })) }).optional(),
      })).max(200),
      workspace: z.string().min(1).max(4096).optional(),
    },
    outputSchema: { steps: z.array(stepProjection) },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
  },
  async (input, extra) => {
    const body = (await drive("define", { taskId: input.taskId, steps: input.steps, ...withWorkspace(input) }, extra.signal)) as { steps?: unknown };
    const structuredContent = { steps: body.steps ?? [] };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

/** Registers one single-step transition route (`start`/`complete`/`cancel`). */
function registerTransition(route: Extract<StepRoute, "start" | "complete" | "cancel">, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: { id: z.string().min(1).max(4096), workspace: z.string().min(1).max(4096).optional() },
      outputSchema: { transition: stepTransition },
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, extra) => {
      const transition = await drive(route, { id: input.id, ...withWorkspace(input) }, extra.signal);
      const structuredContent = { transition };
      return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
    },
  );
}

registerTransition(
  "start",
  "step_start",
  "Start the single active canonical step (I-8: at most one step is IN_PROGRESS). Starting a step that is not PENDING, or while another step is active, is the kernel's decision and is surfaced as a refusal.",
);
registerTransition(
  "complete",
  "step_complete",
  "Complete a step. The hub re-queries the real file fingerprint for every claimed subject before the kernel admits the completion; a step whose required evidence is missing/stale, or whose claimed change did not actually re-appear, is refused with the kernel's own code — never accepted on the caller's word.",
);
registerTransition(
  "cancel",
  "step_cancel",
  "Cancel a step (PENDING or IN_PROGRESS -> CANCELLED). Cancelling preserves the ledger entry; steps are never deleted from history.",
);

await server.connect(new StdioServerTransport());
