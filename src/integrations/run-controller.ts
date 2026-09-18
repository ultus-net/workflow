import { ClineHostAdapter } from "../adapters/cline.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { WorkflowContainedProcess } from "../containment/workflow-process.js";
import { selectContainment } from "../containment/platform.js";
import type { TaskId } from "../kernel/contracts.js";
import { createWorkflowClineShellExecutor, type WorkflowClineShellExecutor } from "./cline-shell-executor.js";
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
  begin(input: { runId: string; title: string; workspace?: string; requiresReview?: boolean; taskPrompt?: string }): Promise<void>;
  finish(input: { runId: string; outcome: "verified" | "failed" }): Promise<void>;
  review(input: { runId: string; reviewerRunId: string; verdict: "approved" | "changes_requested" | "rejected"; summary: string }): Promise<{ recorded: boolean }>;
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
    /** W044 (open clause): per-run usage from the metering proxy (hub-side aggregation). */
    runUsage?: ReadonlyMap<string, import("./run-registry.js").RunUsageSummary>;
  };
}

export function adapterFor(application: WorkflowApplication, fixedTaskId?: TaskId): ClineHostAdapter {
  return new ClineHostAdapter({
    sessionId: "workflow-tui",
    taskId: () => fixedTaskId ?? application.activeTaskId(),
    isMutatingTool: () => false,
    authoritativePreMutation: true,
  });
}

/**
 * Contained shell executor for a workspace-bound application. The hub-owned
 * run gates use this for git-diff sourcing (read-only) and test execution
 * (writable); it composes application authorization with the containment
 * backend, exactly like the bridge `/bash` route.
 */
export function shellExecutorFor(
  application: WorkflowApplication,
  fixedTaskId?: TaskId,
  writableWorkspace = true,
  guard?: WorkflowGuardProvider,
): WorkflowClineShellExecutor {
  return createWorkflowClineShellExecutor(
    new WorkflowContainedProcess(application, selectContainment(), guard),
    adapterFor(application, fixedTaskId),
    (exitCode, output) => Object.assign(new Error(output), { exitCode }),
    undefined,
    writableWorkspace,
  );
}
