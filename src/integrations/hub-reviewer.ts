import { randomUUID } from "node:crypto";

import { buildReviewRubric, countReferencedAxes, MIN_REFERENCED_AXES } from "../review/rubric.js";
import { deriveReviewCoverageManifest, renderReviewManifestText, reviewCoverageGaps } from "../review/manifest.js";
import {
  partitionReviewManifest,
  renderIntegrationUnitText,
  renderReviewUnitText,
  type ReviewPartition,
} from "../review/partition.js";
import type { WorkflowRunController } from "./cline-tui-bridge.js";

/**
 * Hub-owned reviewer runner (plan Task A1). The hub produces the reviewer run
 * itself instead of depending on a host-side plugin: it sources the diff,
 * prompts a contained reviewer agent with the rubric, and records the verdict
 * through the same run-controller machinery the verifier-token `/run/review`
 * endpoint uses. Verdict parsing fails closed — an unparseable or
 * rubber-stamped (too few axis references) review can never promote a run.
 * With a status source wired (W039), review scope is a deterministic
 * manifest — every changed/untracked file with obligations — and an
 * approval that does not cover every manifest entry fails closed too.
 * With more than one review unit in that manifest (W040), the runner reviews
 * each unit with a fresh isolated reviewer session carrying only that unit's
 * focused rules, plus one integration review for cross-unit behavior; every
 * unit must approve with complete [COVERAGE] before the run's single
 * recorded verdict is approved.
 */

export type ReviewerShellCommand = (command: string, cwd: string) => Promise<string>;

export type DiffSource = (workspace: string) => Promise<string>;

/** Raw `git status --porcelain=v1 -z --untracked-files=all` output source. */
export type StatusSource = (workspace: string) => Promise<string>;

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
  /** Manifest paths (or unit ids, for the integration review) claimed covered via [COVERAGE]. */
  readonly coveredPaths: readonly string[];
}

export interface HubReviewerResult {
  readonly reviewerRunId: string;
  readonly verdict: "approved" | "changes_requested";
  readonly recorded: boolean;
  readonly summary: string;
  readonly parseFailure?: string;
}

export const REVIEW_COVERAGE_TOKEN = "[COVERAGE]";

/**
 * Extracts the manifest paths from the final [COVERAGE] line. The last
 * [COVERAGE] line wins (the rubric instruction text may be quoted earlier);
 * a missing line means no covered paths — approvals then fail closed.
 */
export function parseReviewCoverage(finalMessage: string): readonly string[] {
  const lines = finalMessage.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line !== undefined && line.startsWith(REVIEW_COVERAGE_TOKEN)) {
      return line
        .slice(REVIEW_COVERAGE_TOKEN.length)
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    }
  }
  return [];
}

export function parseReviewVerdict(finalMessage: string): ParsedReviewVerdict | undefined {
  const hasApprove = finalMessage.includes("[APPROVE]");
  const hasChanges = finalMessage.includes("[REQUEST_CHANGES]");
  if (hasApprove === hasChanges) return undefined;
  return {
    verdict: hasApprove ? "approved" : "changes_requested",
    summary: finalMessage,
    coveredPaths: parseReviewCoverage(finalMessage),
  };
}

export function createGitDiffSource(shell: ReviewerShellCommand): DiffSource {
  return (workspace) => shell("git diff HEAD", workspace);
}

export function createGitStatusSource(shell: ReviewerShellCommand): StatusSource {
  return (workspace) => shell("git status --porcelain=v1 -z --untracked-files=all", workspace);
}

/** One isolated reviewer session over one unit's scope; fail-closed outcome shape. */
type UnitReviewOutcome =
  | { readonly parsed: ParsedReviewVerdict; readonly parseFailure?: undefined }
  | { readonly parsed?: undefined; readonly parseFailure: string; readonly summary: string };

export class HubReviewerRunner {
  readonly #controller: WorkflowRunController;
  readonly #diffSource: DiffSource;
  readonly #statusSource: StatusSource | undefined;
  readonly #spawnReviewer: ReviewerAgentSessionFactory;

  constructor(options: {
    readonly controller: WorkflowRunController;
    readonly diffSource: DiffSource;
    /** When wired, review scope becomes the deterministic W039 manifest. */
    readonly statusSource?: StatusSource;
    readonly spawnReviewer: ReviewerAgentSessionFactory;
  }) {
    this.#controller = options.controller;
    this.#diffSource = options.diffSource;
    this.#statusSource = options.statusSource;
    this.#spawnReviewer = options.spawnReviewer;
  }

  async reviewRun(input: {
    readonly runId: string;
    readonly workspace: string;
    readonly taskPrompt?: string;
  }): Promise<HubReviewerResult> {
    const diffText = await this.#diffSource(input.workspace);
    const statusOutput = this.#statusSource === undefined ? undefined : await this.#statusSource(input.workspace);
    const manifest = statusOutput === undefined ? undefined : deriveReviewCoverageManifest({ statusOutput });
    const partition = manifest === undefined ? undefined : partitionReviewManifest(manifest);
    // The reviewer is its own registered run so the registry's
    // anti-rubber-stamp checks (existing, distinct reviewer) hold by construction.
    const reviewerRunId = `schedule:hub-reviewer-${randomUUID()}`;
    await this.#controller.begin({ runId: reviewerRunId, title: "Hub reviewer run", workspace: input.workspace });
    try {
      // W040: multi-component scope is reviewed unit by unit (fresh isolated
      // sessions, focused rules, one integration review), all fail-closed.
      if (manifest !== undefined && partition !== undefined && partition.units.length > 1) {
        return await this.#reviewPartitioned(input, reviewerRunId, diffText, manifest, partition);
      }
      const prompt = buildReviewRubric({
        diffText,
        ...(input.taskPrompt === undefined ? {} : { taskPrompt: input.taskPrompt }),
        ...(manifest === undefined ? {} : { manifestText: renderReviewManifestText(manifest) }),
      });
      const session = await this.#spawnReviewer.spawn({
        workspace: input.workspace,
        ...(input.taskPrompt === undefined ? {} : { taskPrompt: input.taskPrompt }),
      });
      let finalMessage: string;
      try {
        finalMessage = await session.review(prompt);
      } finally {
        try {
          await session.dispose();
        } catch {
          // Dispose failure must not mask the review outcome.
        }
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
      // W039 coverage gate: an approval cannot report complete coverage while
      // required manifest entries remain unreviewed. A changes_requested
      // verdict is never gated on coverage — it is already a rejection.
      if (parsed.verdict === "approved" && manifest !== undefined) {
        const gaps = reviewCoverageGaps({ manifest, coveredPaths: parsed.coveredPaths });
        if (gaps.length > 0) {
          return this.#recordFailClosed(
            input.runId,
            reviewerRunId,
            parsed.summary,
            `approved review coverage is incomplete: ${gaps.length} manifest path(s) missing from the [COVERAGE] line: ${gaps.slice(0, 10).join(", ")}${gaps.length > 10 ? ", ..." : ""}`,
          );
        }
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
    } catch (error) {
      // Infrastructure failure: the begun reviewer run must not leak an
      // IN_PROGRESS task into the shared graph — close it as failed.
      await this.#controller.finish({ runId: reviewerRunId, outcome: "failed" }).catch(() => undefined);
      throw error;
    }
  }

  async #reviewPartitioned(
    input: { readonly runId: string; readonly workspace: string; readonly taskPrompt?: string },
    reviewerRunId: string,
    diffText: string,
    manifest: ReturnType<typeof deriveReviewCoverageManifest>,
    partition: ReviewPartition,
  ): Promise<HubReviewerResult> {
    for (const unit of partition.units) {
      const outcome = await this.#reviewOneUnit(input, diffText, renderReviewUnitText(unit));
      const failure = this.#unitFailure(unit.id, outcome, unit.paths);
      if (failure !== undefined) {
        return this.#recordFailClosed(input.runId, reviewerRunId, this.#outcomeSummary(outcome), failure);
      }
    }
    if (partition.integration !== undefined) {
      const outcome = await this.#reviewOneUnit(input, diffText, renderIntegrationUnitText(partition));
      const unitIds = partition.units.map((unit) => unit.id);
      const failure = this.#unitFailure("integration", outcome, unitIds);
      if (failure !== undefined) {
        return this.#recordFailClosed(input.runId, reviewerRunId, this.#outcomeSummary(outcome), failure);
      }
    }
    // Belt and braces: every unit approved with full coverage, so the union
    // covers the whole manifest — the W039 gate must still hold structurally.
    const union = partition.units.flatMap((unit) => unit.paths);
    const gaps = reviewCoverageGaps({ manifest, coveredPaths: union });
    if (gaps.length > 0) {
      return this.#recordFailClosed(
        input.runId,
        reviewerRunId,
        "partitioned review coverage union is incomplete",
        `approved partitioned review does not cover the manifest: ${gaps.slice(0, 10).join(", ")}${gaps.length > 10 ? ", ..." : ""}`,
      );
    }
    const summary = [
      `Partitioned review approved across ${partition.units.length} unit(s)${partition.integration === undefined ? "" : " + integration"}.`,
      "Axes evaluated per unit: test integrity, task completeness, cleanliness, security, platform.",
      `Units: ${partition.units.map((unit) => unit.id).join(", ")}.`,
      `Manifest digest: ${manifest.digest}; partition digest: ${partition.digest}.`,
    ].join(" ");
    const recorded = await this.#controller.review({
      runId: input.runId,
      reviewerRunId,
      verdict: "approved",
      summary,
    });
    await this.#controller.finish({ runId: reviewerRunId, outcome: "verified" });
    return { reviewerRunId, verdict: "approved", recorded: recorded.recorded, summary };
  }

  /** Runs one isolated reviewer session over one unit's scope; verdict reasons never throw. */
  async #reviewOneUnit(
    input: { readonly workspace: string; readonly taskPrompt?: string },
    diffText: string,
    scopeText: string,
  ): Promise<UnitReviewOutcome> {
    const prompt = buildReviewRubric({
      diffText,
      ...(input.taskPrompt === undefined ? {} : { taskPrompt: input.taskPrompt }),
      manifestText: scopeText,
    });
    const session = await this.#spawnReviewer.spawn({
      workspace: input.workspace,
      ...(input.taskPrompt === undefined ? {} : { taskPrompt: input.taskPrompt }),
    });
    let finalMessage: string;
    try {
      finalMessage = await session.review(prompt);
    } finally {
      try {
        await session.dispose();
      } catch {
        // Dispose failure must not mask the review outcome.
      }
    }
    const parsed = parseReviewVerdict(finalMessage);
    if (parsed === undefined) {
      return { parseFailure: `unparseable reviewer verdict: ${finalMessage.slice(0, 200)}`, summary: finalMessage };
    }
    if (parsed.verdict === "approved" && countReferencedAxes(parsed.summary) < MIN_REFERENCED_AXES) {
      return {
        parseFailure: `approved review summary must reference at least ${MIN_REFERENCED_AXES} of the 5 axes (found ${countReferencedAxes(parsed.summary)})`,
        summary: parsed.summary,
      };
    }
    return { parsed };
  }

  /** Fail-closed reason for one unit's outcome, or undefined when it approved with full coverage. */
  #unitFailure(unitId: string, outcome: UnitReviewOutcome, requiredCoverage: readonly string[]): string | undefined {
    if (outcome.parseFailure !== undefined) {
      return `unit ${unitId}: ${outcome.parseFailure}`;
    }
    const parsed = outcome.parsed!;
    if (parsed.verdict !== "approved") {
      return `unit ${unitId}: changes requested by unit review`;
    }
    const missing = requiredCoverage.filter((path) => !parsed.coveredPaths.includes(path));
    if (missing.length > 0) {
      return `unit ${unitId}: approved review coverage is incomplete: ${missing.length} required entr${missing.length === 1 ? "y" : "ies"} missing from the [COVERAGE] line: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}`;
    }
    return undefined;
  }

  #outcomeSummary(outcome: UnitReviewOutcome): string {
    return outcome.parsed === undefined ? outcome.summary : outcome.parsed.summary;
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
