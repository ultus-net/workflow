import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { WorkflowApplication } from "../application/workflow.js";
import { evidenceId, observationId, taskId, type TaskId } from "../kernel/contracts.js";
import type { TaskGraph } from "../kernel/task-graph.js";
import { countReferencedAxes, MIN_REFERENCED_AXES } from "../review/rubric.js";
import type { EvidenceContentStore } from "./evidence-content-store.js";
import type { WorkflowApplicationResolver, WorkflowRunController } from "./run-controller.js";
import type { HubReviewerResult } from "./hub-reviewer.js";
import type { TaskUsageSummary } from "./task-usage.js";

/** Launches the hub-owned reviewer for a run (plan Task A2). */
export type RunReviewer = (input: {
  readonly runId: string;
  readonly workspace: string | undefined;
  /** The ask the run was launched with, when declared — the reviewer binds it into its provenance fingerprint (W041). */
  readonly taskPrompt?: string;
}) => Promise<HubReviewerResult>;

/**
 * W111 (issue #283): the factory also receives the registry's per-task journal
 * writer, so the reviewer lane's ACP runtime can publish its completed-turn
 * boundary deltas into the same journal the scheduler and RSI lanes write. The
 * second argument is additive: a factory that ignores it stays valid.
 */
export type RunReviewerFactory = (
  controller: WorkflowRunController,
  recordTaskUsage: (input: Omit<TaskUsageSummary, "recordedAt">) => void,
) => RunReviewer;

/**
 * Executes the workspace test command hub-side and reports environment
 * truth (plan Task D1). The command must come from project config, never
 * from the agent.
 */
export type RunTestRunner = (input: {
  readonly runId: string;
  readonly workspace: string | undefined;
  readonly subject: string;
}) => Promise<{ readonly passed: boolean; readonly output: string }>;

export function runTestSubject(runId: string, workspace: string | undefined): string {
  return `test:${workspace ?? runId}`;
}

/**
 * W044 (open clause): hub-side per-session usage aggregation. A scheduled
 * run's metering-proxy totals, recorded at turn end from the runtime's
 * metrics so hub-attached monitors can render per-run cost without an agent
 * process of their own. Plain records (the /snapshot payload is JSON).
 */
export interface RunUsageSummary {
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  /**
   * P12 (W109 gap 2): the cache components ride the recorded totals — the
   * metering proxy's first-class cache fields, so the cache-hit savings are
   * observable per run. On the OpenAI chat-completions lane these stay 0
   * (its cached reads are inside promptTokens; the recorded lane asymmetry).
   */
  readonly cacheReadTokens: number;
  readonly cacheCreateTokens: number;
  readonly recordedAt: string;
}

/** One advisory reasoning-claim finding (observability-only; never evidence). */
export interface ReasoningClaimFinding {
  readonly runId: string;
  readonly sentence: string;
  readonly observedAt: string;
}

/**
 * Cross-run monitor metrics. `recall` and `timeToResponseMs` are explicitly
 * UNMEASURED: recall needs misbehavior labels the hub does not have, and
 * time-to-response needs a responder action no consumer performs yet. Reporting
 * them as measured would be the overclaim this repo forbids.
 */
export interface ReasoningClaimMetrics {
  /**
   * Scheduled-lane run-turns the monitor actually observed (the coverage
   * denominator for the lane that feeds the monitor). Other registry lanes
   * (RSI, reviewer, external /run/begin) are NOT counted, so this is never a
   * cross-lane coverage claim.
   */
  readonly monitoredRuns: number;
  /** Runs with at least one advisory finding (monotonic; may exceed visible feed entries after eviction). */
  readonly flaggedRuns: number;
  /** Total advisory findings recorded (monotonic, not bounded by the journal). */
  readonly findings: number;
  readonly recall: "unmeasured";
  readonly timeToResponseMs: "unmeasured";
}

/**
 * W153: explicit origin attribution on a run record. The scheduler has always
 * made attribution STRUCTURAL (run ids `schedule:<id>:<uuid>`); this field is
 * the recorded form — the recorder states the origin at begin time, so run
 * rows can name "fired by schedule S" from the registry rather than from id
 * parsing at the view. The scheduler AND the W162 board-delegation route
 * record it, both hub-side: the route records what its OWN provider read
 * returned — the client never supplies attribution, and /run/begin still
 * accepts none (a client-supplied one would be forgeable attribution).
 */
export type RunOrigin =
  | { readonly kind: "schedule"; readonly scheduleId: string }
  | { readonly kind: "provider-task"; readonly provider: "github" | "azure_devops"; readonly key: string; readonly url: string };

/**
 * W165: the hub-recorded run→work-product (PR) linkage — the provider-stable
 * reference the run's work product is tracked against (the provider, the
 * reference key the provider's PR-state read keys on, the url). Recorded by
 * the hub's own lanes only: the W162 board-delegation route records it from
 * its OWN provider read at the same begin that records the provider-task
 * origin (at begin time the tracked reference is the delegated board task's
 * own record — a producer that knows a PR records its key), so the board's
 * in_review column projects registry-sourced linkage plus the provider-owned
 * PR state. The client never supplies attribution, /run/begin still accepts
 * none, and the view never computes the linkage (the W153 pin pattern).
 */
export type WorkProductLink = {
  readonly provider: "github" | "azure_devops";
  readonly key: string;
  readonly url: string;
};

/**
 * W146: the typed classification for a client-shaped fault in a
 * surface-declared workspace — the declaration violates the
 * canonicalization contract (`docs/HUB_PROTOCOL.md` §3) before any
 * application state is touched. Subclasses TypeError so every existing
 * `instanceof TypeError` posture (there are none in-repo, grep-verified)
 * and any external catch site keeps working; wire surfaces classify it
 * as 400 because the caller's declaration is the fault, not the server.
 */
export class WorkspaceDeclarationError extends TypeError {}

/**
 * The single canonicalization discipline for surface-declared workspaces
 * (`docs/HUB_PROTOCOL.md` §3): declarations must be absolute existing
 * directories, and one canonical (realpath) path means one application —
 * raw declared paths never create a second application for the same
 * directory. Invalid declarations throw; callers surface that as an
 * authority error so clients fail closed.
 */
export function canonicalWorkspace(target: string): string {
  if (!isAbsolute(target)) throw new WorkspaceDeclarationError(`declared workspace must be absolute: ${target}`);
  if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
    throw new WorkspaceDeclarationError(`declared workspace is not an existing directory: ${target}`);
  }
  return realpathSync(target);
}

/**
 * Resolves the WorkflowApplication for a surface-declared workspace and
 * manages dedicated task/evidence lifecycles for scheduled runs. Each
 * workspace gets a lazily created application over the hub's shared task
 * graph, so task/evidence state is global while workspace-path authorization
 * is per surface; each run gets its own task and records its own evidence.
 * Invalid declarations throw, which the bridge surfaces as an authority error
 * (clients fail closed). See `docs/HUB_PROTOCOL.md` §3.
 *
 * When a reviewer factory is provided, finishing a review-gated run that is
 * missing reviewer evidence auto-launches the hub reviewer (plan Task A2):
 * approval verifies the run; a fail-closed or crashed reviewer leaves the
 * task VERIFYING with a surfaced blocking reason — never a silent pass.
 *
 * When a test runner is provided, review-gated runs additionally require
 * fresh passing `environment` evidence at subject `test:<workspace>` (plan
 * Task D1): the hub executes the workspace test command itself and records
 * the observation; failing or crashing tests leave the task VERIFYING with
 * a surfaced blocking reason.
 */
export function createRunRegistry(
  fallback: WorkflowApplication,
  graph: TaskGraph,
  options?: {
    readonly reviewer?: RunReviewerFactory;
    readonly testRunner?: RunTestRunner;
    /**
     * W158: the bounded content store behind the evidence content references.
     * Absent → the capture is skipped (the evidence records render plain, the
     * honest absence) — the strip's preview needs a hub that wired a store.
     */
    readonly contentStore?: EvidenceContentStore;
  },
): {
  resolve: WorkflowApplicationResolver;
  controller: WorkflowRunController;
  reviewOutcomes(): ReadonlyMap<string, HubReviewerResult>;
  blockingReasons(): ReadonlyMap<string, string>;
  recordBlockingReason(input: { readonly runId: string; readonly reason: string }): void;
  recordCompletionClaim(input: { readonly runId: string; readonly claim: string }): void;
  completionClaims(): ReadonlyMap<string, { readonly runId: string; readonly claim: string; readonly verifiedAtClaim: boolean; readonly observedAt: string }>;
  /** W044 (open clause): per-run usage recorded from the runtime's metering-proxy metrics. */
  recordRunUsage(input: { readonly runId: string; readonly usage: Omit<RunUsageSummary, "recordedAt"> }): void;
  runUsage(): ReadonlyMap<string, RunUsageSummary>;
  /**
   * W111: append a recorded per-task boundary delta (the active-task pointer
   * paired with the turn delta). A bounded journal — the per-task rollup is
   * the sum of recorded entries, so entries are NOT collapsed latest-per-task
   * (unlike `runUsage`). Record-only; views never re-derive a delta.
   */
  recordTaskUsage(input: Omit<TaskUsageSummary, "recordedAt">): void;
  taskUsage(): readonly TaskUsageSummary[];
  /** Iteration 21: journal an advisory reasoning-claim finding (observability-only). */
  recordReasoningClaim(input: { readonly runId: string; readonly sentence: string }): void;
  /** Iteration 21: declare that the monitor observed a run (scheduled lane only; coverage denominator). */
  noteReasoningClaimMonitor(input: { readonly runId: string }): void;
  reasoningClaims(): ReadonlyMap<string, ReasoningClaimFinding>;
  /** Iteration 21: honest cross-run monitor metrics (recall/TTR explicitly unmeasured). */
  reasoningClaimMetrics(): ReasoningClaimMetrics;
  /** W153: the recorded run origins (schedule-fired attribution), bounded like the other gate maps. */
  recordRunOrigin(input: { readonly runId: string; readonly origin: RunOrigin }): void;
  runOrigins(): ReadonlyMap<string, RunOrigin>;
  /** W165: the recorded run→PR work-product links, bounded like the other gate maps. */
  recordWorkProductLink(input: { readonly runId: string; readonly link: WorkProductLink }): void;
  workProductLinks(): ReadonlyMap<string, WorkProductLink>;
  /** W162 slice 2: the ACTIVE run ids, bounded to the most recent 64 in begin order (the transitionLogs bound). */
  activeRunIds(): readonly string[];
} {
  const workspaceApplications = new Map<string, WorkflowApplication>();
  const runs = new Map<string, WorkflowApplication>();
  const runWorkspaces = new Map<string, string | undefined>();
  const runPrompts = new Map<string, string>();
  const runTestSubjects = new Map<string, string>();
  const reviewOutcomes = new Map<string, HubReviewerResult>();
  const rememberReviewOutcome = (runId: string, result: HubReviewerResult): void => {
    reviewOutcomes.set(runId, result);
    // Bounded so a long-lived hub cannot grow the map without limit; the
    // oldest outcomes (first insertion) are evicted first.
    while (reviewOutcomes.size > 64) {
      const oldest = reviewOutcomes.keys().next().value;
      if (oldest === undefined) break;
      reviewOutcomes.delete(oldest);
    }
  };
  const finishedRunTaskIds = new Set<string>();
  const blockingReasons = new Map<string, string>();
  const rememberBlockingReason = (runId: string, reason: string): void => {
    blockingReasons.set(runId, reason);
    // Same bounded-observability rule as review outcomes.
    while (blockingReasons.size > 64) {
      const oldest = blockingReasons.keys().next().value;
      if (oldest === undefined) break;
      blockingReasons.delete(oldest);
    }
  };
  // Plan Task G5: completion-claims journal (observability-only, ported from
  // the plugin's Policy 24 claims-vs-evidence mismatch check). A claim is
  // journaled with whether the run's task was VERIFIED at claim time; it
  // never blocks, never mutates state, and never fabricates evidence.
  const completionClaims = new Map<string, { readonly runId: string; readonly claim: string; readonly verifiedAtClaim: boolean; readonly observedAt: string }>();
  const rememberCompletionClaim = (runId: string, claim: string, verifiedAtClaim: boolean): void => {
    completionClaims.set(runId, {
      runId,
      claim,
      verifiedAtClaim,
      observedAt: new Date().toISOString(),
    });
    while (completionClaims.size > 64) {
      const oldest = completionClaims.keys().next().value;
      if (oldest === undefined) break;
      completionClaims.delete(oldest);
    }
  };
  // W044 (open clause): per-run usage from the metering proxy, recorded at
  // turn end. Same bounded-observability rule as the other gate maps.
  const runUsage = new Map<string, RunUsageSummary>();
  const rememberRunUsage = (runId: string, usage: Omit<RunUsageSummary, "recordedAt">): void => {
    runUsage.set(runId, { ...usage, recordedAt: new Date().toISOString() });
    while (runUsage.size > 64) {
      const oldest = runUsage.keys().next().value;
      if (oldest === undefined) break;
      runUsage.delete(oldest);
    }
  };
  // W111: the recorded per-task boundary deltas. A bounded APPEND journal
  // (not a latest-wins map like runUsage): a task can span many turns, and the
  // per-task rollup is the SUM of recorded entries, so collapsing to the
  // latest delta per task would under-report. Eviction is FIFO at 64 — the
  // same bounded-observability discipline as the sibling gate maps.
  const taskUsage: TaskUsageSummary[] = [];
  const rememberTaskUsage = (usage: Omit<TaskUsageSummary, "recordedAt">): void => {
    taskUsage.push({ ...usage, recordedAt: new Date().toISOString() });
    while (taskUsage.length > 64) {
      taskUsage.shift();
    }
  };
  // Iteration 21: reasoning-claims accountability feed (advisory-only), mirroring
  // the completion-claims journal's shape and bounds. A finding is the monitor's
  // advisory observation that a run's streamed text claimed completed
  // verification with no observed action; it never blocks, never mutates state,
  // and never becomes evidence. Metrics are honest about what cannot be measured.
  const reasoningClaims = new Map<string, ReasoningClaimFinding>();
  // W153: recorded run origins, bounded like the other gate maps.
  const runOrigins = new Map<string, RunOrigin>();
  const rememberRunOrigin = (runId: string, origin: RunOrigin): void => {
    runOrigins.set(runId, origin);
    while (runOrigins.size > 64) {
      const oldest = runOrigins.keys().next().value;
      if (oldest === undefined) break;
      runOrigins.delete(oldest);
    }
  };
  // W165: recorded run→PR work-product links, bounded like the other gate maps.
  const workProductLinks = new Map<string, WorkProductLink>();
  const rememberWorkProductLink = (runId: string, link: WorkProductLink): void => {
    workProductLinks.set(runId, link);
    while (workProductLinks.size > 64) {
      const oldest = workProductLinks.keys().next().value;
      if (oldest === undefined) break;
      workProductLinks.delete(oldest);
    }
  };
  // W175: the recorded begin times — the begin transition's own attribution
  // observedAt per run, bounded 64 like the sibling gate maps. The /api/runs
  // rows carry startedAt only where this record has one; a run begun before
  // the window (or without a registry begin at all) renders the named
  // absence, never a derived timestamp.
  const runStarts = new Map<string, string>();
  const rememberRunStart = (runId: string, startedAt: string): void => {
    runStarts.set(runId, startedAt);
    while (runStarts.size > 64) {
      const oldest = runStarts.keys().next().value;
      if (oldest === undefined) break;
      runStarts.delete(oldest);
    }
  };
  let reasoningClaimFindings = 0;
  let reasoningClaimFlaggedRuns = 0;
  let monitoredRuns = 0;
  // Deduped, bounded coverage bookkeeping. Only the scheduled lane declares
  // observation (noteReasoningClaimMonitor); other registry lanes (RSI,
  // reviewer, external /run/begin) do NOT feed the monitor and are not counted.
  const monitoredRunIds = new Set<string>();
  const rememberMonitoredRun = (runId: string): void => {
    if (monitoredRunIds.has(runId)) return;
    monitoredRunIds.add(runId);
    monitoredRuns += 1;
    while (monitoredRunIds.size > 512) {
      const oldest = monitoredRunIds.values().next().value;
      if (oldest === undefined) break;
      monitoredRunIds.delete(oldest);
    }
  };
  const rememberReasoningClaim = (runId: string, sentence: string): void => {
    if (!reasoningClaims.has(runId)) reasoningClaimFlaggedRuns += 1;
    reasoningClaimFindings += 1;
    reasoningClaims.set(runId, { runId, sentence, observedAt: new Date().toISOString() });
    while (reasoningClaims.size > 64) {
      const oldest = reasoningClaims.keys().next().value;
      if (oldest === undefined) break;
      reasoningClaims.delete(oldest);
    }
  };

  const workspaceApplication = (
    workspace: string | undefined,
    activateInteractiveTask = true,
  ): WorkflowApplication => {
    if (workspace === undefined) {
      if (activateInteractiveTask) fallback.startInteractiveTask();
      return fallback;
    }
    const canonical = canonicalWorkspace(workspace);
    let application = workspaceApplications.get(canonical);
    if (application === undefined) {
      application = new WorkflowApplication(graph, fallback.host, [], fallback.allowedCapabilities, canonical);
      workspaceApplications.set(canonical, application);
    }
    if (activateInteractiveTask) application.startInteractiveTask();
    return application;
  };

  const controller: WorkflowRunController = {
    hiddenSnapshotTaskIds() {
      const interactive = graph.tasks().find(({ id }) => id === taskId("interactive"));
      return [
        ...(interactive?.title === "Interactive coding session" ? [interactive.id] : []),
        ...finishedRunTaskIds,
      ];
    },
    // W171: the discovery lane's record path — the controller exposes the
    // registry's existing bounded map writer so the /board/tasks route can
    // record a PROVIDER-OWNED discovery (the timeline's cross-referenced PR)
    // without the route ever touching the map itself.
    recordWorkProductLink(input) {
      rememberWorkProductLink(input.runId, input.link);
    },
    // W162 slice 2: the ACTIVE run ids (the runs map's membership), bounded
    // to the most recent 64 in begin order — the transitionLogs bound. The
    // board's in_progress join keys on this registry fact: finish() removes
    // membership while the origin record persists, so the join can never key
    // on origins alone.
    activeRunIds() {
      return [...runs.keys()].slice(-64);
    },
    /**
     * Plan Task A3: run-gate observability for hub-attached surfaces — the
     * latest reviewer verdicts, blocking reasons, and unverified completion
     * claims, serialized onto /snapshot. Observation only; canonical state
     * never moves through this path.
     */
    gateObservability() {
      return {
        reviewOutcomes,
        blockingReasons,
        completionClaims,
        runUsage,
        // W111: the recorded per-task boundary deltas (bounded append journal)
        // ride the same observability surface for hub-attached monitors.
        taskUsage,
        reasoningClaims,
        runOrigins,
        workProductLinks,
        // W175: the recorded begin times (the begin transition's own
        // attribution observedAt, bounded 64) — the run rows' startedAt
        // source, never a view-side derivation.
        runStarts,
        reasoningClaimMetrics: {
          monitoredRuns,
          flaggedRuns: reasoningClaimFlaggedRuns,
          findings: reasoningClaimFindings,
          recall: "unmeasured" as const,
          timeToResponseMs: "unmeasured" as const,
        },
        /**
         * W152: each run's own kernel transition log (its application's
         * `#history`), bounded to the most recent 64 runs in begin order — the
         * same bounded-observability rule as the gate maps. The kernel records
         * no actor or authority on transitions; the timeline renders those
         * rows unattributed (W157 is the record change that would add it).
         */
        transitionLogs: (() => {
          const bounded = [...runs.entries()].slice(-64);
          const logs = new Map<string, readonly import("../kernel/contracts.js").TransitionRecord[]>();
          for (const [runId, application] of bounded) {
            logs.set(runId, application.snapshot().history);
          }
          return logs;
        })(),
      };
    },
    async begin({ runId, title, workspace, requiresReview, taskPrompt, origin, workProductLink }) {
      if (runId.trim().length === 0 || title.trim().length === 0) {
        throw new TypeError("run begin requires a non-empty runId and title");
      }
      if (runs.has(runId)) throw new TypeError(`duplicate run: ${runId}`);
      // W153: the scheduler's recorded origin attribution (if it declared one).
      if (origin !== undefined) rememberRunOrigin(runId, origin);
      // W165: the delegate lane's recorded work-product link (if it declared
      // one) — hub-side only, like the origin above.
      if (workProductLink !== undefined) rememberWorkProductLink(runId, workProductLink);
      const parent = workspaceApplication(workspace);
      const application = new WorkflowApplication(
        graph,
        fallback.host,
        [],
        fallback.allowedCapabilities,
        parent.workspaceRoot,
      );
      const runTaskId: TaskId = taskId(`run:${runId}`);
      // Plan Task D1: when the hub owns a test runner, review-gated runs also
      // require fresh passing environment evidence for the workspace tests.
      const testSubject = requiresReview === true && options?.testRunner !== undefined
        ? runTestSubject(runId, workspace)
        : undefined;
      application.addTask({
        id: runTaskId,
        title,
        dependencies: [],
        // Review-gated runs cannot reach VERIFIED without reviewer evidence.
        requiredEvidence: requiresReview === true
          ? [
              { authority: "reviewer" as const, subject: runId },
              ...(testSubject === undefined ? [] : [{ authority: "environment" as const, subject: testSubject }]),
            ]
          : [],
      });
      // W157: the run lane stamps what it knows — a schedule-fired run's
      // begin belongs to the scheduler (the origin record names it); a W162
      // board-delegated run's begin belongs to the operator's delegate route
      // (the provider-task origin record names it); any other begin is
      // agent-driven through the registry surface.
      // W175: the begin stamp IS the start record — the /api/runs rows carry
      // this exact attribution time as startedAt, never a derived one.
      const beganAt = new Date().toISOString();
      const started = application.transition(runTaskId, "IN_PROGRESS", {
        actor: origin === undefined ? "agent" : origin.kind === "schedule" ? "scheduler" : "operator",
        authority: origin === undefined
          ? "run begin (run registry)"
          : origin.kind === "schedule"
            ? `schedule-fired run begin (origin ${origin.scheduleId})`
            : `provider-task run begin (origin ${origin.key})`,
        observedAt: beganAt,
      });
      if (started.kind !== "accepted") throw new Error(`cannot start run ${runId}: ${started.reason}`);
      rememberRunStart(runId, beganAt);
      application.selectActiveTask(runTaskId);
      if (testSubject !== undefined) {
        runTestSubjects.set(runId, testSubject);
        // Cross-run freshness: a new run in the same workspace invalidates any
        // earlier run's still-fresh test evidence for that workspace — a run
        // must never verify on a predecessor's green tests.
        application.recordMutation([testSubject]);
      }
      runs.set(runId, application);
      runWorkspaces.set(runId, workspace);
      if (typeof taskPrompt === "string" && taskPrompt.length > 0) runPrompts.set(runId, taskPrompt);
    },
    async review({ runId, reviewerRunId, verdict, summary }) {
      const application = runs.get(runId);
      if (application === undefined) throw new TypeError(`unknown run: ${runId}`);
      if (!runs.has(reviewerRunId)) throw new TypeError(`unknown reviewer run: ${reviewerRunId}`);
      // Anti-rubber-stamp: a run cannot review itself (ported from
      // opencode-workflow-guard's subagent-only record_review).
      if (reviewerRunId === runId) throw new TypeError("a run cannot review itself");
      if (verdict === "approved" && countReferencedAxes(summary) < MIN_REFERENCED_AXES) {
        throw new TypeError(
          `review summary must reference at least ${MIN_REFERENCED_AXES} of the 5 axes (found ${countReferencedAxes(summary)})`,
        );
      }
      if (verdict !== "approved") return { recorded: false };
      application.recordMutation([runId]);
      application.recordEvidence({
        id: evidenceId(`review-evidence:${runId}`),
        observationId: observationId(`review-observation:${runId}:${reviewerRunId}`),
        authority: "reviewer",
        subject: runId,
        result: "passed",
        freshness: "fresh",
        mutationEpoch: application.snapshot().mutationEpoch,
        observedAt: new Date().toISOString(),
      });
      return { recorded: true };
    },
    async finish({ runId, outcome }) {
      const application = runs.get(runId);
      if (application === undefined) throw new TypeError(`unknown run: ${runId}`);
      const runTaskId = taskId(`run:${runId}`);
      if (outcome === "verified") {
        // No mutation here: verification observes the world as the run left
        // it. Mutating at finish time would invalidate the reviewer and
        // environment evidence that is supposed to validate this run.
        const current = application.snapshot().tasks.find((task) => task.id === runTaskId)?.state;
        if (current === "IN_PROGRESS") {
          // W157: the finish call only reports the session ended — the stamp
          // says exactly that; the promotion below stays evidence-gated.
          const verifying = application.transition(runTaskId, "VERIFYING", {
            actor: "system",
            authority: "run finish observation (session ended; promotion still evidence-gated)",
            observedAt: new Date().toISOString(),
          });
          if (verifying.kind !== "accepted") throw new Error(`cannot verify run ${runId}: ${verifying.reason}`);
        } else if (current !== "VERIFYING") {
          throw new Error(`cannot verify run ${runId}: task is ${current}`);
        }
        // No fabricated evidence here: a finish call only reports that the
        // session ended. Promotion to VERIFIED is decided by the kernel -
        // plain runs carry no evidence requirements, while requiresReview
        // runs can only advance on reviewer evidence recorded through
        // /run/review (plus hub-run test evidence when a test runner is
        // wired, plan Task D1). Recording synthetic "passed" evidence
        // without a real observation would self-certify the run.
        // W157: this promotion attempt is the finish's own; whose evidence
        // satisfied the gate is visible in the kernel's evidence records.
        let verified = application.transition(runTaskId, "VERIFIED", {
          actor: "system",
          authority: "run finish promotion (evidence gate decides)",
          observedAt: new Date().toISOString(),
        });
        const hasFreshReviewerEvidence = graph
          .evidenceFor(runId)
          .some((evidence) => evidence.authority === "reviewer" && evidence.result === "passed" && evidence.freshness === "fresh");
        if (verified.kind !== "accepted" && !hasFreshReviewerEvidence && options?.reviewer !== undefined) {
          // Plan Task A2: a review-gated run missing reviewer evidence
          // auto-launches the hub reviewer. Approval verifies the run; a
          // fail-closed or crashed reviewer leaves the task VERIFYING with
          // a surfaced blocking reason — never a silent pass. The factory
          // receives the controller at call time (the same machinery the
          // verifier-token /run/review endpoint calls) plus the registry's
          // per-task journal writer (W111, issue #283), so the reviewer lane's
          // completed-turn deltas land in the one taskUsage journal.
          const reviewer = options.reviewer(controller, rememberTaskUsage);
          let result: HubReviewerResult;
          try {
            const taskPrompt = runPrompts.get(runId);
            result = await reviewer({
              runId,
              workspace: runWorkspaces.get(runId),
              ...(taskPrompt === undefined ? {} : { taskPrompt }),
            });
          } catch (error) {
            const reason = `hub reviewer failed: ${error instanceof Error ? error.message : String(error)}`;
            rememberBlockingReason(runId, reason);
            throw new Error(`cannot verify run ${runId}: ${reason}`, { cause: error });
          }
          rememberReviewOutcome(runId, result);
          if (!result.recorded) {
            const reason = result.parseFailure ?? "reviewer did not approve the run";
            rememberBlockingReason(runId, reason);
            throw new Error(`cannot verify run ${runId}: ${reason}`);
          }
          verified = application.transition(runTaskId, "VERIFIED", {
            // W157: the reviewer's admitted verdict is what verified the run.
            actor: "agent",
            authority: "review verdict record (reviewer approved; hub-reviewer)",
            observedAt: new Date().toISOString(),
          });
          if (verified.kind !== "accepted" && options?.testRunner === undefined) {
            rememberBlockingReason(runId, verified.reason);
            throw new Error(`cannot verify run ${runId}: ${verified.reason}`);
          }
        }
        if (verified.kind !== "accepted" && options?.testRunner !== undefined && runTestSubjects.has(runId)) {
          // Plan Task D1: the hub runs the workspace test command itself and
          // records the environment observation. Failing or crashing tests
          // leave the task VERIFYING with the output as blocking reason.
          const subject = runTestSubjects.get(runId)!;
          let testOutcome: { readonly passed: boolean; readonly output: string };
          try {
            testOutcome = await options.testRunner({
              runId,
              workspace: runWorkspaces.get(runId),
              subject,
            });
          } catch (error) {
            const reason = `hub test run failed: ${error instanceof Error ? error.message : String(error)}`;
            rememberBlockingReason(runId, reason);
            throw new Error(`cannot verify run ${runId}: ${reason}`, { cause: error });
          }
          if (!testOutcome.passed) {
            const reason = `test evidence failed: ${testOutcome.output.slice(0, 200)}`;
            rememberBlockingReason(runId, reason);
            throw new Error(`cannot verify run ${runId}: ${reason}`);
          }
          // W158: the PASSED test output is captured as bounded content ON the
          // very evidence record the verification consumed — one record, not a
          // parallel copy. Over-cap output is honest absence (no fabricated
          // reference); the bytes never enter the kernel.
          const storedContent = options?.contentStore?.put("test-output", "text/plain", testOutcome.output);
          application.recordEvidence({
            id: evidenceId(`test-evidence:${runId}`),
            observationId: observationId(`test-observation:${runId}`),
            authority: "environment",
            subject,
            result: "passed",
            freshness: "fresh",
            mutationEpoch: application.snapshot().mutationEpoch,
            observedAt: new Date().toISOString(),
            ...(storedContent === undefined ? {} : { content: { kind: "test-output" as const, ref: storedContent.ref, byteSize: storedContent.byteSize } }),
          });
          verified = application.transition(runTaskId, "VERIFIED", {
            // W157: the hub test runner's fresh environment evidence is what
            // verified the run.
            actor: "system",
            authority: "environment test evidence (hub test runner)",
            observedAt: new Date().toISOString(),
          });
          if (verified.kind !== "accepted") {
            rememberBlockingReason(runId, verified.reason);
            throw new Error(`cannot verify run ${runId}: ${verified.reason}`);
          }
        }
        if (verified.kind !== "accepted") {
          rememberBlockingReason(runId, verified.reason);
          throw new Error(`cannot verify run ${runId}: ${verified.reason}`);
        }
        blockingReasons.delete(runId);
      } else {
        application.recordMutation([runId]);
        application.recordEvidence({
          id: evidenceId(`run-evidence:${runId}`),
          observationId: observationId(`run-observation:${runId}`),
          authority: "environment",
          subject: runId,
          result: "failed",
          freshness: "fresh",
          mutationEpoch: application.snapshot().mutationEpoch,
          observedAt: new Date().toISOString(),
        });
        application.transition(runTaskId, "FAILED", {
          // W157: the finish outcome reported failure; the run lane records it.
          actor: "system",
          authority: "run failure record (finish outcome failed)",
          observedAt: new Date().toISOString(),
        });
      }
      finishedRunTaskIds.add(runTaskId);
      runs.delete(runId);
      runWorkspaces.delete(runId);
      runPrompts.delete(runId);
      runTestSubjects.delete(runId);
    },
  };
  return {
    resolve(workspace?: string, runId?: string, options?: { activateInteractiveTask?: boolean }): WorkflowApplication {
      if (runId !== undefined) {
        const application = runs.get(runId);
        if (application === undefined) throw new TypeError(`unknown run: ${runId}`);
        return application;
      }
      return workspaceApplication(workspace, options?.activateInteractiveTask ?? true);
    },
    controller,
    reviewOutcomes(): ReadonlyMap<string, HubReviewerResult> {
      return reviewOutcomes;
    },
    blockingReasons(): ReadonlyMap<string, string> {
      return blockingReasons;
    },
    /** Hub-side surfaces (e.g. the scheduler) record why a run was blocked. */
    recordBlockingReason(input: { readonly runId: string; readonly reason: string }): void {
      rememberBlockingReason(input.runId, input.reason);
    },
    /**
     * Plan Task G5: journal a run's final completion claim (the agent's own
     * "done" text) with whether the kernel had verified the run at that
     * moment. Observability-only — never blocks, never records evidence.
     */
    recordCompletionClaim(input: { readonly runId: string; readonly claim: string }): void {
      // The runs map drops finished runs; the shared graph keeps the task —
      // a claim recorded right after a verified finish must still see
      // VERIFIED, not a phantom mismatch.
      const runTaskId = taskId(`run:${input.runId}`);
      let verifiedAtClaim: boolean;
      try {
        verifiedAtClaim = graph.get(runTaskId).state === "VERIFIED";
      } catch {
        verifiedAtClaim = false;
      }
      rememberCompletionClaim(input.runId, input.claim, verifiedAtClaim);
    },
    completionClaims(): ReadonlyMap<string, { readonly runId: string; readonly claim: string; readonly verifiedAtClaim: boolean; readonly observedAt: string }> {
      return completionClaims;
    },
    recordRunUsage(input: { readonly runId: string; readonly usage: Omit<RunUsageSummary, "recordedAt"> }): void {
      rememberRunUsage(input.runId, input.usage);
    },
    runUsage(): ReadonlyMap<string, RunUsageSummary> {
      return runUsage;
    },
    recordTaskUsage(input: Omit<TaskUsageSummary, "recordedAt">): void {
      rememberTaskUsage(input);
    },
    taskUsage(): readonly TaskUsageSummary[] {
      return taskUsage;
    },
    /**
     * Iteration 21: journal an advisory reasoning-claim finding for a run.
     * Observability-only — never blocks, never mutates state, never evidence.
     * Unknown runs are accepted (the feed is not authorization).
     */
    recordReasoningClaim(input: { readonly runId: string; readonly sentence: string }): void {
      rememberReasoningClaim(input.runId, input.sentence);
    },
    noteReasoningClaimMonitor(input: { readonly runId: string }): void {
      rememberMonitoredRun(input.runId);
    },
    reasoningClaims(): ReadonlyMap<string, ReasoningClaimFinding> {
      return reasoningClaims;
    },
    recordRunOrigin(input: { readonly runId: string; readonly origin: RunOrigin }): void {
      rememberRunOrigin(input.runId, input.origin);
    },
    runOrigins(): ReadonlyMap<string, RunOrigin> {
      return runOrigins;
    },
    recordWorkProductLink(input: { readonly runId: string; readonly link: WorkProductLink }): void {
      rememberWorkProductLink(input.runId, input.link);
    },
    workProductLinks(): ReadonlyMap<string, WorkProductLink> {
      return workProductLinks;
    },
    activeRunIds(): readonly string[] {
      return [...runs.keys()].slice(-64);
    },
    reasoningClaimMetrics(): ReasoningClaimMetrics {
      return {
        monitoredRuns,
        flaggedRuns: reasoningClaimFlaggedRuns,
        findings: reasoningClaimFindings,
        recall: "unmeasured",
        timeToResponseMs: "unmeasured",
      };
    },
  };
}
