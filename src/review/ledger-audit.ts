/**
 * W072 I-5: the kernel-authoritative step ledger, rendered for the secondary
 * reviewer's anti-cheating audit. The renderer emits ONLY what the kernel
 * records (id, task, state, content, required-evidence subjects) and never
 * infers evidence satisfaction — the reviewer compares the recorded states
 * against the diff under review.
 */

import type { WorkflowStep } from "../kernel/contracts.js";

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
