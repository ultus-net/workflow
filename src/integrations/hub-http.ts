import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { WorkflowApplication } from "../application/workflow.js";
import { buildReviewRubric } from "../review/rubric.js";
import { WorkspaceDeclarationError } from "./run-registry.js";
import { shellExecutorFor, type WorkflowApplicationResolver, type WorkflowRunController } from "./run-controller.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import type { SelfImprovementRegistry, SelfImprovementSpec } from "./self-improvement-registry.js";
import type { ScheduleRegistry } from "./schedule-registry.js";
import { activityTimeline } from "./activity-timeline.js";
import { operatorPosture, scheduleLineage, scheduleRecentRuns } from "./operator-posture.js";

/**
 * The hub's host-neutral loopback HTTP server and discovery bridge.
 *
 * This owns the shared hub protocol routes (`/health`, `/snapshot`,
 * `/run/begin|review|finish`, `/review/rubric`, `/bash`). It was extracted
 * from `cline-tui-bridge.ts` (W050 step 6 prerequisite) so removing the
 * vendored-Cline SDK did not remove the hub; the surface-specific
 * `HubBridgeExtension` seam was removed with the SDK once no producer
 * remained.
 */

export interface WorkflowHubBridge {
  readonly url: string;
  readonly token: string;
  readonly verificationToken: string;
  close(): Promise<void>;
}

interface HubRequestContext {
  readonly token: string;
  readonly verificationToken: string;
  readonly resolveApplication: WorkflowApplicationResolver;
  readonly runController: WorkflowRunController | undefined;
  readonly guard: WorkflowGuardProvider | undefined;
  readonly selfImprovement: SelfImprovementRegistry | undefined;
  readonly schedules: ScheduleRegistry | undefined;
  /** W158: the bounded content store behind the evidence content references; absent → the read route 404s. */
  readonly contentStore?: {
    get(ref: string): { readonly kind: "test-output" | "screenshot"; readonly mediaType: string; readonly bytes: string; readonly byteSize: number } | undefined;
  };
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
  selfImprovement?: SelfImprovementRegistry,
  schedules?: ScheduleRegistry,
  contentStore?: HubRequestContext["contentStore"],
): Promise<WorkflowHubBridge> {
  const token = randomBytes(32).toString("hex");
  const verificationToken = randomBytes(32).toString("hex");
  const context: HubRequestContext = { token, verificationToken, resolveApplication, runController, guard, selfImprovement, schedules, ...(contentStore === undefined ? {} : { contentStore }) };

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
    // P1-1 (adversarial review): starting a self-improvement loop and firing a
    // scheduled run now are consequential autonomous actions. They require the
    // verifier credential (distributed separately from the ordinary surface
    // token in `verifier.json`), the same trust model as /run/finish — the
    // ordinary token's blast radius (which any same-UID surface holds) must
    // not include switching on an autonomous mutation loop.
    const verifierOnly =
      request.url === "/run/review" ||
      request.url === "/run/finish" ||
      request.url === "/rsi/start" ||
      request.url === "/schedule/run-now";
    const requiredToken = verifierOnly ? context.verificationToken : context.token;
    if (!authorized(request, requiredToken)) return send(response, 401, { error: "unauthorized" });
    if (request.url === "/health") return send(response, 200, { status: "ok" });
    const body = await readJson(request);
    if (request.url === "/evidence-content") {
      // W158: the bounded content behind an evidence record's reference — the
      // operator token serves it (the same read class as /snapshot); an
      // absent store or an unknown/evicted ref answers honestly.
      if (context.contentStore === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.ref !== "string" || body.ref.length === 0) {
        return send(response, 400, { error: "invalid evidence-content request" });
      }
      const stored = context.contentStore.get(body.ref);
      if (stored === undefined) return send(response, 404, { error: "not found" });
      return send(response, 200, { kind: stored.kind, mediaType: stored.mediaType, bytes: stored.bytes, byteSize: stored.byteSize });
    }
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
      // W146: the registry's workspace-declaration refusal is a CLIENT
      // fault — WorkspaceDeclarationError from canonicalWorkspace (reached
      // through resolveApplication) answers 400 with its message. The
      // refusal still precedes any composition: nothing composes, no run
      // task is created. Empty runId and duplicate runId keep the
      // catch-all's 500 (still queued under the W142 wave's finding (e)).
      try {
        await context.runController.begin({
          runId: body.runId,
          title: body.title,
          ...(typeof body.workspace === "string" ? { workspace: body.workspace } : {}),
          ...(body.requiresReview === true ? { requiresReview: true } : {}),
          ...(typeof body.taskPrompt === "string" ? { taskPrompt: body.taskPrompt } : {}),
        });
      } catch (error) {
        if (error instanceof WorkspaceDeclarationError) {
          return send(response, 400, { error: error.message });
        }
        throw error;
      }
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
    if (request.url === "/rsi/start") {
      if (context.selfImprovement === undefined) return send(response, 404, { error: "not found" });
      if (
        !isRecord(body) || typeof body.workspace !== "string" ||
        typeof body.objective !== "string" || typeof body.maxIterations !== "number"
      ) {
        return send(response, 400, { error: "invalid self-improvement start request" });
      }
      const spec: SelfImprovementSpec = {
        workspace: body.workspace,
        objective: body.objective,
        maxIterations: body.maxIterations,
        // P0-2 (adversarial review): the review gate is ON by default. A plain
        // run verifies with no evidence requirements at all, so an unspecified
        // flag must never produce an evidence-free acceptance path — opting out
        // is an explicit `requiresReview: false`.
        ...(body.requiresReview === false ? { requiresReview: false } : { requiresReview: true }),
        ...(typeof body.maxConsecutiveRejections === "number" ? { maxConsecutiveRejections: body.maxConsecutiveRejections } : {}),
        ...(typeof body.budgetUsd === "number" ? { budgetUsd: body.budgetUsd } : {}),
        ...(body.direction === "higher" || body.direction === "lower" ? { direction: body.direction } : {}),
        ...(typeof body.baselineScore === "number" ? { baselineScore: body.baselineScore } : {}),
      };
      try {
        return send(response, 200, { loop: context.selfImprovement.start(spec) });
      } catch (error) {
        // Invalid spec or a duplicate running loop: a client error, not a
        // server fault, and never a silently queued second loop.
        return send(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (request.url === "/rsi/status") {
      if (context.selfImprovement === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body)) return send(response, 400, { error: "invalid self-improvement status request" });
      if (typeof body.id === "string" && body.id.length > 0) {
        return send(response, 200, { loop: context.selfImprovement.get(body.id) ?? null });
      }
      return send(response, 200, { loops: context.selfImprovement.status() });
    }
    if (request.url === "/rsi/cancel") {
      if (context.selfImprovement === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body)) return send(response, 400, { error: "invalid self-improvement cancel request" });
      const cancelled = context.selfImprovement.cancel({
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        ...(typeof body.workspace === "string" ? { workspace: body.workspace } : {}),
      });
      return send(response, 200, { cancelled });
    }
    if (request.url === "/schedule/list") {
      if (context.schedules === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body)) return send(response, 400, { error: "invalid schedule list request" });
      // W153 (the view slice): the lineage rides the list — computed by the
      // shared projection from the kernel's run states and the registry
      // definitions, never from timestamps, and never by the view. The
      // recent-runs rows answer "did my schedules fire while I was away?".
      const schedules = context.schedules.list();
      const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
      const lineageSnapshot = context.resolveApplication(workspace, undefined, { activateInteractiveTask: false }).snapshot();
      const runTasks = lineageSnapshot.tasks
        .filter((task) => task.id.startsWith("run:"))
        .map((task) => ({ runId: task.id.slice("run:".length), title: task.title, state: task.state }));
      const lineage = scheduleLineage({
        schedules: schedules.map((schedule) => ({ id: schedule.id, title: schedule.title })),
        runTasks,
      });
      const recentRuns = scheduleRecentRuns({
        schedules: schedules.map((schedule) => ({ id: schedule.id, title: schedule.title })),
        runTasks,
      });
      return send(response, 200, {
        schedules: schedules.map((entry) => ({
          ...entry,
          lineage: lineage.find((row) => row.scheduleId === entry.id) ?? null,
        })),
        recentRuns,
      });
    }
    if (request.url === "/schedule/save") {
      if (context.schedules === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.id !== "string" || typeof body.title !== "string" || typeof body.cron !== "string" || typeof body.prompt !== "string") {
        return send(response, 400, { error: "invalid schedule save request" });
      }
      try {
        const schedules = context.schedules.save(body as unknown as import("./hub-scheduler.js").ScheduleDefinition);
        return send(response, 200, { schedules });
      } catch (error) {
        // Validation or persistence failure: a client error when the shape is
        // bad, but never a partially-admitted in-memory schedule.
        return send(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (request.url === "/schedule/delete") {
      if (context.schedules === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.id !== "string" || body.id.length === 0) {
        return send(response, 400, { error: "invalid schedule delete request" });
      }
      return send(response, 200, { schedules: context.schedules.remove(body.id) });
    }
    if (request.url === "/schedule/run-now") {
      if (context.schedules === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.id !== "string" || body.id.length === 0) {
        return send(response, 400, { error: "invalid schedule run-now request" });
      }
      return send(response, 200, { fired: await context.schedules.runNow(body.id) });
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
        // W153: recorded schedule-origin attribution per run (observability).
        ...(gates.runOrigins === undefined ? {} : { runOrigins: Object.fromEntries(gates.runOrigins) }),
        // Iteration 21: advisory reasoning-claim findings (observation only).
        ...(gates.reasoningClaims === undefined ? {} : { reasoningClaims: Object.fromEntries(gates.reasoningClaims) }),
        ...(gates.reasoningClaimMetrics === undefined ? {} : { reasoningClaimMetrics: gates.reasoningClaimMetrics }),
        // W044 (open clause): per-run metering-proxy totals ride to
        // hub-attached monitors (observation only, like the other gates).
        ...(gates.runUsage === undefined ? {} : { usage: Object.fromEntries(gates.runUsage) }),
      };
      // Full WorkflowSnapshot shape so hub-attached monitors render the same
      // canonical projection as in-process surfaces.
      // W150: the operator posture strip + decision inbox ride the same
      // snapshot response — computed ONLY from registry/kernel state by the
      // shared projection function. The projection sees RAW run ids (the
      // kernel snapshot's `run:` prefix is stripped here — the projection's
      // id contract matches the registry's raw-keyed observability maps).
      // NOTE: the posture intentionally reads the UNFILTERED task list —
      // finished schedule runs are hidden from the payload (the reviewer-run
      // hiding) but their FAILED states are exactly what the failed-schedule
      // count needs. Absent registries (per-session budget state, orphan
      // detection) degrade with NAMED absences and null counts — never
      // fabricated zeros.
      const posture = operatorPosture({
        runTasks: snapshot.tasks
          .filter((task) => task.id.startsWith("run:"))
          .map((task) => ({ runId: task.id.slice("run:".length), title: task.title, state: task.state })),
        ...(gates === undefined ? {} : {
          reviewOutcomes: gates.reviewOutcomes,
          blockingReasons: gates.blockingReasons,
        }),
        ...(context.schedules === undefined ? {} : { schedules: context.schedules.list().map((schedule) => ({ id: schedule.id, title: schedule.title })) }),
      });
      // W152: the unified activity timeline rides the same snapshot response —
      // the projection over the kernel's transition log and the registry's
      // gate records. Kernel transition rows are unattributed BY CONTRACT
      // (the kernel records no actor/authority; W157 is the record change
      // that would add it); the timeline's kernel segment is the fallback
      // application's own log plus each recent run's log (bounded 64), never
      // a fabricated union of things the kernel did not record.
      const timeline = activityTimeline({
        transitions: [
          ...snapshot.history,
          ...(gates === undefined
            ? []
            : [...(gates.transitionLogs ?? new Map()).values()].flat()),
        ],
        tasks: snapshot.tasks.map((task) => ({ id: task.id, title: task.title })),
        ...(gates === undefined
          ? {}
          : {
            reviewOutcomes: gates.reviewOutcomes,
            blockingReasons: gates.blockingReasons,
            completionClaims: gates.completionClaims,
            runUsage: gates.runUsage,
            runOrigins: gates.runOrigins,
          }),
        ...(context.schedules === undefined ? {} : { schedules: context.schedules.list().map((schedule) => ({ id: schedule.id, title: schedule.title })) }),
      });
      return send(response, 200, {
        snapshot: { ...snapshot, tasks: snapshot.tasks.filter((task) => !hiddenTaskIds.has(task.id)) },
        ...(gateObservability === undefined ? {} : { gateObservability }),
        posture,
        timeline,
      });
    }
    if (request.url === "/bash") {
      if (!isRecord(body)) return send(response, 400, { error: "invalid bash request" });
      const command = body.command;
      // W145: the client-shaped command faults classify 400 at the route —
      // an empty string command or an empty/invalid structured command used
      // to pass this check and die in the executor as a 500 (the W142 wave's
      // finding (b)).
      const commandValid =
        (typeof command === "string" && command.length > 0) ||
        (isRecord(command) &&
          typeof command.command === "string" &&
          command.command.length > 0 &&
          (command.args === undefined ||
            (Array.isArray(command.args) && command.args.every((argument) => typeof argument === "string"))));
      if (typeof body.cwd !== "string" || !commandValid) {
        return send(response, 400, { error: "invalid bash request" });
      }
      const hasSurfaceTask = typeof body.teamTaskId === "string" && body.teamTaskId.length > 0;
      // W146: a non-canonical workspace DECLARATION is a client fault —
      // canonicalWorkspace throws the typed WorkspaceDeclarationError
      // (run-registry.ts) and the route answers 400 with its message (the
      // W142 wave's empty/relative-cwd observations). Every other resolver
      // fault keeps the catch-all's 500.
      let application: WorkflowApplication;
      try {
        application = context.resolveApplication(
          typeof body.workspace === "string" ? body.workspace : body.cwd,
          undefined,
          { activateInteractiveTask: !hasSurfaceTask },
        );
      } catch (error) {
        if (error instanceof WorkspaceDeclarationError) {
          return send(response, 400, { error: error.message });
        }
        throw error;
      }
      // W144: the hub's ad-hoc shell lane is bounded (the W142 wave's finding
      // (c): no timeout anywhere in the chain). The agent tool lane keeps its
      // current unbounded posture — a separate queued decision.
      const shellExecutor = shellExecutorFor(application, undefined, true, context.guard, bashTimeoutMs(process.env));
      // W145: a nonzero command exit is the COMMAND's result, not a server
      // fault — the executor's exit error carries the code, so the wire does
      // too: 422 {error, exitCode} (the W142 wave's finding (a)). Server
      // faults and guard/authorization denials keep the catch-all's 500.
      try {
        const output = await shellExecutor(command as never, body.cwd, undefined);
        return send(response, 200, { output });
      } catch (error) {
        const exitCode = (error as { exitCode?: unknown }).exitCode;
        if (typeof exitCode === "number") {
          return send(response, 422, { error: error instanceof Error ? error.message : String(error), exitCode });
        }
        throw error;
      }
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    // W134: a HubRequestError is a CLIENT error (an unreadable/malformed
    // request body) — the W133 e2e found a zero-byte body earning a 500
    // "Unexpected end of JSON input" from this catch-all, a client fault
    // classified as a server fault. 400 with the named requirement.
    send(response, error instanceof HubRequestError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

/** W134: a request-body fault (unreadable, oversized, or not JSON) — the
 * catch-all classifies it 400, never 500 (the W133 finding). */
class HubRequestError extends Error {}

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
    if (length > 1024 * 1024) throw new HubRequestError("Workflow hub request is too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // W134: every hub route except /health reads a JSON body — a zero-byte
    // body ("") or a malformed one is a CLIENT error; name the requirement
    // instead of surfacing JSON.parse's "Unexpected end of JSON input".
    throw new HubRequestError("a JSON request body is required (send {} for read routes)");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** W144: the /bash lane's bounded-execute cap. Default 120s; the
 * WORKFLOW_HUB_BASH_TIMEOUT_MS override must be a positive integer
 * (milliseconds), CLAMPED to MAX_BASH_TIMEOUT_MS (an operator-explicit env
 * must never smuggle the unbounded lane back in) — anything unparsable falls
 * back to the default. */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 3_600_000;

export function bashTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.WORKFLOW_HUB_BASH_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_BASH_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_BASH_TIMEOUT_MS;
  return Math.min(parsed, MAX_BASH_TIMEOUT_MS);
}
