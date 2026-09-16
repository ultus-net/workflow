/**
 * Deterministic review coverage manifest (TASKS.md W039).
 *
 * Review scope is a control-plane fact, not an LLM judgment: the manifest is
 * derived from `git status --porcelain=v1 -z --untracked-files=all` output —
 * every changed and untracked file, each with deterministic review
 * obligations — before a reviewer runs. `git diff HEAD` alone cannot define
 * scope because it silently omits untracked files; the manifest closes that
 * hole.
 *
 * The completion check is the same discipline as the rubric's axis gate: an
 * approved secondary review must explicitly cover every manifest entry
 * (via a `[COVERAGE] path, ...` line in its final message), or the approval
 * fails closed. Like the axis rule, this binds what the reviewer claims to a
 * deterministic fact; it cannot prove the reviewer actually read each file.
 */

import { createHash } from "node:crypto";

export type ReviewChangeStatus = "added" | "deleted" | "modified" | "renamed" | "untracked";

export type ReviewObligation = "security" | "authority" | "tests" | "docs" | "general";

export interface ReviewStatusChange {
  readonly path: string;
  readonly status: ReviewChangeStatus;
  readonly sourcePath?: string;
}

export interface ReviewManifestEntry {
  readonly path: string;
  readonly status: ReviewChangeStatus;
  readonly sourcePath?: string;
  readonly obligations: readonly ReviewObligation[];
}

export interface ReviewCoverageManifest {
  readonly entries: readonly ReviewManifestEntry[];
  /** Stable sha256 over the canonical entry serialization (W041 provenance input). */
  readonly digest: string;
}

/**
 * Deterministic obligation attachment. Path rules are explicit and ordered so
 * W040 risk partitioning can extend them without re-deriving scope. Every
 * entry always carries the baseline "general" obligation.
 */
export const REVIEW_OBLIGATION_RULES: readonly {
  readonly obligation: Exclude<ReviewObligation, "general">;
  readonly pattern: RegExp;
  readonly reason: string;
}[] = [
  { obligation: "security", pattern: /^src\/containment\//, reason: "runtime containment and isolation boundaries" },
  { obligation: "security", pattern: /^src\/integrations\/credentials\.ts$/, reason: "credential handling" },
  { obligation: "security", pattern: /^src\/integrations\/mcp-toolbox-guard\.ts$/, reason: "guard dispatch and authorization boundary" },
  { obligation: "authority", pattern: /^src\/kernel\//, reason: "canonical task state and transition authority" },
  { obligation: "authority", pattern: /^src\/application\//, reason: "application authorization and evidence admission" },
  { obligation: "tests", pattern: /^test\//, reason: "behavioral verification" },
  { obligation: "docs", pattern: /^docs\//, reason: "operator-facing claims must match code" },
  { obligation: "docs", pattern: /\.md$/, reason: "operator-facing claims must match code" },
];

const OBLIGATION_ORDER: readonly ReviewObligation[] = ["security", "authority", "tests", "docs", "general"];

export function reviewObligationsForPath(path: string): readonly ReviewObligation[] {
  const matched = new Set<ReviewObligation>();
  for (const rule of REVIEW_OBLIGATION_RULES) {
    if (rule.pattern.test(path)) matched.add(rule.obligation);
  }
  matched.add("general");
  return OBLIGATION_ORDER.filter((obligation) => matched.has(obligation));
}

/**
 * Parses `git status --porcelain=v1 -z [--branch] --untracked-files=all`
 * output (NUL-separated records). A leading `## ` branch header record is
 * tolerated; rename/copy records consume the following source-path record.
 * Ported from the web UI's git status parsing so both surfaces agree.
 */
export function parseReviewStatus(statusOutput: string): readonly ReviewStatusChange[] {
  const records = statusOutput.split("\0");
  const changes: ReviewStatusChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) continue;
    if (record.startsWith("## ")) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (path.length === 0) continue;
    let sourcePath: string | undefined;
    if (code.includes("R") || code.includes("C")) {
      // Porcelain -z reports the destination in this record, then the source.
      sourcePath = records[index + 1] || undefined;
      index += 1;
    }
    changes.push({ path, status: reviewChangeStatus(code), ...(sourcePath === undefined ? {} : { sourcePath }) });
  }
  return changes;
}

function reviewChangeStatus(code: string): ReviewChangeStatus {
  if (code === "??") return "untracked";
  if (code.includes("R") || code.includes("C")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

export function deriveReviewCoverageManifest(input: { readonly statusOutput: string }): ReviewCoverageManifest {
  const entries: ReviewManifestEntry[] = parseReviewStatus(input.statusOutput)
    .map((change) => ({ ...change, obligations: reviewObligationsForPath(change.path) }))
    // Code-unit sort keeps the digest stable across locales and environments.
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { entries, digest: manifestDigest(entries) };
}

export function manifestDigest(entries: readonly ReviewManifestEntry[]): string {
  const canonical = entries
    .map((entry) => [entry.status, entry.path, entry.sourcePath ?? "", entry.obligations.join("+")].join("\t"))
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Manifest entries not named by the reviewer's covered-paths list, in
 * manifest order. A non-empty result blocks an approved verdict: the
 * secondary review cannot report complete coverage while required manifest
 * entries remain unreviewed.
 */
export function reviewCoverageGaps(input: {
  readonly manifest: ReviewCoverageManifest;
  readonly coveredPaths: readonly string[];
}): readonly string[] {
  const covered = new Set(input.coveredPaths.map((path) => path.trim()).filter((path) => path.length > 0));
  return input.manifest.entries.filter((entry) => !covered.has(entry.path)).map((entry) => entry.path);
}

/** Deterministic prompt rendering of the manifest scope. */
export function renderReviewManifestText(manifest: ReviewCoverageManifest): string {
  if (manifest.entries.length === 0) {
    return "No changed or untracked files are in scope for this review.";
  }
  const lines = manifest.entries.map((entry) => {
    const from = entry.sourcePath === undefined ? "" : ` (from ${entry.sourcePath})`;
    return `- ${entry.path}${from} - ${entry.status} [obligations: ${entry.obligations.join(", ")}]`;
  });
  const count = manifest.entries.length === 1 ? "1 entry in scope" : `${manifest.entries.length} entries in scope`;
  return `${count}:\n${lines.join("\n")}`;
}
