/**
 * W072 I-9 (docs/TASK_TODO_LEDGER_PARITY.md §3.9): the state-diff re-query
 * gate — the deterministic check that a claimed change actually re-appears in
 * the target system. The evaluator is a pure contract: the caller supplies the
 * claim (what the agent asserted changed) and the observation (what the
 * re-query actually saw), and the kernel reads no clock and performs no IO.
 *
 * This is the CONTRACT only. Wiring it into evidence admission as one ordered
 * gate (codes → schema → cross-field → state-diff → tests) is a later slice;
 * DRIFT-019 / DRIFT-024 remain open until that wiring and its v2 fingerprint
 * source land.
 */

export interface ChangeClaimSubject {
  readonly path: string;
  readonly expectedFingerprint: string;
}

export interface ChangeClaim {
  readonly subjects: readonly ChangeClaimSubject[];
}

export interface ChangeObservationEntry {
  readonly path: string;
  readonly fingerprint: string;
}

export interface ChangeObservation {
  readonly observed: readonly ChangeObservationEntry[];
}

/**
 * The gate's verdict. `confirmed` means every claimed subject was re-observed
 * with its expected fingerprint. `empty` means the claim itself was vacuous —
 * a gate that judged nothing does not silently pass (the W107 amux rule).
 * `absent` / `mismatch` carry the first offending subject in CLAIM order and a
 * stable refusal code.
 */
export type StateDiffVerdict =
  | { readonly kind: "confirmed"; readonly subjectCount: number }
  | { readonly kind: "empty"; readonly code: "STATE_DIFF_EMPTY"; readonly reason: string; readonly subjects: readonly string[] }
  | { readonly kind: "absent"; readonly code: "STATE_DIFF_ABSENT"; readonly reason: string; readonly subjects: readonly string[] }
  | {
      readonly kind: "mismatch";
      readonly code: "STATE_DIFF_MISMATCH";
      readonly reason: string;
      readonly subjects: readonly string[];
      readonly expectedFingerprint: string;
      readonly observedFingerprint: string;
    };

/**
 * Deterministic diagnostic order: iterate the claimed subjects in claim order
 * and report the FIRST offending subject (fail-fast — the higher-cost gates
 * after state-diff never run on a failed check). Re-observation is indexed by
 * path; when the same path appears twice in the observation the last entry
 * wins, so the result does not depend on hidden state.
 */
export function evaluateStateDiff(claim: ChangeClaim, observation: ChangeObservation): StateDiffVerdict {
  if (claim.subjects.length === 0) {
    return {
      kind: "empty",
      code: "STATE_DIFF_EMPTY",
      reason: "no claimed subjects to re-observe; a state-diff gate over an empty claim confirms nothing",
      subjects: [],
    };
  }

  const observedByPath = new Map<string, string>();
  for (const entry of observation.observed) {
    observedByPath.set(entry.path, entry.fingerprint);
  }

  for (const subject of claim.subjects) {
    const observedFingerprint = observedByPath.get(subject.path);
    if (observedFingerprint === undefined) {
      return {
        kind: "absent",
        code: "STATE_DIFF_ABSENT",
        reason: `claimed subject '${subject.path}' was not re-observed in the target system`,
        subjects: [subject.path],
      };
    }
    if (observedFingerprint !== subject.expectedFingerprint) {
      return {
        kind: "mismatch",
        code: "STATE_DIFF_MISMATCH",
        reason: `claimed subject '${subject.path}' re-observed with a different fingerprint`,
        subjects: [subject.path],
        expectedFingerprint: subject.expectedFingerprint,
        observedFingerprint,
      };
    }
  }

  return { kind: "confirmed", subjectCount: claim.subjects.length };
}
