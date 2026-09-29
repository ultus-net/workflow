import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { WorkflowApplication } from "../application/workflow.js";
import { buildReviewRubric } from "../review/rubric.js";
import { WorkspaceDeclarationError } from "./run-registry.js";
import { shellExecutorFor, type WorkflowApplicationResolver, type WorkflowRunController } from "./run-controller.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import type { SelfImprovementRegistry, SelfImprovementSpec } from "./self-improvement-registry.js";
import type { ScheduleRegistry } from "./schedule-registry.js";
import type { ProjectRegistry } from "./project-registry.js";
import { projectScopedBoard, type ProjectRecord } from "./project-registry.js";
import { activityTimeline } from "./activity-timeline.js";
import { operatorPosture, scheduleLineage, scheduleRecentRuns } from "./operator-posture.js";
import { inProgressBoardTasks, workProductStates } from "./task-provider.js";
import type { BoardOutcome, BoardTaskOutcome, CrossReferenceOutcome, WorkProductStateOutcome } from "./task-provider.js";
import type { IssueDetailOutcome, ProviderReadRecord } from "./issue-detail.js";

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
  /**
   * W164: the project container's registry — the hub-owned "open a project"
   * records (provider-stable repo identity, status, budget envelope,
   * workspace bindings). Absent → the routes 404 (like the other optional
   * registries). The record is credential-free by construction; the routes
   * additionally strip anything beyond the schema so a hostile client cannot
   * persist or echo credential-shaped fields.
   */
  readonly projects?: ProjectRegistry;
  /** W158: the bounded content store behind the evidence content references; absent → the read route 404s. */
  readonly contentStore?: {
    get(ref: string): { readonly kind: "test-output" | "screenshot"; readonly mediaType: string; readonly bytes: string; readonly byteSize: number } | undefined;
  };
  /**
   * W161: the external-task board's read capability — a closure over the
   * provider classification + fetch (composed from env at startup). Absent
   * → the route 404s (a hub composed without the capability, like the other
   * optional registries); present → the outcome carries its own honest
   * unconfigured/error/ok state, and the closure never returns credential
   * material.
   */
  readonly readBoardTasks?: () => Promise<BoardOutcome>;
  /**
   * W162: the external-task board's delegation capability — the hub-side
   * single-issue provider read the delegate route composes its run from.
   * Absent → the route 404s (capability withheld, like the other optional
   * registries); present → the outcome carries its own honest
   * unconfigured/error/ok state and never credential material.
   */
  readonly delegateBoardTask?: (issue: number) => Promise<BoardTaskOutcome>;
  /**
   * W165: the board's pull-request-state read — the hub-side provider read
   * the /board/tasks work-product join composes from. Absent → the payload
   * carries no workProducts (the honest subset; the column never appears
   * from fabricated data), like the other optional capabilities.
   */
  readonly readWorkProductState?: (issueNumber: number) => Promise<WorkProductStateOutcome>;
  /**
   * W167: the issue-detail read capability — the hub-side provider read of
   * an issue's description and comment thread (composed from env at
   * startup, wrapped with the provider-read recorder). Absent → the route
   * 404s (capability withheld, like the other optional registries); present
   * → the outcome carries its own honest unconfigured/error/ok state and
   * never credential material.
   */
  readonly readIssueDetail?: (issue: number) => Promise<IssueDetailOutcome>;
  /**
   * W167: the hub-recorded provider read state accessor — the record the
   * liveness pills derive from (recorded hub-side by the composition
   * root's wrapped provider reads; the routes never classify). Absent →
   * the read-state route 404s, and no pill may claim a freshness the hub
   * has no record of.
   */
  readonly providerReadState?: () => ProviderReadRecord | undefined;
  /** W171: the provider-owned discovery read — the linked board issue's
   * timeline cross-references, from which the hub records the actual PR
   * reference (exactly-one rule; never a guess). */
  readonly discoverIssueCrossReferences?: (issueNumber: number) => Promise<CrossReferenceOutcome>;
}

export interface HubBridgeCapabilities {
  readonly readBoardTasks?: () => Promise<BoardOutcome>;
  readonly delegateBoardTask?: (issue: number) => Promise<BoardTaskOutcome>;
  readonly projects?: ProjectRegistry;
  readonly readWorkProductState?: (issueNumber: number) => Promise<WorkProductStateOutcome>;
  readonly readIssueDetail?: (issue: number) => Promise<IssueDetailOutcome>;
  readonly providerReadState?: () => ProviderReadRecord | undefined;
  /** W171: the discovery capability — a FIELD on the capabilities object (the
   * post-#330 extension point), never a positional. */
  readonly discoverIssueCrossReferences?: (issueNumber: number) => Promise<CrossReferenceOutcome>;
}

/**
 * The bridge's capability extension point is THIS OBJECT, never a positional
 * parameter: a new capability adds a field here, a field on HubRequestContext,
 * and its route — the bridge's own positional list stays frozen. The tail-append
 * positional shape was the conflict class that made parallel board items
 * collide on the same signature line (PRs #327/#328/#329, W165/W168/W167).
 */
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
  capabilities: HubBridgeCapabilities = {},
): Promise<WorkflowHubBridge> {
  const token = randomBytes(32).toString("hex");
  const verificationToken = randomBytes(32).toString("hex");
  const context: HubRequestContext = { token, verificationToken, resolveApplication, runController, guard, selfImprovement, schedules, ...(contentStore === undefined ? {} : { contentStore }), ...capabilities };

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
      // W165: workProductLink is deliberately never accepted from clients —
      // the run→PR linkage is recorded only by hub-side lanes (the board
      // delegate flow's own provider read), never from a client's claim.
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
    if (request.url === "/project/list") {
      // W164: the project container's read — the operator-token read class,
      // like /schedule/list. The record is credential-free by construction.
      if (context.projects === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body)) return send(response, 400, { error: "invalid project list request" });
      return send(response, 200, { projects: context.projects.list() });
    }
    if (request.url === "/project/save") {
      // W164: create or replace a project. The route composes the record from
      // VALIDATED schema fields only — a hostile body's extra keys (including
      // credential-shaped ones like `token`) are dropped here, never
      // persisted nor echoed, and a registry validation failure is a client
      // fault that never partially admits.
      if (context.projects === undefined) return send(response, 404, { error: "not found" });
      const parsed = parseProjectRecord(body);
      if (typeof parsed === "string") return send(response, 400, { error: parsed });
      try {
        return send(response, 200, { projects: context.projects.save(parsed) });
      } catch (error) {
        return send(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (request.url === "/project/delete") {
      if (context.projects === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.id !== "string" || body.id.length === 0) {
        return send(response, 400, { error: "invalid project delete request" });
      }
      return send(response, 200, { projects: context.projects.remove(body.id) });
    }
    if (request.url === "/project/scope") {
      // W164: the per-project scoping read — answers ONLY the project's
      // bound workspaces and, when a board read is composed, the board bound
      // to the project's own repo identity (a foreign repo's board is
      // refused by name, never relayed). Reads only: nothing is dispatched,
      // no task state moves.
      if (context.projects === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.id !== "string" || body.id.length === 0) {
        return send(response, 400, { error: "invalid project scope request" });
      }
      const project = context.projects.get(body.id);
      if (project === undefined) return send(response, 404, { error: "unknown project" });
      const board = context.readBoardTasks === undefined ? undefined : await context.readBoardTasks();
      const scope = projectScopedBoard(project, board);
      return send(response, 200, {
        project: { id: project.id, title: project.title, repo: project.repo, status: project.status },
        workspaces: project.workspaces,
        ...(scope.kind === "ok" ? { board } : { board: null, reason: scope.reason }),
      });
    }
    if (request.url === "/board/tasks") {
      // W161: the external-task board's read route — the provider outcome
      // (ok / unconfigured / error) relays verbatim; "unconfigured" is a
      // PAYLOAD state, not a 404, so the view can name the missing env
      // declaration. Read class (the operator token), like /snapshot. The
      // provider's credential never rides the payload (pinned in
      // test/board-tasks.test.ts).
      if (context.readBoardTasks === undefined) return send(response, 404, { error: "not found" });
      // W165: the work-product states ride the read ONLY when every authority
      // exists — the board read succeeded, the hub composes its OWN PR-state
      // read, and the registry recorded at least one link. Otherwise the
      // payload is the bare board outcome (the honest subset; the column
      // never appears from fabricated data).
      const board = await context.readBoardTasks();
      const links = context.runController?.gateObservability?.().workProductLinks;
      // W171: the discovery lane — when the hub carries the discovery
      // capability AND a controller able to record, the join receives the
      // provider-owned discovery read and the record path. The discovered
      // reference is the hub's OWN timeline observation (exactly-one rule);
      // the join itself stays pure — the route does the recording.
      const onDiscovered =
        context.discoverIssueCrossReferences !== undefined && context.runController?.recordWorkProductLink !== undefined
          ? (runId: string, ref: { readonly key: string; readonly url: string }): void => {
              context.runController?.recordWorkProductLink?.({ runId, link: { provider: "github", key: ref.key, url: ref.url } });
            }
          : undefined;
      const workProducts =
        board.state === "ok" && context.readWorkProductState !== undefined && links !== undefined && links.size > 0
          ? await workProductStates(board.board, links, context.readWorkProductState, context.discoverIssueCrossReferences, onDiscovered)
          : undefined;
      // W162 slice 2: the hub-owned in_progress join — OPEN cards with a
      // provider-task origin on an ACTIVE registry run (the pure join in
      // task-provider, supplied registry facts only: the accessor's active
      // ids and the gate map's recorded origins). The field rides ONLY when
      // the active-run authority exists AND the join is nonempty — the
      // honest subset (no authority, no field, no column; never a fabricated
      // state from a timestamp heuristic).
      const activeRunIds = context.runController?.activeRunIds?.();
      const inProgress =
        board.state === "ok" && activeRunIds !== undefined && activeRunIds.length > 0
          ? inProgressBoardTasks(
              board.board,
              context.runController?.gateObservability?.().runOrigins ?? new Map(),
              activeRunIds,
            )
          : undefined;
      return send(response, 200, {
        board,
        ...(workProducts === undefined ? {} : { workProducts }),
        ...(inProgress === undefined || inProgress.length === 0 ? {} : { inProgress }),
      });
    }
    if (request.url === "/board/delegate") {
      // W162: the board card's delegate dispatch — the operator's own click
      // through the web relay, so the OPERATOR token class (the same class
      // as /run/begin, not verifier-only). The run composes from the hub's
      // OWN provider read: the browser supplies only the issue number (and
      // its workspace choice), never the attribution — the provider-task
      // origin is recorded here from what the provider actually returned
      // (the W153 principle: clients never supply attribution).
      if (context.delegateBoardTask === undefined || context.runController === undefined) {
        return send(response, 404, { error: "not found" });
      }
      if (!isRecord(body) || typeof body.issue !== "number" || !Number.isInteger(body.issue) || body.issue <= 0) {
        return send(response, 400, { error: "invalid board delegate request" });
      }
      const outcome = await context.delegateBoardTask(body.issue);
      if (outcome.state !== "ok") return send(response, 200, { delegation: outcome });
      const task = outcome.task;
      const runId = `board:${task.provider}:${body.issue}:${randomBytes(8).toString("hex")}`;
      try {
        await context.runController.begin({
          runId,
          title: `${task.key} ${task.title}`,
          ...(typeof body.workspace === "string" && body.workspace.length > 0 ? { workspace: body.workspace } : {}),
          ...(body.requiresReview === true ? { requiresReview: true } : {}),
          taskPrompt: `Work ${task.provider} issue ${task.key}: "${task.title}" (source: ${task.url})`,
          origin: { kind: "provider-task", provider: task.provider, key: task.key, url: task.url },
          // W165: the run→PR linkage is recorded from the hub's OWN provider
          // read at the same begin that records the origin — the client body's
          // workProductLink is never read.
          workProductLink: { provider: task.provider, key: task.key, url: task.url },
        });
      } catch (error) {
        if (error instanceof WorkspaceDeclarationError) {
          return send(response, 400, { error: error.message });
        }
        throw error;
      }
      return send(response, 200, { delegation: { state: "ok", runId, task: { key: task.key, title: task.title, url: task.url } } });
    }
    // ── W167: the read-only issue-detail routes (this region only; a
    // parallel hub item lands elsewhere) ──
    // /board/task: the operator-token detail read (the same read class as
    // /board/tasks — reads never widen the token blast radius). The record's
    // own "#<number>" form parses strictly and a non-positive number never
    // reaches the provider read; withheld → 404 like the other optional
    // capabilities. The outcome relays verbatim (ok / unconfigured / error
    // are all PAYLOAD states); the provider credential never rides it.
    if (request.url === "/board/task") {
      if (context.readIssueDetail === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.key !== "string") {
        return send(response, 400, { error: "invalid board task request" });
      }
      const parsed = /^#(\d+)$/.exec(body.key);
      const issue = parsed === null ? Number.NaN : Number(parsed[1]);
      if (Number.isNaN(issue) || issue <= 0) {
        return send(response, 400, { error: "invalid board task request: key must be '#<positive number>'" });
      }
      return send(response, 200, { detail: await context.readIssueDetail(issue) });
    }
    // /board/read-state: the hub's OWN recorded provider-read record (the
    // only thing the liveness pills may derive from) — recorded hub-side by
    // the composition root's wrapped reads, never claimed from a client.
    // No record → { read: null }; withheld → 404. Read class.
    if (request.url === "/board/read-state") {
      if (context.providerReadState === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body)) return send(response, 400, { error: "invalid read-state request" });
      const record = context.providerReadState();
      return send(response, 200, { read: record ?? null });
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
      // W175: the runs block — the run-registry projection the /api/runs relay
      // serves (all run rows; origins; work-product links; review outcomes +
      // blocking reasons; completion claims; per-run usage; reasoning-claim
      // findings + metrics). Rows come from the UNFILTERED run: snapshot tasks
      // (the posture's population: finished runs stay visible) and carry
      // startedAt ONLY when the registry recorded the begin time — a row
      // without one is the named absence, never a derived timestamp. Absent
      // entirely when the controller predates the slice (no authority, no
      // block).
      const runsBlock = gates === undefined ? undefined : {
        rows: snapshot.tasks
          .filter((task) => task.id.startsWith("run:"))
          .map((task) => {
            const runId = task.id.slice("run:".length);
            const startedAt = gates.runStarts?.get(runId);
            return { runId, title: task.title, state: task.state, ...(startedAt === undefined ? {} : { startedAt }) };
          }),
        ...(gates.runOrigins === undefined ? {} : { origins: Object.fromEntries(gates.runOrigins) }),
        ...(gates.workProductLinks === undefined ? {} : { workProducts: Object.fromEntries(gates.workProductLinks) }),
        reviewOutcomes: Object.fromEntries(gates.reviewOutcomes),
        blockingReasons: Object.fromEntries(gates.blockingReasons),
        completionClaims: Object.fromEntries(gates.completionClaims),
        ...(gates.runUsage === undefined ? {} : { usage: Object.fromEntries(gates.runUsage) }),
        ...(gates.reasoningClaims === undefined ? {} : { reasoningClaims: Object.fromEntries(gates.reasoningClaims) }),
        ...(gates.reasoningClaimMetrics === undefined ? {} : { reasoningClaimMetrics: gates.reasoningClaimMetrics }),
      };
      return send(response, 200, {
        snapshot: { ...snapshot, tasks: snapshot.tasks.filter((task) => !hiddenTaskIds.has(task.id)) },
        ...(gateObservability === undefined ? {} : { gateObservability }),
        posture,
        timeline,
        ...(runsBlock === undefined ? {} : { runs: runsBlock }),
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

/**
 * W164: the project save route's schema strip — composes the record from
 * validated fields ONLY. Anything else in the body (unknown keys, and
 * credential-shaped keys like `token` in particular) is dropped, so the
 * registry never persists nor echoes material beyond the project schema.
 * Returns the record or the client-fault message.
 */
function parseProjectRecord(body: unknown): ProjectRecord | string {
  if (!isRecord(body)) return "invalid project save request";
  if (typeof body.id !== "string" || body.id.trim().length === 0) return "invalid project save request: id must be a non-empty string";
  if (typeof body.title !== "string" || body.title.trim().length === 0) return "invalid project save request: title must be a non-empty string";
  const repo = body.repo;
  if (!isRecord(repo)) return "invalid project save request: repo must be an object";
  if (repo.provider !== "github") return "invalid project save request: repo provider must be 'github'";
  if (typeof repo.fullName !== "string" || repo.fullName.trim().length === 0) return "invalid project save request: repo fullName is required";
  if (typeof repo.repoId !== "number" || !Number.isInteger(repo.repoId)) return "invalid project save request: repo repoId must be an integer";
  if (body.status !== "active" && body.status !== "paused" && body.status !== "archived") {
    return "invalid project save request: status must be active, paused, or archived";
  }
  if (!Array.isArray(body.workspaces) || body.workspaces.some((workspace) => typeof workspace !== "string")) {
    return "invalid project save request: workspaces must be an array of strings";
  }
  let budget: ProjectRecord["budget"];
  if (body.budget !== undefined) {
    if (!isRecord(body.budget)) return "invalid project save request: budget must be an object";
    budget = {};
    for (const key of ["maxInputTokens", "maxOutputTokens", "maxTotalTokens", "maxCostUsd"] as const) {
      const cap = (body.budget as Record<string, unknown>)[key];
      if (cap === undefined) continue;
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
        return `invalid project save request: budget ${key} must be a positive number`;
      }
      budget = { ...budget, [key]: cap };
    }
  }
  return {
    id: body.id,
    title: body.title,
    repo: { provider: "github", fullName: repo.fullName, repoId: repo.repoId },
    status: body.status,
    ...(budget === undefined ? {} : { budget }),
    workspaces: body.workspaces as readonly string[],
  };
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
