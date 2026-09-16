import { randomUUID } from "node:crypto";

import { buildReviewRubric, countReferencedAxes, MIN_REFERENCED_AXES } from "../review/rubric.js";
import { deriveReviewCoverageManifest, renderReviewManifestText, reviewCoverageGaps } from "../review/manifest.js";
import {
  partitionReviewManifest,
  renderIntegrationUnitText,
  renderReviewUnitText,
  type ReviewPartition,
} from "../review/partition.js";
import {
  INTEGRATION_PROVENANCE_UNIT_ID,
  resumableUnitCoverage,
  reviewDiffDigest,
  reviewPromptDigest,
  reviewRuleSetDigest,
  type ReviewDisposition,
  type ReviewProvenanceFingerprint,
} from "../review/provenance.js";
import type { ReviewProvenanceStore } from "./review-provenance-store.js";
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
 * recorded verdict is approved. With a provenance store wired (W041), every
 * decision is journaled bound to its fingerprint (commit, prompt, manifest,
 * partition, rule set), and interrupted partitioned reviews resume only the
 * units whose fingerprint still matches exactly — stale evidence stays
 * history and can never approve new mutations.
 */

export type ReviewerShellCommand = (command: string, cwd: string) => Promise<string>;

export type DiffSource = (workspace: string) => Promise<string>;

/** Raw `git status --porcelain=v1 -z --untracked-files=all` output source. */
export type StatusSource = (workspace: string) => Promise<string>;

/** HEAD commit hash source; failures resolve to undefined (unborn HEAD is not fatal). */
export type CommitSource = (workspace: string) => Promise<string | undefined>;

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

export function createGitCommitSource(shell: ReviewerShellCommand): CommitSource {
  return async (workspace) => {
    try {
      return (await shell("git rev-parse HEAD", workspace)).trim();
    } catch {
      // Unborn HEAD (or no git at all) is not fatal: the manifest, partition,
      // prompt, and rule-set digests still bind the review to its scope.
      return undefined;
    }
  };
}

/** One isolated reviewer session over one unit's scope; fail-closed outcome shape. */
type UnitReviewOutcome =
  | { readonly parsed: ParsedReviewVerdict; readonly parseFailure?: undefined }
  | { readonly parsed?: undefined; readonly parseFailure: string; readonly summary: string };

/** Per-decision provenance detail the runner journals (W041). */
interface ProvenanceDetail {
  readonly inspectedUnits: readonly string[];
  readonly coveredPaths: readonly string[];
  readonly verification: readonly string[];
}

export class HubReviewerRunner {
  readonly #controller: WorkflowRunController;
  readonly #diffSource: DiffSource;
  readonly #statusSource: StatusSource | undefined;
  readonly #commitSource: CommitSource | undefined;
  readonly #provenanceStore: ReviewProvenanceStore | undefined;
  readonly #spawnReviewer: ReviewerAgentSessionFactory;

  constructor(options: {
    readonly controller: WorkflowRunController;
    readonly diffSource: DiffSource;
    /** When wired, review scope becomes the deterministic W039 manifest. */
    readonly statusSource?: StatusSource;
    /** When wired, the HEAD commit joins the provenance fingerprint. */
    readonly commitSource?: CommitSource;
    /** When wired, every review decision is journaled with its fingerprint (W041). */
    readonly provenanceStore?: ReviewProvenanceStore;
    readonly spawnReviewer: ReviewerAgentSessionFactory;
  }) {
    this.#controller = options.controller;
    this.#diffSource = options.diffSource;
    this.#statusSource = options.statusSource;
    this.#commitSource = options.commitSource;
    this.#provenanceStore = options.provenanceStore;
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
    const commitHash = this.#commitSource === undefined || manifest === undefined
      ? undefined
      : await this.#commitSource(input.workspace);
    // W041 fingerprint: binds the review to the exact commit, ask, diff
    // content, scope, partition, and rule set. Records exist only when the
    // manifest (scope) is derived — diff-only compositions journal nothing,
    // honestly.
    const fingerprint: ReviewProvenanceFingerprint | undefined = manifest === undefined || partition === undefined
      ? undefined
      : {
        commitHash,
        promptDigest: reviewPromptDigest(input.taskPrompt),
        diffDigest: reviewDiffDigest(diffText),
        manifestDigest: manifest.digest,
        partitionDigest: partition.digest,
        ruleSetDigest: reviewRuleSetDigest(),
      };
    // The reviewer is its own registered run so the registry's
    // anti-rubber-stamp checks (existing, distinct reviewer) hold by construction.
    const reviewerRunId = `schedule:hub-reviewer-${randomUUID()}`;
    await this.#controller.begin({ runId: reviewerRunId, title: "Hub reviewer run", workspace: input.workspace });
    try {
      // W040: multi-component scope is reviewed unit by unit (fresh isolated
      // sessions, focused rules, one integration review), all fail-closed.
      if (manifest !== undefined && partition !== undefined && partition.units.length > 1) {
        return await this.#reviewPartitioned(input, reviewerRunId, diffText, manifest, partition, fingerprint);
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
        return this.#recordFailClosed(input, reviewerRunId, fingerprint, finalMessage, `unparseable reviewer verdict: ${finalMessage.slice(0, 200)}`, {
          inspectedUnits: ["manifest"],
          coveredPaths: [],
          verification: ["fail-closed: unparseable verdict"],
        });
      }
      if (parsed.verdict === "approved" && countReferencedAxes(parsed.summary) < MIN_REFERENCED_AXES) {
        return this.#recordFailClosed(
          input,
          reviewerRunId,
          fingerprint,
          parsed.summary,
          `approved review summary must reference at least ${MIN_REFERENCED_AXES} of the 5 axes (found ${countReferencedAxes(parsed.summary)})`,
          {
            inspectedUnits: ["manifest"],
            coveredPaths: parsed.coveredPaths,
            verification: [`axes: ${countReferencedAxes(parsed.summary)}/5 (below the ${MIN_REFERENCED_AXES} minimum)`],
          },
        );
      }
      // W039 coverage gate: an approval cannot report complete coverage while
      // required manifest entries remain unreviewed. A changes_requested
      // verdict is never gated on coverage — it is already a rejection.
      let coverageGaps: readonly string[] = [];
      if (parsed.verdict === "approved" && manifest !== undefined) {
        coverageGaps = reviewCoverageGaps({ manifest, coveredPaths: parsed.coveredPaths });
        if (coverageGaps.length > 0) {
          return this.#recordFailClosed(
            input,
            reviewerRunId,
            fingerprint,
            parsed.summary,
            `approved review coverage is incomplete: ${coverageGaps.length} manifest path(s) missing from the [COVERAGE] line: ${coverageGaps.slice(0, 10).join(", ")}${coverageGaps.length > 10 ? ", ..." : ""}`,
            {
              inspectedUnits: ["manifest"],
              coveredPaths: parsed.coveredPaths,
              verification: [`axes: ${countReferencedAxes(parsed.summary)}/5`, `coverage gaps: ${coverageGaps.length}`],
            },
          );
        }
      }
      // W041: journal the decision BEFORE it is recorded — an approval that
      // cannot be provenanced is never recorded (append failures fail closed).
      await this.#appendProvenance(input, reviewerRunId, fingerprint, {
        inspectedUnits: ["manifest"],
        coveredPaths: parsed.coveredPaths,
        findings: parsed.summary.slice(0, 4000),
        verification: [
          `axes: ${countReferencedAxes(parsed.summary)}/5`,
          parsed.verdict === "approved" ? `coverage gaps: ${coverageGaps.length}` : "verdict: changes_requested (not coverage-gated)",
        ],
        disposition: parsed.verdict,
      });
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
      // W041: journal the interruption best-effort — it must never mask the
      // original failure. An interrupted record is history, never approval.
      await this.#appendProvenance(input, reviewerRunId, fingerprint, {
        inspectedUnits: ["interrupted"],
        coveredPaths: [],
        findings: `interrupted: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000),
        verification: ["review aborted before a verdict"],
        disposition: "interrupted",
      }).catch(() => undefined);
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
    fingerprint: ReviewProvenanceFingerprint | undefined,
  ): Promise<HubReviewerResult> {
    // W041 resume: units whose newest record is an approval with complete
    // coverage under the EXACT current fingerprint are not re-reviewed. Any
    // change — commit, prompt, scope, partition, or rules — resumes nothing,
    // and records from other workspaces never apply here: identical
    // fingerprints can exist across clones, but only this workspace's own
    // provenance may replay into this review.
    const priorRecords = fingerprint === undefined || this.#provenanceStore === undefined
      ? []
      : (await this.#provenanceStore.records()).filter((record) => record.workspace === input.workspace);
    const resumable = fingerprint === undefined
      ? new Map<string, readonly string[]>()
      : resumableUnitCoverage({
        records: priorRecords,
        fingerprint,
        units: [
          ...partition.units.map((unit) => ({ id: unit.id, requiredCoverage: unit.paths })),
          { id: INTEGRATION_PROVENANCE_UNIT_ID, requiredCoverage: partition.units.map((unit) => unit.id) },
        ],
      });
    let resumedCount = 0;
    for (const unit of partition.units) {
      const prior = resumable.get(unit.id);
      if (prior !== undefined) {
        resumedCount += 1;
        continue;
      }
      const outcome = await this.#reviewOneUnit(input, diffText, renderReviewUnitText(unit));
      const failure = this.#unitFailure(unit.id, outcome, unit.paths);
      if (failure !== undefined) {
        return this.#recordFailClosed(input, reviewerRunId, fingerprint, this.#outcomeSummary(outcome), failure, {
          inspectedUnits: [unit.id],
          coveredPaths: outcome.parsed?.coveredPaths ?? [],
          verification: [`unit ${unit.id} failed: ${failure.slice(0, 120)}`],
        });
      }
      const parsed = outcome.parsed!;
      await this.#appendProvenance(input, reviewerRunId, fingerprint, {
        inspectedUnits: [unit.id],
        coveredPaths: parsed.coveredPaths,
        findings: parsed.summary.slice(0, 4000),
        verification: [
          `axes: ${countReferencedAxes(parsed.summary)}/5 (min ${MIN_REFERENCED_AXES})`,
          `coverage: ${unit.paths.length}/${unit.paths.length} unit paths`,
        ],
        disposition: "approved",
      });
    }
    if (partition.integration !== undefined) {
      const unitIds = partition.units.map((unit) => unit.id);
      const prior = resumable.get(INTEGRATION_PROVENANCE_UNIT_ID);
      if (prior !== undefined) {
        resumedCount += 1;
      } else {
        const outcome = await this.#reviewOneUnit(input, diffText, renderIntegrationUnitText(partition));
        const failure = this.#unitFailure("integration", outcome, unitIds);
        if (failure !== undefined) {
          return this.#recordFailClosed(input, reviewerRunId, fingerprint, this.#outcomeSummary(outcome), failure, {
            inspectedUnits: [INTEGRATION_PROVENANCE_UNIT_ID],
            coveredPaths: outcome.parsed?.coveredPaths ?? [],
            verification: [`integration review failed: ${failure.slice(0, 120)}`],
          });
        }
        await this.#appendProvenance(input, reviewerRunId, fingerprint, {
          inspectedUnits: [INTEGRATION_PROVENANCE_UNIT_ID],
          coveredPaths: outcome.parsed!.coveredPaths,
          findings: outcome.parsed!.summary.slice(0, 4000),
          verification: [`coverage: ${unitIds.length}/${unitIds.length} unit ids`],
          disposition: "approved",
        });
      }
    }
    // Belt and braces: every unit approved with full coverage, so the union
    // covers the whole manifest — the W039 gate must still hold structurally.
    const union = partition.units.flatMap((unit) => unit.paths);
    const gaps = reviewCoverageGaps({ manifest, coveredPaths: union });
    if (gaps.length > 0) {
      return this.#recordFailClosed(
        input,
        reviewerRunId,
        fingerprint,
        "partitioned review coverage union is incomplete",
        `approved partitioned review does not cover the manifest: ${gaps.slice(0, 10).join(", ")}${gaps.length > 10 ? ", ..." : ""}`,
        {
          inspectedUnits: partition.units.map((unit) => unit.id),
          coveredPaths: union,
          verification: [`coverage union gaps: ${gaps.length}`],
        },
      );
    }
    const summary = [
      `Partitioned review approved across ${partition.units.length} unit(s)${partition.integration === undefined ? "" : " + integration"}.`,
      "Axes evaluated per unit: test integrity, task completeness, cleanliness, security, platform.",
      `Units: ${partition.units.map((unit) => unit.id).join(", ")}.`,
      `Manifest digest: ${manifest.digest}; partition digest: ${partition.digest}.`,
      ...(resumedCount > 0 ? [`Resumed ${resumedCount} unit review(s) from provenance at an identical fingerprint.`] : []),
    ].join(" ");
    await this.#appendProvenance(input, reviewerRunId, fingerprint, {
      inspectedUnits: [
        ...partition.units.map((unit) => unit.id),
        ...(partition.integration === undefined ? [] : [INTEGRATION_PROVENANCE_UNIT_ID]),
      ],
      coveredPaths: union,
      findings: summary,
      verification: [
        `units: ${partition.units.length}${partition.integration === undefined ? "" : " + integration"}`,
        `resumed from provenance: ${resumedCount}`,
        `coverage union: ${union.length}/${manifest.entries.length} manifest paths`,
      ],
      disposition: "approved",
    });
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

  /** Journals one decision; a no-op without a store or a fingerprint (scope-less compositions). */
  async #appendProvenance(
    input: { readonly workspace: string },
    reviewerRunId: string,
    fingerprint: ReviewProvenanceFingerprint | undefined,
    detail: {
      readonly inspectedUnits: readonly string[];
      readonly coveredPaths: readonly string[];
      readonly findings: string;
      readonly verification: readonly string[];
      readonly disposition: ReviewDisposition;
    },
  ): Promise<void> {
    if (this.#provenanceStore === undefined || fingerprint === undefined) return;
    await this.#provenanceStore.append({
      version: 1,
      workspace: input.workspace,
      fingerprint,
      reviewer: reviewerRunId,
      recordedAt: new Date().toISOString(),
      ...detail,
    });
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
    input: { readonly runId: string; readonly workspace: string },
    reviewerRunId: string,
    fingerprint: ReviewProvenanceFingerprint | undefined,
    summary: string,
    parseFailure: string,
    detail?: ProvenanceDetail,
  ): Promise<HubReviewerResult> {
    const recorded = await this.#controller.review({
      runId: input.runId,
      reviewerRunId,
      verdict: "changes_requested",
      summary,
    });
    // Rejections are journaled too — the audit trail records every decision.
    await this.#appendProvenance(input, reviewerRunId, fingerprint, {
      inspectedUnits: detail?.inspectedUnits ?? ["manifest"],
      coveredPaths: detail?.coveredPaths ?? [],
      findings: `${parseFailure}\n${summary}`.slice(0, 4000),
      verification: detail?.verification ?? [`fail-closed: ${parseFailure.slice(0, 120)}`],
      disposition: "changes_requested",
    });
    await this.#controller.finish({ runId: reviewerRunId, outcome: "verified" });
    return { reviewerRunId, verdict: "changes_requested", recorded: recorded.recorded, summary, parseFailure };
  }
}
