import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { WorkflowApplication } from "../application/workflow.js";
import { evidenceId, observationId, taskId, type Evidence, type EvidenceAuthority, type TaskId } from "../kernel/contracts.js";
import { createWorkflowClinePlugin, type ClineBeforeToolHookInput } from "./cline-plugin.js";
import { adapterFor, shellExecutorFor, type WorkflowApplicationResolver, type WorkflowRunController } from "./run-controller.js";
import { createWorkflowHubBridge, type HubBridgeExtension, type WorkflowHubBridge } from "./hub-http.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";

/**
 * The vendored-Cline SDK's surface-specific hub routes, composed on top of the
 * host-neutral hub HTTP server (`hub-http.ts`): the `/before-tool` plugin seam,
 * the `/team-task` projection, and the `/bash` team-task binding. This module
 * is the SDK-specific remainder; it is removed with the vendored SDK (W050
 * step 6) — the hub keeps working through `hub-http.ts` alone.
 */
export type WorkflowClineTuiBridge = WorkflowHubBridge;

export async function createWorkflowClineTuiBridge(
  application: WorkflowApplication,
  resolveApplication: WorkflowApplicationResolver = (_workspace, _runId, options) => {
    if (options?.activateInteractiveTask ?? true) application.startInteractiveTask();
    return application;
  },
  runController?: WorkflowRunController,
  observeRequest?: (path: string) => void,
  teamTaskVerificationCommand?: string,
  guard?: WorkflowGuardProvider,
): Promise<WorkflowClineTuiBridge> {
  const extension = createClineHubExtension(resolveApplication, teamTaskVerificationCommand, guard);
  return createWorkflowHubBridge(application, resolveApplication, runController, observeRequest, guard, extension);
}

function createClineHubExtension(
  resolveApplication: WorkflowApplicationResolver,
  teamTaskVerificationCommand: string | undefined,
  guard: WorkflowGuardProvider | undefined,
): HubBridgeExtension {
  return {
    verifierOnlyPaths: ["/team-task/verify"],
    bashBinding: ({ application, body, resolveApplication: resolve }) => {
      const surfaceTaskId = typeof body.teamTaskId === "string" && body.teamTaskId.length > 0 ? body.teamTaskId : undefined;
      if (surfaceTaskId === undefined) return { application, taskId: undefined };
      const boundTaskId = clineTeamTaskId(application, surfaceTaskId);
      const task = application.snapshot().tasks.find(({ id }) => id === boundTaskId);
      if (task === undefined) throw new TypeError(`unknown Cline team task ${boundTaskId}`);
      if (task.state !== "IN_PROGRESS") {
        return {
          application: resolve(
            typeof body.workspace === "string" ? body.workspace : (body.cwd as string),
            undefined,
            { activateInteractiveTask: true },
          ),
          taskId: undefined,
        };
      }
      return { application, taskId: boundTaskId };
    },
    handle: async (request: IncomingMessage, response: ServerResponse, body: unknown) => {
      if (request.url === "/team-task") {
        if (!isRecord(body) || !isRecord(body.input) || !isRecord(body.result)) {
          send(response, 400, { error: "invalid team task request" });
          return true;
        }
        const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
        await syncClineTeamTask(
          resolveApplication(workspace, undefined, { activateInteractiveTask: false }),
          body.input,
          body.result,
          teamTaskVerificationCommand,
        );
        send(response, 200, {});
        return true;
      }
      if (request.url === "/team-task/verify") {
        if (!isRecord(body) || typeof body.taskId !== "string" || !isRecord(body.evidence)) {
          send(response, 400, { error: "invalid team task verification request" });
          return true;
        }
        const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
        verifyClineTeamTask(
          resolveApplication(workspace, undefined, { activateInteractiveTask: false }),
          body.taskId,
          requireEvidence(body.evidence),
        );
        send(response, 200, {});
        return true;
      }
      if (request.url === "/before-tool") {
        const { input, workspace, runId } = requireBeforeToolInput(body);
        const plugin = pluginFor(resolveApplication(workspace, runId), guard);
        send(response, 200, (await plugin.hooks.beforeTool(input)) ?? {});
        return true;
      }
      return false;
    },
  };
}

async function syncClineTeamTask(
  application: WorkflowApplication,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  verificationCommand?: string,
): Promise<void> {
  const action = input.action;
  if (action === "list") return;
  if (result.action !== action || typeof result.taskId !== "string" || result.taskId.length === 0) {
    throw new TypeError("invalid team task result");
  }
  if (action !== "create" && input.taskId !== result.taskId) throw new TypeError("team task input/result mismatch");
  const id = clineTeamTaskId(application, result.taskId);
  if (action === "create") {
    if (typeof input.title !== "string" || input.title.length === 0 || (result.status !== "pending" && result.status !== "in_progress")) {
      throw new TypeError("invalid team task create result");
    }
    const existing = application.snapshot().tasks.find((task) => task.id === id);
    if (existing !== undefined) {
      if (existing.title !== input.title) throw new TypeError(`conflicting Workflow task ${id}`);
      return;
    }
    application.addTask({
      id,
      title: input.title,
      dependencies: [],
      requiredEvidence: [{ authority: "environment", subject: id }],
    });
    if (result.status === "in_progress") {
      const transition = application.transition(id, "IN_PROGRESS");
      if (transition.kind !== "accepted") throw new TypeError(`cannot claim Workflow task ${id}: ${transition.reason}`);
    }
    return;
  }
  const current = application.snapshot().tasks.find((task) => task.id === id);
  if (current === undefined) throw new TypeError(`unknown Workflow task ${id}`);
  if (action === "claim" && result.status === "in_progress") {
    if (current.state !== "IN_PROGRESS") {
      const transition = application.transition(id, "IN_PROGRESS");
      if (transition.kind !== "accepted") throw new TypeError(`cannot claim Workflow task ${id}: ${transition.reason}`);
    }
    return;
  }
  if (action === "complete" && result.status === "completed") {
    if (current.state === "VERIFYING" || current.state === "VERIFIED") return;
    if (current.state === "READY") {
      const started = application.transition(id, "IN_PROGRESS");
      if (started.kind !== "accepted") throw new TypeError(`cannot start Workflow task ${id}: ${started.reason}`);
    }
    const transition = application.transition(id, "VERIFYING");
    if (transition.kind !== "accepted") throw new TypeError(`cannot complete Workflow task ${id}: ${transition.reason}`);
    // Completion only moves the task to VERIFYING. Promotion to VERIFIED is
    // reserved for Workflow-owned trusted verification: the configured
    // verification command below, or a verifier-token /team-task/verify call
    // whose evidence the kernel accepts (authority, subject, freshness, and
    // mutation epoch are all validated before the state may advance).
    if (verificationCommand !== undefined) await runTeamTaskVerification(application, id, verificationCommand);
    return;
  }
  if (action === "block" && result.status === "blocked") {
    if (current.state === "FAILED") return;
    if (current.state === "READY") {
      const started = application.transition(id, "IN_PROGRESS");
      if (started.kind !== "accepted") throw new TypeError(`cannot start Workflow task ${id}: ${started.reason}`);
    }
    const transition = application.transition(id, "FAILED");
    if (transition.kind !== "accepted") throw new TypeError(`cannot block Workflow task ${id}: ${transition.reason}`);
    return;
  }
  throw new TypeError("invalid team task update result");
}

async function runTeamTaskVerification(application: WorkflowApplication, id: TaskId, command: string): Promise<void> {
  if (command.trim().length === 0) throw new TypeError("team task verification command must not be empty");
  const cwd = application.workspaceRoot;
  if (cwd === undefined) throw new TypeError("team task verification requires a workspace");
  application.recordMutation([id]);
  let result: "passed" | "failed" = "passed";
  try {
    await shellExecutorFor(application, id, false)(command, cwd, undefined);
  } catch {
    result = "failed";
  }
  recordClineTeamTaskEnvironmentEvidence(application, id, {
    id: evidenceId(`command-evidence:${randomBytes(16).toString("hex")}`),
    observationId: observationId(`command-observation:${randomBytes(16).toString("hex")}`),
    result,
    mutationEpoch: application.snapshot().mutationEpoch,
    observedAt: new Date().toISOString(),
  });
}

function verifyClineTeamTask(application: WorkflowApplication, clineTaskId: string, evidence: Evidence): void {
  const id = clineTeamTaskId(application, clineTaskId);
  verifyClineTeamTaskEvidence(application, id, evidence);
}

export function recordClineTeamTaskEnvironmentEvidence(
  application: WorkflowApplication,
  id: TaskId,
  observation: Omit<Evidence, "authority" | "subject" | "freshness">,
): void {
  const evidence: Evidence = {
    ...observation,
    authority: "environment",
    subject: id,
    freshness: "fresh",
  };
  const current = application.snapshot().tasks.find((task) => task.id === id);
  if (current?.state !== "IN_PROGRESS" && current?.state !== "VERIFYING") {
    throw new TypeError(`cannot verify Workflow task ${id}: task is ${current?.state}`);
  }
  application.recordEvidence(evidence);
  if (current.state === "VERIFYING" && observation.result === "passed") {
    const transition = application.transition(id, "VERIFIED");
    if (transition.kind !== "accepted") throw new TypeError(`cannot verify Workflow task ${id}: ${transition.reason}`);
  }
}

function verifyClineTeamTaskEvidence(application: WorkflowApplication, id: TaskId, evidence: Evidence): void {
  const current = application.snapshot().tasks.find((task) => task.id === id);
  if (current === undefined) throw new TypeError(`unknown Workflow task ${id}`);
  if (evidence.authority !== "environment" || evidence.subject !== id) {
    throw new TypeError(`verification evidence must be environment evidence for ${id}`);
  }
  if (current.state === "VERIFIED") return;
  if (current.state !== "VERIFYING") throw new TypeError(`cannot verify Workflow task ${id}: task is ${current.state}`);
  application.recordEvidence(evidence);
  const transition = application.transition(id, "VERIFIED");
  if (transition.kind !== "accepted") throw new TypeError(`cannot verify Workflow task ${id}: ${transition.reason}`);
}

function clineTeamTaskId(application: WorkflowApplication, clineTaskId: string) {
  const workspace = application.workspaceRoot;
  return taskId(workspace === undefined
    ? `cline-team:${clineTaskId}`
    : `cline-team:${encodeURIComponent(workspace)}:${clineTaskId}`);
}

function requireEvidence(value: Record<string, unknown>): Evidence {
  if (
    typeof value.id !== "string" || typeof value.observationId !== "string" ||
    !isEvidenceAuthority(value.authority) || typeof value.subject !== "string" ||
    !(value.result === "passed" || value.result === "failed") ||
    !(value.freshness === "fresh" || value.freshness === "stale") ||
    typeof value.mutationEpoch !== "number" || !Number.isSafeInteger(value.mutationEpoch) || value.mutationEpoch < 0 ||
    typeof value.observedAt !== "string"
  ) throw new TypeError("invalid team task verification evidence");
  return {
    id: evidenceId(value.id),
    observationId: observationId(value.observationId),
    authority: value.authority,
    subject: value.subject,
    result: value.result,
    freshness: value.freshness,
    mutationEpoch: value.mutationEpoch,
    observedAt: value.observedAt,
  };
}

function isEvidenceAuthority(value: unknown): value is EvidenceAuthority {
  return value === "environment" || value === "host" || value === "mcp" || value === "reviewer";
}

function pluginFor(application: WorkflowApplication, guard?: WorkflowGuardProvider) {
  return createWorkflowClinePlugin(application, adapterFor(application), undefined, guard);
}

function requireBeforeToolInput(value: unknown): { input: ClineBeforeToolHookInput; workspace?: string; runId?: string } {
  if (!isRecord(value) || !isRecord(value.toolCall) || typeof value.toolCall.toolName !== "string") {
    throw new TypeError("invalid before-tool request");
  }
  return {
    input: {
      toolCall: {
        toolName: value.toolCall.toolName,
        ...(typeof value.toolCall.toolCallId === "string" ? { toolCallId: value.toolCall.toolCallId } : {}),
      },
      input: value.input,
    },
    ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
