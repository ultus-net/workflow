/**
 * Review provenance and replay (TASKS.md W041).
 *
 * Every hub-owned review decision is bound to the exact mutation it judged:
 * the record captures the commit/diff fingerprint (commit hash plus the W039
 * manifest digest and the W040 partition digest), the rule-set version, the
 * reviewer identity, the inspected units, the covered paths, findings, the
 * verification checks that were applied, and the disposition. Later mutations
 * change the fingerprint, so replay of a record can never approve new
 * mutations; interrupted partitioned reviews resume only the units whose
 * fingerprint still matches exactly — stale evidence stays history.
 */

import { createHash } from "node:crypto";

import { MAX_DIFF_CHARS, MIN_REFERENCED_AXES, REVIEW_AXES } from "./rubric.js";
import { REVIEW_OBLIGATION_RULES } from "./manifest.js";
import { BASELINE_REVIEW_RULES, INTEGRATION_REVIEW_RULES, MAX_REVIEW_UNIT_FILES, REVIEW_FOCUS_RULES, REVIEW_RISK_RULES } from "./partition.js";

/**
 * Provenance marker for the cross-unit integration review. NUL-prefixed
 * because git paths can never contain NUL, so no path-derived component id
 * can ever collide with it: a repository with a literal `integration/`
 * directory produces an `integration` unit, and its records stay
 * unambiguously distinct from integration-review records.
 */
export const INTEGRATION_PROVENANCE_UNIT_ID = "\0integration";

export interface ReviewProvenanceFingerprint {
  /** HEAD commit at review time; undefined when the workspace has no commits yet. */
  readonly commitHash: string | undefined;
  /** sha256 of the task prompt — the same diff under a different ask is a different review. */
  readonly promptDigest: string;
  /** sha256 of the tracked diff the reviewer actually saw — binds changed file CONTENT, not just paths. */
  readonly diffDigest: string;
  /** W039 coverage manifest digest — binds the exact changed/untracked scope. */
  readonly manifestDigest: string;
  /** W040 partition digest — binds the unit grouping. */
  readonly partitionDigest: string;
  /** Rule-set version — binds obligation/risk/focus rules that were applied. */
  readonly ruleSetDigest: string;
}

export type ReviewDisposition = "approved" | "changes_requested" | "interrupted";

export interface ReviewProvenanceRecord {
  readonly version: 1;
  /** Canonical workspace the review judged. */
  readonly workspace: string;
  readonly fingerprint: ReviewProvenanceFingerprint;
  /** Reviewer identity (the reviewer run id). */
  readonly reviewer: string;
  /** Inspected unit ids (["<unit>"] per unit, plus "integration" run-level; ["manifest"] for single-session reviews). */
  readonly inspectedUnits: readonly string[];
  /** Paths (or unit ids, for the integration review) the reviewer covered. */
  readonly coveredPaths: readonly string[];
  /** Reviewer findings summary, bounded. */
  readonly findings: string;
  /** Deterministic checks that were applied, as compact human-readable facts. */
  readonly verification: readonly string[];
  readonly disposition: ReviewDisposition;
  readonly recordedAt: string;
}

/**
 * Deterministic digest of every rule and gate constant that shapes a review —
 * the "rule-set version" W041 requires. Changing any rule text, the unit cap,
 * the axis gate, or the diff cap invalidates prior provenance even when the
 * diff is unchanged. (REVIEW_COVERAGE_TOKEN is parsing mechanics, not gate
 * strength: records store already-parsed coverage values, so a token change
 * cannot corrupt matching.)
 */
export function reviewRuleSetDigest(): string {
  const canonical = JSON.stringify({
    obligations: REVIEW_OBLIGATION_RULES,
    risks: REVIEW_RISK_RULES,
    baseline: BASELINE_REVIEW_RULES,
    focus: REVIEW_FOCUS_RULES,
    integration: INTEGRATION_REVIEW_RULES,
    maxUnitFiles: MAX_REVIEW_UNIT_FILES,
    reviewAxes: REVIEW_AXES,
    minReferencedAxes: MIN_REFERENCED_AXES,
    maxDiffChars: MAX_DIFF_CHARS,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** sha256 over the task prompt (empty-string digest when absent). */
export function reviewPromptDigest(taskPrompt: string | undefined): string {
  return createHash("sha256").update(taskPrompt ?? "").digest("hex");
}

/** sha256 over the tracked diff text the reviewer saw (binds changed content, not just paths). */
export function reviewDiffDigest(diffText: string): string {
  return createHash("sha256").update(diffText).digest("hex");
}

/** A record is valid for the current state only when every fingerprint component matches. */
export function reviewProvenanceFingerprintMatches(
  record: ReviewProvenanceRecord,
  current: ReviewProvenanceFingerprint,
): boolean {
  return record.fingerprint.commitHash === current.commitHash &&
    record.fingerprint.promptDigest === current.promptDigest &&
    record.fingerprint.diffDigest === current.diffDigest &&
    record.fingerprint.manifestDigest === current.manifestDigest &&
    record.fingerprint.partitionDigest === current.partitionDigest &&
    record.fingerprint.ruleSetDigest === current.ruleSetDigest;
}

/**
 * The fail-closed resume rule: a review unit is resumable only when its
 * newest record was an approval with complete coverage under the EXACT
 * current fingerprint. Any change — new commit, new/removed file, new
 * partition, new rules — forces a fresh unit review; stale records remain
 * audit history and can never approve new mutations.
 */
export function resumableUnitCoverage(input: {
  readonly records: readonly ReviewProvenanceRecord[];
  readonly fingerprint: ReviewProvenanceFingerprint;
  readonly units: readonly { readonly id: string; readonly requiredCoverage: readonly string[] }[];
}): ReadonlyMap<string, readonly string[]> {
  const resumable = new Map<string, readonly string[]>();
  for (const unit of input.units) {
    for (let index = input.records.length - 1; index >= 0; index -= 1) {
      const record = input.records[index]!;
      // Stale records are another review problem's history — keep scanning.
      if (!reviewProvenanceFingerprintMatches(record, input.fingerprint)) continue;
      // Records about other units do not decide this unit — keep scanning.
      if (record.inspectedUnits.length !== 1 || record.inspectedUnits[0] !== unit.id) continue;
      // This is the NEWEST record for this unit at the current fingerprint:
      // it decides alone. A later rejection or interruption shields any older
      // approval — older records never override the newest verdict.
      const complete = unit.requiredCoverage.every((path) => record.coveredPaths.includes(path));
      if (record.disposition === "approved" && complete) resumable.set(unit.id, record.coveredPaths);
      break;
    }
  }
  return resumable;
}

export function isReviewProvenanceRecord(value: unknown): value is ReviewProvenanceRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  if (!isNonEmptyString(record.workspace) || !isNonEmptyString(record.reviewer)) return false;
  if (!isNonEmptyString(record.findings) || !isNonEmptyString(record.recordedAt)) return false;
  if (Number.isNaN(Date.parse(record.recordedAt as string))) return false;
  if (record.disposition !== "approved" && record.disposition !== "changes_requested" && record.disposition !== "interrupted") return false;
  if (!Array.isArray(record.inspectedUnits) || record.inspectedUnits.length === 0 || !record.inspectedUnits.every(isNonEmptyString)) return false;
  if (!Array.isArray(record.coveredPaths) || !record.coveredPaths.every(isNonEmptyString)) return false;
  if (!Array.isArray(record.verification) || !record.verification.every(isNonEmptyString)) return false;
  const fingerprint = record.fingerprint;
  if (typeof fingerprint !== "object" || fingerprint === null) return false;
  const fp = fingerprint as Record<string, unknown>;
  if (fp.commitHash !== undefined && typeof fp.commitHash !== "string") return false;
  return isNonEmptyString(fp.promptDigest) &&
    isNonEmptyString(fp.diffDigest) &&
    isNonEmptyString(fp.manifestDigest) &&
    isNonEmptyString(fp.partitionDigest) &&
    isNonEmptyString(fp.ruleSetDigest);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
