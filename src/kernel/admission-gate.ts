/**
 * W072 I-9 (docs/TASK_TODO_LEDGER_PARITY.md §3.9): the ORDERED admission-gate
 * runner. Completion is validated by deterministic gates in INCREASING COST
 * order — response/exit codes → schema validation → cross-field consistency →
 * state-diff re-query → test execution — and a later rung must NOT run once an
 * earlier one rejects (the cheaper check already failed the admission).
 *
 * This is the pure contract only: the caller supplies stages (their evaluators
 * carry whatever IO they need, but this module reads no clock and performs no
 * IO) and the fixed rung vocabulary defines the order, NOT the caller's array
 * order. The application composition that assembles the real step-completion
 * stages lives in `src/application/admission-gate.ts`.
 */

export type AdmissionRung = "codes" | "schema" | "cross-field" | "state-diff" | "tests";

export type AdmissionRungResult =
  | { readonly kind: "pass" }
  | { readonly kind: "reject"; readonly code: string; readonly reason: string };

/**
 * The fixed spec order (§3.9). Order is a property of the vocabulary: the
 * runner iterates this, so a caller that shuffles the stage array cannot
 * reorder the gates.
 */
export const ADMISSION_RUNG_ORDER = [
  "codes",
  "schema",
  "cross-field",
  "state-diff",
  "tests",
] as const satisfies readonly AdmissionRung[];

export interface AdmissionStage<Input> {
  readonly rung: AdmissionRung;
  readonly evaluate: (input: Input) => AdmissionRungResult;
}

export type AdmissionOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "reject"; readonly rung: AdmissionRung; readonly code: string; readonly reason: string };

/**
 * Evaluates the supplied stages in `ADMISSION_RUNG_ORDER`, short-circuiting on
 * the first reject. A rung with no stage is skipped (an optional rung such as
 * `tests` may be absent without changing behavior). A duplicate rung is a
 * caller error and fails loud rather than silently dropping one of the two.
 */
export function runAdmissionGates<Input>(
  stages: readonly AdmissionStage<Input>[],
  input: Input,
): AdmissionOutcome {
  const byRung = new Map<AdmissionRung, AdmissionStage<Input>>();
  for (const stage of stages) {
    if (byRung.has(stage.rung)) throw new TypeError(`duplicate admission rung: ${stage.rung}`);
    byRung.set(stage.rung, stage);
  }

  for (const rung of ADMISSION_RUNG_ORDER) {
    const stage = byRung.get(rung);
    if (stage === undefined) continue;
    const result = stage.evaluate(input);
    if (result.kind === "reject") {
      return { kind: "reject", rung, code: result.code, reason: result.reason };
    }
  }
  return { kind: "pass" };
}
