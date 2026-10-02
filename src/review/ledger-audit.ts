/**
 * W072 I-5: the kernel-authoritative step ledger, rendered for the secondary
 * reviewer's anti-cheating audit. The renderer emits ONLY what the kernel
 * records (id, task, state, content, required-evidence subjects) and never
 * infers evidence satisfaction — the reviewer compares the recorded states
 * against the diff under review.
 *
 * The deterministic audit below is the non-model check the prior slice lacked:
 * it compares each COMPLETED step's content against the paths the diff touched
 * and reports the steps no changed path backs. It is advisory material in the
 * prompt; the verdict gates are unchanged.
 */

import type { WorkflowStep } from "../kernel/contracts.js";

/**
 * Deterministic ledger-vs-diff finding. Advisory, never a gate: it names a
 * COMPLETED step whose content shares no path token with the changed set.
 */
export interface LedgerAuditFinding {
  readonly stepId: string;
  readonly content: string;
  readonly code: "LEDGER_STEP_WITHOUT_DIFF";
}

/**
 * Deterministic prompt rendering of the step ledger. Pure: no IO, no clock,
 * no model input. An empty ledger renders the honest absence, never a
 * fabricated "all steps complete".
 */
export function renderReviewLedgerText(steps: readonly WorkflowStep[]): string {
  if (steps.length === 0) {
    return "No step ledger is attached to the active task.";
  }
  const count = steps.length === 1 ? "1 step" : `${steps.length} steps`;
  const lines = steps.map((step) => {
    const evidence = step.requiredEvidence.length === 0
      ? "(none)"
      : step.requiredEvidence.map((requirement) => `${requirement.authority}:${requirement.subject}`).join(", ");
    return `- step ${step.id} [${step.state}] task ${step.taskId}: ${step.content}\n  required evidence: ${evidence}`;
  });
  return `${count} in the kernel ledger:\n${lines.join("\n")}`;
}

/**
 * Extracts the changed paths from a unified diff. Every `diff --git a/<p>
 * b/<p>` header and `+++ b/<p>` line contributes its path (deduplicated,
 * `/dev/null` skipped); any other diff text contributes nothing. Pure.
 */
export function changedPathsFromDiff(diffText: string): readonly string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    if (raw === "/dev/null" || raw.length === 0) return;
    const path = raw.replace(/^[ab]\//, "");
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  };
  for (const line of diffText.split("\n")) {
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (gitHeader !== null) {
      add(gitHeader[1]!);
      add(gitHeader[2]!);
      continue;
    }
    const plusHeader = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusHeader !== null) add(plusHeader[1]!);
  }
  return paths;
}

/** Lowercase, strip a leading `a/`/`b/` prefix, normalize backslashes. */
function normalizeToken(token: string): string {
  return token.replace(/\\/g, "/").replace(/^[ab]\//, "").toLowerCase();
}

/** Lowercased basename of a path (after forward-slash normalization). */
function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

/**
 * W072 I-5 deterministic ledger-vs-diff audit: for every COMPLETED step, a
 * finding is produced when no token of its content backs it. Matching rule
 * (simple, deterministic): tokenize the content on `[\w./-]+`, lowercase; a
 * step is backed when any token equals a changed path's normalized full path
 * or its basename. Steps not COMPLETED never produce a finding. An empty
 * `changedPaths` means every COMPLETED step is flagged.
 */
export function auditLedgerAgainstDiff(
  steps: readonly WorkflowStep[],
  changedPaths: readonly string[],
): readonly LedgerAuditFinding[] {
  const changedTokens = new Set<string>();
  for (const path of changedPaths) {
    changedTokens.add(normalizeToken(path));
    changedTokens.add(basenameOf(path));
  }
  const findings: LedgerAuditFinding[] = [];
  for (const step of steps) {
    if (step.state !== "COMPLETED") continue;
    const tokens = step.content.toLowerCase().match(/[\w./-]+/g) ?? [];
    const backed = tokens.some((token) => changedTokens.has(normalizeToken(token)));
    if (!backed) {
      findings.push({ stepId: step.id, content: step.content, code: "LEDGER_STEP_WITHOUT_DIFF" });
    }
  }
  return findings;
}

/**
 * Deterministic prompt rendering of the audit findings. Pure. An empty
 * findings list renders the honest all-backed result, never silence.
 */
export function renderLedgerAuditFindings(findings: readonly LedgerAuditFinding[]): string {
  if (findings.length === 0) {
    return "Deterministic audit: every COMPLETED step is backed by a changed path.";
  }
  const lines = findings.map((finding) => `- step ${finding.stepId} [${finding.code}]: ${finding.content}`);
  return `${findings.length} COMPLETED step(s) have no token matching a changed path:\n${lines.join("\n")}`;
}
