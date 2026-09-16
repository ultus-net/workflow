import {
  HubReviewerRunner,
  createGitDiffSource,
  createGitStatusSource,
  type ReviewerAgentSessionFactory,
} from "./hub-reviewer.js";
import type { RunReviewer, RunReviewerFactory, RunTestRunner } from "./run-registry.js";

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
  readonly createRuntime: (input: { readonly workspace: string; readonly taskPrompt?: string }) => Promise<ReviewerRuntimeSession>;
}): RunReviewerFactory {
  return (controller) => {
    const spawnReviewer: ReviewerAgentSessionFactory = {
      async spawn(input) {
        if (input.workspace === undefined || input.workspace.length === 0) {
          throw new Error("hub reviewer requires a workspace");
        }
        const runtime = await options.createRuntime(input);
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
        };
      },
    };
    const runner = new HubReviewerRunner({
      controller,
      diffSource: (workspace) => createGitDiffSource(options.shell)(workspace),
      statusSource: (workspace) => createGitStatusSource(options.shell)(workspace),
      spawnReviewer,
    });
    const reviewer: RunReviewer = async (input) => {
      const { workspace } = input;
      if (workspace === undefined) throw new Error("hub reviewer requires a workspace");
      return runner.reviewRun({ runId: input.runId, workspace });
    };
    return reviewer;
  };
}
