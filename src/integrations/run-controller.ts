import { hostCapabilities } from "../application/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { WorkflowContainedProcess } from "../containment/workflow-process.js";
import { selectContainment } from "../containment/platform.js";
import type { TaskId } from "../kernel/contracts.js";
import { createContainedShellExecutor, type WorkflowContainedShellExecutor } from "./contained-shell-executor.js";
import type { RunOrigin, WorkProductLink } from "./run-registry.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";

/**
 * Host-neutral composition surface shared by the hub run control plane.
 *
 * These exports previously lived in `cline-tui-bridge.ts`, which entangled the
 * hub (scheduler, run registry, reviewer, hub CLI) with the vendored-Cline TUI
 * bridge. They are relocated here so the hub-owned control plane does not
 * depend on the Cline bridge module. W050 plan step C1.
 */

export type WorkflowApplicationResolver = (
  workspace?: string,
  runId?: string,
  options?: { activateInteractiveTask?: boolean },
) => WorkflowApplication;

export interface WorkflowRunController {
  begin(input: {
    runId: string;
    title: string;
    workspace?: string;
    requiresReview?: boolean;
    taskPrompt?: string;
    /** W153: the recorded origin attribution; only hub-side recorders supply it (the scheduler, the W162 board-delegation route). */
    origin?: RunOrigin;
    /** W165: the recorded run→PR work-product link; only hub-side lanes supply it (the W162 board-delegation route) — /run/begin forwards none. */
    workProductLink?: WorkProductLink;
  }): Promise<void>;
  finish(input: { runId: string; outcome: "verified" | "failed" }): Promise<void>;
  review(input: { runId: string; reviewerRunId: string; verdict: "approved" | "changes_requested" | "rejected"; summary: string }): Promise<{ recorded: boolean }>;
  /**
   * W171: records a discovered work-product reference — the provider-owned
   * fact the /board/tasks discovery lane observed in its OWN timeline read
   * (exactly-one cross-referenced PR). Only hub-side lanes call it, the same
   * discipline as begin's workProductLink; the client never supplies it.
   */
  recordWorkProductLink?(input: { readonly runId: string; readonly link: WorkProductLink }): void;
  /**
   * W162 slice 2: the ACTIVE run ids — registry membership, bounded to the
   * most recent 64 in begin order (the transitionLogs bound). The
   * /board/tasks in_progress join keys on this registry fact, never a
   * timestamp heuristic; absent on a controller predating the slice (the
   * honest subset: no authority, no field, no column).
   */
  activeRunIds?(): readonly string[];
  hiddenSnapshotTaskIds(): readonly string[];
  /**
   * Plan Task A3: optional run-gate observability surfaced on /snapshot for
   * hub-attached monitors. Observation only — canonical state never moves
   * through this path.
   */
  gateObservability?(): {
    reviewOutcomes: ReadonlyMap<string, { readonly reviewerRunId: string; readonly verdict: string; readonly recorded: boolean; readonly summary: string; readonly parseFailure?: string }>;
    blockingReasons: ReadonlyMap<string, string>;
    completionClaims: ReadonlyMap<string, { readonly runId: string; readonly claim: string; readonly verifiedAtClaim: boolean; readonly observedAt: string }>;
    /** Iteration 21: advisory reasoning-claim findings (observability-only; never evidence). */
    reasoningClaims?: ReadonlyMap<string, { readonly runId: string; readonly sentence: string; readonly observedAt: string }>;
    /** Iteration 21: honest monitor metrics (recall/time-to-response explicitly unmeasured). */
    reasoningClaimMetrics?: {
      readonly monitoredRuns: number;
      readonly flaggedRuns: number;
      readonly findings: number;
      readonly recall: "unmeasured";
      readonly timeToResponseMs: "unmeasured";
    };
    /** W044 (open clause): per-run usage from the metering proxy (hub-side aggregation). */
    runUsage?: ReadonlyMap<string, import("./run-registry.js").RunUsageSummary>;
    /** W153: recorded schedule-origin attribution per run (observability-only). */
    runOrigins?: ReadonlyMap<string, import("./run-registry.js").RunOrigin>;
    /** W165: recorded run→PR work-product links per run (observability-only). */
    workProductLinks?: ReadonlyMap<string, import("./run-registry.js").WorkProductLink>;
    /**
     * W175: the recorded begin times — the begin transition's own attribution
     * observedAt per run, bounded 64 like the sibling maps. The /api/runs rows
     * carry startedAt only where this record has one; a run without a record
     * renders the named absence, never a derived timestamp.
     */
    runStarts?: ReadonlyMap<string, string>;
    /**
     * W152: the per-run kernel transition logs, bounded to the most recent 64
     * runs like the other observability maps. Each entry is that run's own
     * application history (the kernel transition log is per application
     * instance — workflow.ts `#history` — and each run composes its own), so
     * the unified timeline can render run begin/finish rows without the
     * kernel synthesizing attribution it does not record.
     */
    transitionLogs?: ReadonlyMap<string, readonly import("../kernel/contracts.js").TransitionRecord[]>;
  };
}

/**
 * Contained shell executor for a workspace-bound application. The hub-owned
 * run gates use this for git-diff sourcing (read-only) and test execution
 * (writable); it composes application authorization with the containment
 * backend, exactly like the hub `/bash` route.
 */
export function shellExecutorFor(
  application: WorkflowApplication,
  fixedTaskId?: TaskId,
  writableWorkspace = true,
  guard?: WorkflowGuardProvider,
  timeoutMs?: number,
): WorkflowContainedShellExecutor {
  return createContainedShellExecutor(
    new WorkflowContainedProcess(application, selectContainment(), guard),
    {
      capabilities: hostCapabilities({ transport: "native", authoritativePreMutation: true }),
      sessionId: "workflow-tui",
      taskId: fixedTaskId ?? (() => application.activeTaskId()),
      commandExitError: (exitCode, output) => Object.assign(new Error(output), { exitCode }),
      writableWorkspace,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  );
}
