import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { WorkflowApplication } from "../application/workflow.js";
import { evidenceId, observationId, taskId, type TaskId } from "../kernel/contracts.js";
import type { TaskGraph } from "../kernel/task-graph.js";
import { countReferencedAxes, MIN_REFERENCED_AXES } from "../review/rubric.js";
import type { WorkflowApplicationResolver, WorkflowRunController } from "./cline-tui-bridge.js";
import type { HubReviewerResult } from "./hub-reviewer.js";

/** Launches the hub-owned reviewer for a run (plan Task A2). */
export type RunReviewer = (input: {
  readonly runId: string;
  readonly workspace: string | undefined;
}) => Promise<HubReviewerResult>;

export type RunReviewerFactory = (controller: WorkflowRunController) => RunReviewer;

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
 * The single canonicalization discipline for surface-declared workspaces
 * (`docs/HUB_PROTOCOL.md` §3): declarations must be absolute existing
 * directories, and one canonical (realpath) path means one application —
 * raw declared paths never create a second application for the same
 * directory. Invalid declarations throw; callers surface that as an
 * authority error so clients fail closed.
 */
export function canonicalWorkspace(target: string): string {
  if (!isAbsolute(target)) throw new TypeError(`declared workspace must be absolute: ${target}`);
  if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
    throw new TypeError(`declared workspace is not an existing directory: ${target}`);
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
  },
): {
  resolve: WorkflowApplicationResolver;
  controller: WorkflowRunController;
  reviewOutcomes(): ReadonlyMap<string, HubReviewerResult>;
  blockingReasons(): ReadonlyMap<string, string>;
  recordBlockingReason(input: { readonly runId: string; readonly reason: string }): void;
  recordCompletionClaim(input: { readonly runId: string; readonly claim: string }): void;
  completionClaims(): ReadonlyMap<string, { readonly runId: string; readonly claim: string; readonly verifiedAtClaim: boolean; readonly observedAt: string }>;
} {
  const workspaceApplications = new Map<string, WorkflowApplication>();
  const runs = new Map<string, WorkflowApplication>();
  const runWorkspaces = new Map<string, string | undefined>();
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
      };
    },
    async begin({ runId, title, workspace, requiresReview }) {
      if (runId.trim().length === 0 || title.trim().length === 0) {
        throw new TypeError("run begin requires a non-empty runId and title");
      }
      if (runs.has(runId)) throw new TypeError(`duplicate run: ${runId}`);
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
      const started = application.transition(runTaskId, "IN_PROGRESS");
      if (started.kind !== "accepted") throw new Error(`cannot start run ${runId}: ${started.reason}`);
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
          const verifying = application.transition(runTaskId, "VERIFYING");
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
        let verified = application.transition(runTaskId, "VERIFIED");
        const hasFreshReviewerEvidence = graph
          .evidenceFor(runId)
          .some((evidence) => evidence.authority === "reviewer" && evidence.result === "passed" && evidence.freshness === "fresh");
        if (verified.kind !== "accepted" && !hasFreshReviewerEvidence && options?.reviewer !== undefined) {
          // Plan Task A2: a review-gated run missing reviewer evidence
          // auto-launches the hub reviewer. Approval verifies the run; a
          // fail-closed or crashed reviewer leaves the task VERIFYING with
          // a surfaced blocking reason — never a silent pass. The factory
          // receives the controller at call time (the same machinery the
          // verifier-token /run/review endpoint calls).
          const reviewer = options.reviewer(controller);
          let result: HubReviewerResult;
          try {
            result = await reviewer({ runId, workspace: runWorkspaces.get(runId) });
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
          verified = application.transition(runTaskId, "VERIFIED");
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
          application.recordEvidence({
            id: evidenceId(`test-evidence:${runId}`),
            observationId: observationId(`test-observation:${runId}`),
            authority: "environment",
            subject,
            result: "passed",
            freshness: "fresh",
            mutationEpoch: application.snapshot().mutationEpoch,
            observedAt: new Date().toISOString(),
          });
          verified = application.transition(runTaskId, "VERIFIED");
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
        application.transition(runTaskId, "FAILED");
      }
      finishedRunTaskIds.add(runTaskId);
      runs.delete(runId);
      runWorkspaces.delete(runId);
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
  };
}
