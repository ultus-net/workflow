import {
  HubReviewerRunner,
  createGitCommitSource,
  createGitDiffSource,
  createGitStatusSource,
  type ReviewerAgentSessionFactory,
} from "./hub-reviewer.js";
import { createJsonReviewProvenanceStore, type ReviewProvenanceStore } from "./review-provenance-store.js";
import type { RunReviewer, RunReviewerFactory, RunTestRunner } from "./run-registry.js";
import type { TaskUsageSummary } from "./task-usage.js";
import { taskId, type TaskId } from "../kernel/contracts.js";

/**
 * W111 (issue #283): the reviewer runtime's active-task correlation — the
 * reviewer RUN's canonical kernel task (`run:<reviewerRunId>`), the exact id
 * the per-task view joins (`taskUsageForRun`). The reviewer session task
 * (`hub-reviewer:<id>`) stays #134 lifecycle bookkeeping only, so a completed
 * reviewer turn's delta renders under the reviewer run instead of the phantom
 * session task.
 */
export function reviewerRunTaskId(reviewerRunId: string): TaskId {
  return taskId(`run:${reviewerRunId}`);
}

/**
 * Production wiring for the hub-owned run gates (plan Tasks A2/D1). Both
 * compositions take their host machinery as injected seams: the contained
 * shell (git diff/status sourcing, test execution) and the reviewer runtime
 * (contained ACP agent in production). The hub CLI composes them with the
 * real pieces; tests stub them.
 */

/** Minimal runtime surface the reviewer adapter needs (WorkflowCodingSession-shaped). */
export interface ReviewerRuntimeSession {
  submit(prompt: string): Promise<void>;
  snapshot(): { readonly state: string; readonly result?: string; readonly reason?: string };
  dispose(): Promise<void>;
  /**
   * #134: the kernel-graph bookkeeping task the runtime opened (the
   * `hub-reviewer:<id>` task). The adapter forwards it onto the spawned
   * reviewer session so the runner can close it — completed when review()
   * returns, failed when it throws. Optional: runtimes that open no kernel
   * task omit it. Implementations must be terminal-safe.
   */
  endTask?(outcome: "completed" | "failed"): void;
}

export function createRunTestRunner(options: {
  readonly command: string;
  readonly shell: (command: string, cwd: string) => Promise<string>;
}): RunTestRunner {
  return async (input) => {
    if (input.workspace === undefined) {
      return { passed: false, output: "run declared no workspace; cannot execute the test command" };
    }
    try {
      const output = await options.shell(options.command, input.workspace);
      return { passed: true, output };
    } catch (error) {
      return { passed: false, output: error instanceof Error ? error.message : String(error) };
    }
  };
}

export function createReviewerFactory(options: {
  readonly shell: (command: string, cwd: string) => Promise<string>;
  readonly createRuntime: (input: {
    readonly workspace: string;
    readonly taskPrompt?: string;
    /**
     * W111 (issue #283): the reviewer run the runtime is reviewing for — the
     * composition root binds the runtime's active-task correlation to this
     * run's canonical `run:<reviewerRunId>` kernel task so the completed-turn
     * delta joins the reviewer run in the per-task view.
     */
    readonly reviewerRunId: string;
    /**
     * W111 (issue #283): the registry's per-task journal writer, forwarded
     * from the factory's second argument so the reviewer runtime can supply
     * `AcpRuntimeOptions.taskUsage`. A stub that ignores it stays valid.
     */
    readonly recordTaskUsage: (input: Omit<TaskUsageSummary, "recordedAt">) => void;
  }) => Promise<ReviewerRuntimeSession>;
  /** When set, review provenance (W041) is journaled at this hub-state path. */
  readonly provenancePath?: string;
  /**
   * W177: the SHARED store instance the composition root also reads the audit
   * lane from — one journal, one store, so the writer (the reviewer) and the
   * reader (the /snapshot audit block) bind the same path. Given, it wins
   * over provenancePath; neither set means no journaling.
   */
  readonly provenanceStore?: ReviewProvenanceStore;
}): RunReviewerFactory {
  const provenanceStore = options.provenanceStore
    ?? (options.provenancePath === undefined ? undefined : createJsonReviewProvenanceStore(options.provenancePath));
  return (controller, recordTaskUsage) => {
    const spawnReviewer: ReviewerAgentSessionFactory = {
      async spawn(input) {
        if (input.workspace === undefined || input.workspace.length === 0) {
          throw new Error("hub reviewer requires a workspace");
        }
        const runtime = await options.createRuntime({ ...input, recordTaskUsage });
        return {
          review: async (prompt: string) => {
            await runtime.submit(prompt);
            const snapshot = runtime.snapshot();
            if (snapshot.state !== "completed" || typeof snapshot.result !== "string") {
              const reason = snapshot.state === "failed" && typeof snapshot.reason === "string"
                ? `: ${snapshot.reason}`
                : "";
              throw new Error(`reviewer turn did not complete (state: ${snapshot.state}${reason})`);
            }
            return snapshot.result;
          },
          dispose: () => runtime.dispose(),
          // #134: forward the runtime's kernel-task closer — dropping it here
          // (the round-1 review's P0) left the hub-reviewer task IN_PROGRESS
          // forever in production while every stub-composed test stayed green.
          ...(runtime.endTask === undefined ? {} : { endTask: (outcome: "completed" | "failed") => runtime.endTask?.(outcome) }),
        };
      },
    };
    const runner = new HubReviewerRunner({
      controller,
      diffSource: (workspace) => createGitDiffSource(options.shell)(workspace),
      statusSource: (workspace) => createGitStatusSource(options.shell)(workspace),
      commitSource: (workspace) => createGitCommitSource(options.shell)(workspace),
      ...(provenanceStore === undefined ? {} : { provenanceStore }),
      spawnReviewer,
    });
    const reviewer: RunReviewer = async (input) => {
      const { workspace, taskPrompt } = input;
      if (workspace === undefined) throw new Error("hub reviewer requires a workspace");
      return runner.reviewRun({
        runId: input.runId,
        workspace,
        ...(taskPrompt === undefined ? {} : { taskPrompt }),
      });
    };
    return reviewer;
  };
}
