import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ClineHostAdapter } from "../adapters/cline.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { WorkflowContainedProcess } from "../containment/workflow-process.js";
import { selectContainment } from "../containment/platform.js";
import { buildReviewRubric } from "../review/rubric.js";
import { evidenceId, observationId, taskId, type Evidence, type EvidenceAuthority, type TaskId } from "../kernel/contracts.js";
import { createWorkflowClinePlugin, type ClineBeforeToolHookInput } from "./cline-plugin.js";
import { createWorkflowClineShellExecutor, type WorkflowClineShellExecutor } from "./cline-shell-executor.js";

export interface WorkflowClineTuiBridge {
  readonly url: string;
  readonly token: string;
  readonly verificationToken: string;
  close(): Promise<void>;
}

export type WorkflowApplicationResolver = (
  workspace?: string,
  runId?: string,
  options?: { activateInteractiveTask?: boolean },
) => WorkflowApplication;

export interface WorkflowRunController {
  begin(input: { runId: string; title: string; workspace?: string; requiresReview?: boolean }): Promise<void>;
  finish(input: { runId: string; outcome: "verified" | "failed" }): Promise<void>;
  review(input: { runId: string; reviewerRunId: string; verdict: "approved" | "changes_requested" | "rejected"; summary: string }): Promise<{ recorded: boolean }>;
  hiddenSnapshotTaskIds(): readonly string[];
}

export async function createWorkflowClineTuiBridge(
  application: WorkflowApplication,
  resolveApplication: WorkflowApplicationResolver = (_workspace, _runId, options) => {
    if (options?.activateInteractiveTask ?? true) application.startInteractiveTask();
    return application;
  },
  runController?: WorkflowRunController,
  observeRequest?: (path: string) => void,
  teamTaskVerificationCommand?: string,
): Promise<WorkflowClineTuiBridge> {
  const token = randomBytes(32).toString("hex");
  const verificationToken = randomBytes(32).toString("hex");

  const server = createServer((request, response) => {
    if (request.url !== undefined) observeRequest?.(new URL(request.url, "http://127.0.0.1").pathname);
    void handleRequest(request, response, token, verificationToken, resolveApplication, runController, teamTaskVerificationCommand);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Workflow could not establish the Cline authorization bridge");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    verificationToken,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  verificationToken: string,
  resolveApplication: WorkflowApplicationResolver,
  runController?: WorkflowRunController,
  teamTaskVerificationCommand?: string,
): Promise<void> {
  try {
    if (request.method !== "POST") return send(response, 401, { error: "unauthorized" });
    const verifierOnly = request.url === "/team-task/verify" || request.url === "/run/review" || request.url === "/run/finish";
    const requiredToken = verifierOnly ? verificationToken : token;
    if (!authorized(request, requiredToken)) return send(response, 401, { error: "unauthorized" });
    if (request.url === "/health") return send(response, 200, { status: "ok" });
    const body = await readJson(request);
    if (request.url === "/review/rubric") {
      if (!isRecord(body) || typeof body.diffText !== "string") {
        return send(response, 400, { error: "invalid review rubric request" });
      }
      return send(response, 200, {
        rubric: buildReviewRubric({
          diffText: body.diffText,
          ...(typeof body.taskPrompt === "string" ? { taskPrompt: body.taskPrompt } : {}),
        }),
      });
    }
    if (request.url === "/run/begin") {
      if (runController === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.runId !== "string" || typeof body.title !== "string") {
        return send(response, 400, { error: "invalid run begin request" });
      }
      await runController.begin({
        runId: body.runId,
        title: body.title,
        ...(typeof body.workspace === "string" ? { workspace: body.workspace } : {}),
        ...(body.requiresReview === true ? { requiresReview: true } : {}),
      });
      return send(response, 200, {});
    }
    if (request.url === "/run/review") {
      if (runController === undefined) return send(response, 404, { error: "not found" });
      if (
        !isRecord(body) || typeof body.runId !== "string" || typeof body.reviewerRunId !== "string" ||
        !(body.verdict === "approved" || body.verdict === "changes_requested" || body.verdict === "rejected") ||
        typeof body.summary !== "string"
      ) {
        return send(response, 400, { error: "invalid run review request" });
      }
      const result = await runController.review({
        runId: body.runId, reviewerRunId: body.reviewerRunId, verdict: body.verdict, summary: body.summary,
      });
      return send(response, 200, result);
    }
    if (request.url === "/run/finish") {
      if (runController === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.runId !== "string" || !(body.outcome === "verified" || body.outcome === "failed")) {
        return send(response, 400, { error: "invalid run finish request" });
      }
      await runController.finish({ runId: body.runId, outcome: body.outcome });
      return send(response, 200, {});
    }
    if (request.url === "/snapshot") {
      if (!isRecord(body)) return send(response, 400, { error: "invalid snapshot request" });
      const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
      const snapshot = resolveApplication(workspace, undefined, { activateInteractiveTask: false }).snapshot();
      const hiddenTaskIds = new Set(runController?.hiddenSnapshotTaskIds() ?? []);
      return send(response, 200, { snapshot: { tasks: snapshot.tasks.filter((task) => !hiddenTaskIds.has(task.id)) } });
    }
    if (request.url === "/team-task") {
      if (!isRecord(body) || !isRecord(body.input) || !isRecord(body.result)) {
        return send(response, 400, { error: "invalid team task request" });
      }
      const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
      await syncClineTeamTask(
        resolveApplication(workspace, undefined, { activateInteractiveTask: false }),
        body.input,
        body.result,
        teamTaskVerificationCommand,
      );
      return send(response, 200, {});
    }
    if (request.url === "/team-task/verify") {
      if (!isRecord(body) || typeof body.taskId !== "string" || !isRecord(body.evidence)) {
        return send(response, 400, { error: "invalid team task verification request" });
      }
      const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
      verifyClineTeamTask(
        resolveApplication(workspace, undefined, { activateInteractiveTask: false }),
        body.taskId,
        requireEvidence(body.evidence),
      );
      return send(response, 200, {});
    }
    if (request.url === "/before-tool") {
      const { input, workspace, runId } = requireBeforeToolInput(body);
      const plugin = pluginFor(resolveApplication(workspace, runId));
      return send(response, 200, (await plugin.hooks.beforeTool(input)) ?? {});
    }
    if (request.url === "/bash") {
      if (!isRecord(body) || typeof body.cwd !== "string" || !(typeof body.command === "string" || isRecord(body.command))) {
        return send(response, 400, { error: "invalid bash request" });
      }
      const clineTaskId = typeof body.teamTaskId === "string" && body.teamTaskId.length > 0 ? body.teamTaskId : undefined;
      let application = resolveApplication(
        typeof body.workspace === "string" ? body.workspace : body.cwd,
        undefined,
        { activateInteractiveTask: clineTaskId === undefined },
      );
      let boundTaskId: TaskId | undefined;
      if (clineTaskId !== undefined) {
        boundTaskId = clineTeamTaskId(application, clineTaskId);
        const task = application.snapshot().tasks.find(({ id }) => id === boundTaskId);
        if (task === undefined) throw new TypeError(`unknown Cline team task ${boundTaskId}`);
        if (task.state !== "IN_PROGRESS") {
          application = resolveApplication(
            typeof body.workspace === "string" ? body.workspace : body.cwd,
            undefined,
            { activateInteractiveTask: true },
          );
          boundTaskId = undefined;
        }
      }
      const shellExecutor = shellExecutorFor(application, boundTaskId);
      return send(response, 200, { output: await shellExecutor(body.command as never, body.cwd, undefined) });
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
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
    application.transition(id, "VERIFIED");
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

function adapterFor(application: WorkflowApplication, fixedTaskId?: TaskId): ClineHostAdapter {
  return new ClineHostAdapter({
    sessionId: "workflow-tui",
    taskId: () => fixedTaskId ?? application.activeTaskId(),
    isMutatingTool: () => false,
    authoritativePreMutation: true,
  });
}

function pluginFor(application: WorkflowApplication) {
  return createWorkflowClinePlugin(application, adapterFor(application));
}

function shellExecutorFor(application: WorkflowApplication, fixedTaskId?: TaskId, writableWorkspace = true): WorkflowClineShellExecutor {
  return createWorkflowClineShellExecutor(
    new WorkflowContainedProcess(application, selectContainment()),
    adapterFor(application, fixedTaskId),
    (exitCode, output) => Object.assign(new Error(output), { exitCode }),
    undefined,
    writableWorkspace,
  );
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1024 * 1024) throw new Error("Workflow Cline bridge request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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
