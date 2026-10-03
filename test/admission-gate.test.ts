import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMISSION_RUNG_ORDER,
  runAdmissionGates,
  type AdmissionRung,
  type AdmissionRungResult,
  type AdmissionStage,
} from "../src/kernel/admission-gate.js";

// W072 I-9 (docs/TASK_TODO_LEDGER_PARITY.md §3.9): the ordered admission-gate
// runner. Order is a property of the rung vocabulary, not the caller's array;
// a later rung must never run once an earlier one rejects.

function passing(rung: AdmissionRung, calls: AdmissionRung[]): AdmissionStage<null> {
  return { rung, evaluate: () => { calls.push(rung); return { kind: "pass" }; } };
}

function rejecting(rung: AdmissionRung, calls: AdmissionRung[], code: string, reason = "rejected"): AdmissionStage<null> {
  return { rung, evaluate: (): AdmissionRungResult => { calls.push(rung); return { kind: "reject", code, reason }; } };
}

test("the fixed rung order is the spec order codes→schema→cross-field→state-diff→tests", () => {
  assert.deepEqual([...ADMISSION_RUNG_ORDER], ["codes", "schema", "cross-field", "state-diff", "tests"]);
});

test("stages run in the rung order even when the caller shuffles the array", () => {
  const calls: AdmissionRung[] = [];
  const stages = [
    passing("tests", calls),
    passing("cross-field", calls),
    passing("state-diff", calls),
    passing("schema", calls),
    passing("codes", calls),
  ];
  assert.deepEqual(runAdmissionGates(stages, null), { kind: "pass" });
  assert.deepEqual(calls, ["codes", "schema", "cross-field", "state-diff", "tests"]);
});

test("the first reject short-circuits: later stage functions are never called", () => {
  const calls: AdmissionRung[] = [];
  const outcome = runAdmissionGates([
    passing("codes", calls),
    rejecting("schema", calls, "SCHEMA_BAD"),
    passing("cross-field", calls),
    passing("state-diff", calls),
    passing("tests", calls),
  ], null);
  assert.deepEqual(outcome, { kind: "reject", rung: "schema", code: "SCHEMA_BAD", reason: "rejected" });
  assert.deepEqual(calls, ["codes", "schema"]);
});

test("a rejecting codes stage means state-diff and tests are never evaluated", () => {
  let stateDiffCalls = 0;
  let testsCalls = 0;
  const outcome = runAdmissionGates<null>([
    { rung: "codes", evaluate: () => ({ kind: "reject", code: "CODES_BAD", reason: "bad code" }) },
    { rung: "state-diff", evaluate: () => { stateDiffCalls += 1; return { kind: "pass" }; } },
    { rung: "tests", evaluate: () => { testsCalls += 1; return { kind: "pass" }; } },
  ], null);
  assert.equal(outcome.kind, "reject");
  assert.equal(stateDiffCalls, 0);
  assert.equal(testsCalls, 0);
  if (outcome.kind === "reject") {
    assert.equal(outcome.rung, "codes");
    assert.equal(outcome.code, "CODES_BAD");
  }
});

test("each rung's reject code surfaces with its rung name", () => {
  const cases: readonly (readonly [AdmissionRung, string])[] = [
    ["codes", "CODES_X"],
    ["schema", "SCHEMA_X"],
    ["cross-field", "CROSS_X"],
    ["state-diff", "DIFF_X"],
    ["tests", "TESTS_X"],
  ];
  for (const [rung, code] of cases) {
    const outcome = runAdmissionGates([rejecting(rung, [], code)], null);
    assert.equal(outcome.kind, "reject");
    if (outcome.kind === "reject") {
      assert.equal(outcome.rung, rung);
      assert.equal(outcome.code, code);
    }
  }
});

test("an absent optional rung is skipped without changing the outcome", () => {
  const calls: AdmissionRung[] = [];
  const outcome = runAdmissionGates([passing("codes", calls), passing("state-diff", calls)], null);
  assert.deepEqual(outcome, { kind: "pass" });
  assert.deepEqual(calls, ["codes", "state-diff"]);
});

test("a duplicate rung is a caller error and fails loud", () => {
  assert.throws(
    () => runAdmissionGates([passing("codes", []), passing("codes", [])], null),
    /duplicate admission rung: codes/,
  );
});
