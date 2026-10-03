/**
 * W072 I-9 (docs/TASK_TODO_LEDGER_PARITY.md §3.9): assembles the ORDERED
 * admission stages for a step completion and runs them through the pure kernel
 * runner. The three cheap rungs (codes/schema/cross-field) are decomposed
 * projections of the EXISTING I-3 evidence admission — the same
 * authority/subject/result/freshness predicate `TaskGraph` already applies, in
 * increasing-cost order — and the state-diff rung wraps `evaluateStateDiff`
 * with the real `fingerprintFile` re-query. No new evidence semantics are
 * invented here; a `tests` rung is deliberately absent (no runner is wired).
 */

import type { Evidence, WorkflowStep } from "../kernel/contracts.js";
import type { ChangeClaim, ChangeObservation, ChangeObservationEntry } from "../kernel/state-diff.js";
import { evaluateStateDiff } from "../kernel/state-diff.js";
import {
  runAdmissionGates,
  type AdmissionRung,
  type AdmissionRungResult,
  type AdmissionStage,
} from "../kernel/admission-gate.js";
import { fingerprintFile } from "./file-claim-ledger.js";

export interface StepAdmissionInput {
  readonly step: WorkflowStep;
  readonly evidence: readonly Evidence[];
  /**
   * Lazy re-query reader. The state-diff rung calls it only when it is
   * reached, so a cheaper rejecting rung never pays for (nor triggers) the IO.
   */
  readonly readObservation: () => ChangeObservation;
}

export type StepAdmissionOutcome =
  | { readonly kind: "pass"; readonly observation: ChangeObservation }
  | { readonly kind: "reject"; readonly rung: AdmissionRung; readonly code: string; readonly reason: string };

/**
 * The real application-layer re-query: fingerprint each claimed subject with
 * `fingerprintFile`. An unreadable (`ENOENT`) path is omitted so it evaluates
 * as `absent` and refuses rather than fabricating a pass; any other read error
 * is rethrown (fail loud).
 */
export function observeChangeClaim(claim: ChangeClaim): ChangeObservation {
  const observed: ChangeObservationEntry[] = [];
  for (const subject of claim.subjects) {
    try {
      observed.push({ path: subject.path, fingerprint: fingerprintFile(subject.path).digest });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return { observed };
}

/** Cheapest rung: the transition precondition, then every declared requirement has a matching authority/subject record. */
function evaluateCodes(input: StepAdmissionInput): AdmissionRungResult {
  // Mirror the kernel's transition precondition FIRST, so a not-IN_PROGRESS
  // step reports ILLEGAL_STEP_TRANSITION exactly as TaskGraph.completeStep
  // would — the ordered runner must not re-order the kernel's own state gate.
  if (input.step.state !== "IN_PROGRESS") {
    return { kind: "reject", code: "ILLEGAL_STEP_TRANSITION", reason: `cannot complete step ${input.step.id} from ${input.step.state}` };
  }
  for (const requirement of input.step.requiredEvidence) {
    const records = input.evidence.filter((record) => record.subject === requirement.subject);
    if (records.length === 0) {
      return { kind: "reject", code: "STEP_EVIDENCE_REQUIRED", reason: `no evidence observed for ${requirement.authority}:${requirement.subject}` };
    }
    if (!records.some((record) => record.authority === requirement.authority)) {
      return { kind: "reject", code: "STEP_EVIDENCE_REQUIRED", reason: `no evidence from authority '${requirement.authority}' for ${requirement.subject}` };
    }
  }
  return { kind: "pass" };
}

/** Schema rung: the observed record is passing and a declared postcondition is well-formed. */
function evaluateSchema(input: StepAdmissionInput): AdmissionRungResult {
  for (const requirement of input.step.requiredEvidence) {
    const matching = input.evidence.filter(
      (record) => record.subject === requirement.subject && record.authority === requirement.authority,
    );
    if (!matching.some((record) => record.result === "passed")) {
      return { kind: "reject", code: "STEP_EVIDENCE_REQUIRED", reason: `the observed evidence for ${requirement.authority}:${requirement.subject} is not passing` };
    }
  }
  const postcondition = input.step.requiredPostcondition;
  if (postcondition !== undefined) {
    if (postcondition.subjects.length === 0) {
      return { kind: "reject", code: "STEP_POSTCONDITION_MALFORMED", reason: "a declared postcondition must name at least one subject (an empty claim confirms nothing)" };
    }
    for (const subject of postcondition.subjects) {
      if (subject.path.trim().length === 0 || subject.expectedFingerprint.trim().length === 0) {
        return { kind: "reject", code: "STEP_POSTCONDITION_MALFORMED", reason: "a postcondition subject needs a non-empty path and expectedFingerprint" };
      }
    }
  }
  return { kind: "pass" };
}

/** Cross-field rung: the passing record is fresh (result vs the mutation epoch). */
function evaluateCrossField(input: StepAdmissionInput): AdmissionRungResult {
  for (const requirement of input.step.requiredEvidence) {
    const passing = input.evidence.filter(
      (record) => record.subject === requirement.subject && record.authority === requirement.authority && record.result === "passed",
    );
    if (!passing.some((record) => record.freshness === "fresh")) {
      return { kind: "reject", code: "STEP_EVIDENCE_REQUIRED", reason: `the passing evidence for ${requirement.authority}:${requirement.subject} is stale` };
    }
  }
  return { kind: "pass" };
}

/** State-diff rung: the existing evaluator over the real re-query observation. */
function evaluateStateDiffRung(input: StepAdmissionInput): AdmissionRungResult {
  const postcondition = input.step.requiredPostcondition;
  if (postcondition === undefined) return { kind: "pass" };
  const verdict = evaluateStateDiff(postcondition, input.readObservation());
  if (verdict.kind === "confirmed") return { kind: "pass" };
  return { kind: "reject", code: "STEP_POSTCONDITION_UNMET", reason: verdict.reason };
}

/** The ordered stage set; `tests` is absent until a runner is wired. */
export function assembleStepAdmissionStages(): readonly AdmissionStage<StepAdmissionInput>[] {
  return [
    { rung: "codes", evaluate: evaluateCodes },
    { rung: "schema", evaluate: evaluateSchema },
    { rung: "cross-field", evaluate: evaluateCrossField },
    { rung: "state-diff", evaluate: evaluateStateDiffRung },
  ];
}

/**
 * Runs the ordered gates for a step and, on a pass, returns the same
 * observation the state-diff rung judged so the caller can hand it to the
 * kernel without a second re-query.
 */
export function runStepCompletionAdmission(input: {
  readonly step: WorkflowStep;
  readonly evidence: readonly Evidence[];
}): StepAdmissionOutcome {
  let built: ChangeObservation | undefined;
  const readObservation = (): ChangeObservation => {
    built ??= observeChangeClaim(input.step.requiredPostcondition ?? { subjects: [] });
    return built;
  };
  const outcome = runAdmissionGates(assembleStepAdmissionStages(), {
    step: input.step,
    evidence: input.evidence,
    readObservation,
  });
  if (outcome.kind === "reject") return outcome;
  return { kind: "pass", observation: built ?? { observed: [] } };
}
