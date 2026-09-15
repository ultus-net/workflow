import { randomUUID } from "node:crypto";

import { buildReviewRubric, countReferencedAxes, MIN_REFERENCED_AXES } from "../review/rubric.js";
import type { WorkflowRunController } from "./cline-tui-bridge.js";

/**
 * Hub-owned reviewer runner (plan Task A1). The hub produces the reviewer run
 * itself instead of depending on a host-side plugin: it sources the diff,
 * prompts a contained reviewer agent with the rubric, and records the verdict
 * through the same run-controller machinery the verifier-token `/run/review`
 * endpoint uses. Verdict parsing fails closed — an unparseable or
 * rubber-stamped (too few axis references) review can never promote a run.
 */

export type ReviewerShellCommand = (command: string, cwd: string) => Promise<string>;

export type DiffSource = (workspace: string) => Promise<string>;

export interface ReviewerAgentSession {
  review(prompt: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface ReviewerAgentSessionFactory {
  spawn(options: { readonly workspace: string; readonly taskPrompt?: string }): Promise<ReviewerAgentSession>;
}

export interface ParsedReviewVerdict {
  readonly verdict: "approved" | "changes_requested";
  readonly summary: string;
}

export interface HubReviewerResult {
  readonly reviewerRunId: string;
  readonly verdict: "approved" | "changes_requested";
  readonly recorded: boolean;
  readonly summary: string;
  readonly parseFailure?: string;
}

export function parseReviewVerdict(finalMessage: string): ParsedReviewVerdict | undefined {
  const hasApprove = finalMessage.includes("[APPROVE]");
  const hasChanges = finalMessage.includes("[REQUEST_CHANGES]");
  if (hasApprove === hasChanges) return undefined;
  return { verdict: hasApprove ? "approved" : "changes_requested", summary: finalMessage };
}

export function createGitDiffSource(shell: ReviewerShellCommand): DiffSource {
  return (workspace) => shell("git diff HEAD", workspace);
}

export class HubReviewerRunner {
  readonly #controller: WorkflowRunController;
  readonly #diffSource: DiffSource;
  readonly #spawnReviewer: ReviewerAgentSessionFactory;

  constructor(options: {
    readonly controller: WorkflowRunController;
    readonly diffSource: DiffSource;
    readonly spawnReviewer: ReviewerAgentSessionFactory;
  }) {
    this.#controller = options.controller;
    this.#diffSource = options.diffSource;
    this.#spawnReviewer = options.spawnReviewer;
  }

  async reviewRun(input: {
    readonly runId: string;
    readonly workspace: string;
    readonly taskPrompt?: string;
  }): Promise<HubReviewerResult> {
    const diffText = await this.#diffSource(input.workspace);
    // The reviewer is its own registered run so the registry's
    // anti-rubber-stamp checks (existing, distinct reviewer) hold by construction.
    const reviewerRunId = `schedule:hub-reviewer-${randomUUID()}`;
    await this.#controller.begin({ runId: reviewerRunId, title: "Hub reviewer run", workspace: input.workspace });
    const prompt = buildReviewRubric({ diffText, ...(input.taskPrompt === undefined ? {} : { taskPrompt: input.taskPrompt }) });
    const session = await this.#spawnReviewer.spawn({
      workspace: input.workspace,
      ...(input.taskPrompt === undefined ? {} : { taskPrompt: input.taskPrompt }),
    });
    let finalMessage: string;
    try {
      finalMessage = await session.review(prompt);
    } finally {
      await session.dispose();
    }
    const parsed = parseReviewVerdict(finalMessage);
    if (parsed === undefined) {
      return this.#recordFailClosed(input.runId, reviewerRunId, finalMessage, `unparseable reviewer verdict: ${finalMessage.slice(0, 200)}`);
    }
    if (parsed.verdict === "approved" && countReferencedAxes(parsed.summary) < MIN_REFERENCED_AXES) {
      return this.#recordFailClosed(
        input.runId,
        reviewerRunId,
        parsed.summary,
        `approved review summary must reference at least ${MIN_REFERENCED_AXES} of the 5 axes (found ${countReferencedAxes(parsed.summary)})`,
      );
    }
    const recorded = await this.#controller.review({
      runId: input.runId,
      reviewerRunId,
      verdict: parsed.verdict,
      summary: parsed.summary,
    });
    // Plain reviewer run: its job is done once the verdict is recorded.
    await this.#controller.finish({ runId: reviewerRunId, outcome: "verified" });
    return { reviewerRunId, verdict: parsed.verdict, recorded: recorded.recorded, summary: parsed.summary };
  }

  async #recordFailClosed(
    runId: string,
    reviewerRunId: string,
    summary: string,
    parseFailure: string,
  ): Promise<HubReviewerResult> {
    const recorded = await this.#controller.review({
      runId,
      reviewerRunId,
      verdict: "changes_requested",
      summary,
    });
    await this.#controller.finish({ runId: reviewerRunId, outcome: "verified" });
    return { reviewerRunId, verdict: "changes_requested", recorded: recorded.recorded, summary, parseFailure };
  }
}
