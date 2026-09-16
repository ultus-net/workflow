/**
 * Secondary review rubric — ported from opencode-workflow-guard
 * (src/lib/review.ts buildReviewRubric) with the axis-reference check from
 * src/lib/custom-tools.ts (record_review). Verbatim where possible.
 */

export interface ReviewAxis {
  /** Header text as it appears in the rubric. */
  readonly name: string;
  /** Lowercase reference token the review summary must name. */
  readonly ref: string;
}

export const REVIEW_AXES: readonly ReviewAxis[] = [
  { name: "Test Integrity", ref: "test integrity" },
  { name: "Task Completeness", ref: "task completeness" },
  { name: "Cleanliness", ref: "cleanliness" },
  { name: "Security", ref: "security" },
  { name: "Platform", ref: "platform" },
] as const;

export const MIN_REFERENCED_AXES = 3;
const MAX_DIFF_CHARS = 30_000;

export function buildReviewRubric(input: {
  readonly diffText: string;
  readonly taskPrompt?: string;
  /** Deterministic review scope (W039): when present, coverage is enforced on approval. */
  readonly manifestText?: string;
}): string {
  const { diffText, taskPrompt, manifestText } = input;
  return [
    "# Secondary Review Agent Quality Gate",
    "",
    "Evaluate this code change independently with fresh context across these 5 core axes:",
    "",
    "### 1. Test Integrity & Truthfulness (CRITICAL)",
    "- Are test assertions testing real behavioral outcomes rather than trivial passes (e.g. `expect(true).toBe(true)`)?",
    "- Were existing tests disabled, bypassed, or weakened?",
    "- Are edge cases and error paths covered?",
    "",
    "### 2. Task Completeness & Intent Alignment",
    "- Does the implementation genuinely satisfy the user request without shortcut stubs (`// TODO`, `throw new Error('not implemented')`)?",
    "- Does it introduce regressions in surrounding code?",
    "",
    "### 3. Code Cleanliness & Hygiene",
    "- Is there any orphaned dead code, commented-out code blocks, or temporary debugging logs?",
    "- Is the logic straightforward and free of unnecessary cognitive complexity?",
    "",
    "### 4. Security & Safety Boundaries",
    "- Are there any hardcoded secrets, unprotected tokens, or unvalidated user inputs?",
    "- Does the code respect workspace confinement and safe environment practices?",
    "",
    "### 5. Platform & Architecture Fit (GitHub & Azure DevOps)",
    "- Does the change fit established repository patterns and CI/CD pipelines?",
    "",
    "### Finding Severity & Priority Tiers (inspired by OMP Advisor):",
    "- **P0**: Blocker / security vulnerability / data loss risk / release-blocking regression (must block approval).",
    "- **P1**: Major defect / missing core requirement / broken error handling (must block approval).",
    "- **P2**: Minor bug / edge case / hygiene issue / missing unit test.",
    "- **P3**: Suggestion / nitpick / optimization idea.",
    "",
    taskPrompt ? `### User Request / Context:\n${taskPrompt}\n` : "",
    ...(manifestText === undefined
      ? []
      : [
          "### Review Coverage Manifest (deterministic scope):",
          manifestText,
          "",
        ]),
    "### Code Diff Under Review:",
    "```diff",
    diffText.slice(0, MAX_DIFF_CHARS),
    "```",
    "",
    "Provide your verdict: `[APPROVE]` or `[REQUEST_CHANGES]` with concise, actionable findings ranked by priority (P0-P3).",
    "Structure the verdict with one short line per axis you evaluated, naming the axis explicitly",
    "(at least 3 of: test integrity, task completeness, cleanliness, security, platform) —",
    "an approval that does not name at least 3 axes is rejected as a rubber stamp.",
    "",
    ...(manifestText === undefined
      ? []
      : [
          "Every manifest entry above is mandatory review scope.",
          "End your final message with one line: `[COVERAGE] path1, path2, ...` listing every",
          "manifest path you reviewed. An approval whose [COVERAGE] line omits a manifest path",
          "is rejected as incomplete coverage — when coverage is genuinely unclear, [REQUEST_CHANGES].",
          "",
        ]),
    "You are a read-only reviewer: the complete diff under review is embedded above, and shell",
    "commands are not available to you — a rejected command ends the review without a verdict.",
    "Review the diff as provided and always finish with the verdict line.",
  ].join("\n");
}

/**
 * Port of the record_review axis gate: the review summary must name at least
 * MIN_REFERENCED_AXES of the five axes, or the review is rejected.
 */
export function countReferencedAxes(summary: string): number {
  const refs = REVIEW_AXES.map((axis) => axis.ref);
  const lowered = summary.toLowerCase();
  return refs.filter((ref) => lowered.includes(ref)).length;
}
