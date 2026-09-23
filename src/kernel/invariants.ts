import type { Evidence, WorkflowTask } from "./contracts.js";

// W107 (amux C2, docs/AMUX_RESEARCH_2026-09-23.md §6): "all-clear must say
// what it judged." Every invariant row reports its JUDGED POPULATION; an
// empty population renders could-not-discriminate, never a silent pass —
// the amux anti-pattern was all-clears that judged nothing or silently
// truncated the population. The evaluation is pure state inspection: the
// kernel owns task state, transition legality, and evidence freshness, so
// the invariants over that state are kernel material (no IO, no UI).

export type InvariantVerdict = "passed" | "failed" | "could-not-discriminate";

export interface InvariantRow {
  readonly id: string;
  readonly label: string;
  readonly verdict: InvariantVerdict;
  /** How many subjects this invariant actually judged — the all-clear's
   * population. Zero means the invariant says nothing about the fleet. */
  readonly judged: number;
  /** The offending subject ids when the verdict is failed. */
  readonly failures?: readonly string[];
}

const LEGAL_TASK_STATES: ReadonlySet<string> = new Set([
  "BLOCKED",
  "READY",
  "IN_PROGRESS",
  "VERIFYING",
  "VERIFIED",
  "FAILED",
]);

const LEGAL_EVIDENCE_AUTHORITIES: ReadonlySet<string> = new Set(["environment", "host", "mcp", "reviewer"]);
const LEGAL_EVIDENCE_RESULTS: ReadonlySet<string> = new Set(["passed", "failed"]);
const LEGAL_EVIDENCE_FRESHNESS: ReadonlySet<string> = new Set(["fresh", "stale"]);

function row(id: string, label: string, judged: number, failures: readonly string[]): InvariantRow {
  if (judged === 0) return { id, label, verdict: "could-not-discriminate", judged };
  if (failures.length === 0) return { id, label, verdict: "passed", judged };
  return { id, label, verdict: "failed", judged, failures };
}

export function evaluateTaskGraphInvariants(state: {
  readonly tasks: readonly WorkflowTask[];
  readonly evidence: readonly Evidence[];
}): readonly InvariantRow[] {
  // State legality: every task's state is inside the kernel's legal state
  // set. The kernel cannot produce an illegal state by construction — the
  // FAILED branch exists for corrupt/persisted inputs, which is exactly the
  // shape this invariant must discriminate.
  const illegalStates = state.tasks
    .filter((task) => !LEGAL_TASK_STATES.has(task.state))
    .map((task) => task.id);
  const stateLegality = row(
    "state-legality",
    "Task states are legal",
    state.tasks.length,
    illegalStates,
  );

  // Verified tasks hold fresh passing evidence for every required subject.
  // recordMutation demotes affected verified tasks by construction, so the
  // FAILED branch exists for corrupt inputs — the row's value is the judged
  // population: "N verified tasks judged, 0 failures" is an honest all-clear
  // only because N is stated.
  const verified = state.tasks.filter((task) => task.state === "VERIFIED");
  const unverifiedRequirements = verified
    .filter((task) =>
      task.requiredEvidence.some((requirement) => {
        const satisfying = state.evidence.find(
          (record) =>
            record.subject === requirement.subject &&
            record.authority === requirement.authority &&
            record.result === "passed" &&
            record.freshness === "fresh",
        );
        return satisfying === undefined;
      }),
    )
    .map((task) => task.id);
  const verifiedEvidenceFresh = row(
    "verified-evidence-fresh",
    "Verified tasks hold fresh passing evidence",
    verified.length,
    unverifiedRequirements,
  );

  // Evidence records are well-formed: authority, result, and freshness are
  // inside their kernel unions. Guards against corrupt persisted state.
  const malformedEvidence = state.evidence
    .filter(
      (record) =>
        !LEGAL_EVIDENCE_AUTHORITIES.has(record.authority) ||
        !LEGAL_EVIDENCE_RESULTS.has(record.result) ||
        !LEGAL_EVIDENCE_FRESHNESS.has(record.freshness),
    )
    .map((record) => record.id);
  const evidenceRecordShape = row(
    "evidence-record-shape",
    "Evidence records are well-formed",
    state.evidence.length,
    malformedEvidence,
  );

  return [stateLegality, verifiedEvidenceFresh, evidenceRecordShape];
}
