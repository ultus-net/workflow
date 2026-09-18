import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { WorkflowApplication } from "../application/workflow.js";
import { buildReviewRubric } from "../review/rubric.js";
import type { TaskId } from "../kernel/contracts.js";
import { shellExecutorFor, type WorkflowApplicationResolver, type WorkflowRunController } from "./run-controller.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";

/**
 * The hub's host-neutral loopback HTTP server and discovery bridge.
 *
 * This owns the shared hub protocol routes (`/health`, `/snapshot`,
 * `/run/begin|review|finish`, `/review/rubric`, `/bash`). Surface-specific
 * routes (e.g. the vendored-Cline SDK's `/before-tool` / `/team-task`) are
 * supplied through `HubBridgeExtension` so this module never depends on a
 * concrete agent SDK. Extracted from `cline-tui-bridge.ts` (W050 step 6
 * prerequisite) so removing the vendored-Cline SDK does not remove the hub.
 */

export interface WorkflowHubBridge {
  readonly url: string;
  readonly token: string;
  readonly verificationToken: string;
  close(): Promise<void>;
}

/**
 * Optional surface-specific routes. The vendored-Cline SDK supplies these;
 * once it is removed the hub composes without an extension.
 */
export interface HubBridgeExtension {
  /** Handle a route the neutral protocol does not own; true when handled. */
  handle(request: IncomingMessage, response: ServerResponse, body: unknown): boolean | Promise<boolean>;
  /** Routes that require the verifier token (in addition to the run routes). */
  readonly verifierOnlyPaths?: readonly string[];
  /**
   * Bind a contained `/bash` request to the surface's own task namespace.
   * Returns the application (possibly re-resolved) and the bound task id.
   */
  bashBinding?(input: {
    readonly application: WorkflowApplication;
    readonly body: Record<string, unknown>;
    readonly resolveApplication: WorkflowApplicationResolver;
  }): { application: WorkflowApplication; taskId: TaskId | undefined };
}

interface HubRequestContext {
  readonly token: string;
  readonly verificationToken: string;
  readonly resolveApplication: WorkflowApplicationResolver;
  readonly runController: WorkflowRunController | undefined;
  readonly guard: WorkflowGuardProvider | undefined;
  readonly extension: HubBridgeExtension | undefined;
}

export async function createWorkflowHubBridge(
  application: WorkflowApplication,
  resolveApplication: WorkflowApplicationResolver = (_workspace, _runId, options) => {
    if (options?.activateInteractiveTask ?? true) application.startInteractiveTask();
    return application;
  },
  runController?: WorkflowRunController,
  observeRequest?: (path: string) => void,
  guard?: WorkflowGuardProvider,
  extension?: HubBridgeExtension,
): Promise<WorkflowHubBridge> {
  const token = randomBytes(32).toString("hex");
  const verificationToken = randomBytes(32).toString("hex");
  const context: HubRequestContext = { token, verificationToken, resolveApplication, runController, guard, extension };

  const server = createServer((request, response) => {
    if (request.url !== undefined) observeRequest?.(new URL(request.url, "http://127.0.0.1").pathname);
    void handleRequest(request, response, context);
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
    throw new Error("Workflow could not establish the hub authorization bridge");
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
  context: HubRequestContext,
): Promise<void> {
  try {
    if (request.method !== "POST") return send(response, 401, { error: "unauthorized" });
    const verifierOnly =
      request.url === "/run/review" ||
      request.url === "/run/finish" ||
      (request.url !== undefined && (context.extension?.verifierOnlyPaths?.includes(request.url) ?? false));
    const requiredToken = verifierOnly ? context.verificationToken : context.token;
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
      if (context.runController === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.runId !== "string" || typeof body.title !== "string") {
        return send(response, 400, { error: "invalid run begin request" });
      }
      await context.runController.begin({
        runId: body.runId,
        title: body.title,
        ...(typeof body.workspace === "string" ? { workspace: body.workspace } : {}),
        ...(body.requiresReview === true ? { requiresReview: true } : {}),
        ...(typeof body.taskPrompt === "string" ? { taskPrompt: body.taskPrompt } : {}),
      });
      return send(response, 200, {});
    }
    if (request.url === "/run/review") {
      if (context.runController === undefined) return send(response, 404, { error: "not found" });
      if (
        !isRecord(body) || typeof body.runId !== "string" || typeof body.reviewerRunId !== "string" ||
        !(body.verdict === "approved" || body.verdict === "changes_requested" || body.verdict === "rejected") ||
        typeof body.summary !== "string"
      ) {
        return send(response, 400, { error: "invalid run review request" });
      }
      const result = await context.runController.review({
        runId: body.runId, reviewerRunId: body.reviewerRunId, verdict: body.verdict, summary: body.summary,
      });
      return send(response, 200, result);
    }
    if (request.url === "/run/finish") {
      if (context.runController === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.runId !== "string" || !(body.outcome === "verified" || body.outcome === "failed")) {
        return send(response, 400, { error: "invalid run finish request" });
      }
      await context.runController.finish({ runId: body.runId, outcome: body.outcome });
      return send(response, 200, {});
    }
    if (request.url === "/snapshot") {
      if (!isRecord(body)) return send(response, 400, { error: "invalid snapshot request" });
      const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
      const snapshot = context.resolveApplication(workspace, undefined, { activateInteractiveTask: false }).snapshot();
      const hiddenTaskIds = new Set(context.runController?.hiddenSnapshotTaskIds() ?? []);
      // Plan Task A3: run-gate observability rides alongside the canonical
      // projection so hub-attached monitors can surface verdicts, blocking
      // reasons, and claims mismatches. Observability only.
      const gates = context.runController?.gateObservability?.();
      const gateObservability = gates === undefined ? undefined : {
        reviewOutcomes: Object.fromEntries(gates.reviewOutcomes),
        blockingReasons: Object.fromEntries(gates.blockingReasons),
        completionClaims: Object.fromEntries(gates.completionClaims),
        // W044 (open clause): per-run metering-proxy totals ride to
        // hub-attached monitors (observation only, like the other gates).
        ...(gates.runUsage === undefined ? {} : { usage: Object.fromEntries(gates.runUsage) }),
      };
      // Full WorkflowSnapshot shape so hub-attached monitors render the same
      // canonical projection as in-process surfaces.
      return send(response, 200, {
        snapshot: { ...snapshot, tasks: snapshot.tasks.filter((task) => !hiddenTaskIds.has(task.id)) },
        ...(gateObservability === undefined ? {} : { gateObservability }),
      });
    }
    if (request.url === "/bash") {
      if (!isRecord(body) || typeof body.cwd !== "string" || !(typeof body.command === "string" || isRecord(body.command))) {
        return send(response, 400, { error: "invalid bash request" });
      }
      const hasSurfaceTask = typeof body.teamTaskId === "string" && body.teamTaskId.length > 0;
      let application = context.resolveApplication(
        typeof body.workspace === "string" ? body.workspace : body.cwd,
        undefined,
        { activateInteractiveTask: !hasSurfaceTask },
      );
      let boundTaskId: TaskId | undefined;
      if (hasSurfaceTask && context.extension?.bashBinding !== undefined) {
        const bound = context.extension.bashBinding({ application, body, resolveApplication: context.resolveApplication });
        application = bound.application;
        boundTaskId = bound.taskId;
      }
      const shellExecutor = shellExecutorFor(application, boundTaskId, true, context.guard);
      return send(response, 200, { output: await shellExecutor(body.command as never, body.cwd, undefined) });
    }
    if (context.extension !== undefined && await context.extension.handle(request, response, body)) return;
    send(response, 404, { error: "not found" });
  } catch (error) {
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
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
    if (length > 1024 * 1024) throw new Error("Workflow hub request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
