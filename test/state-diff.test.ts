import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateStateDiff } from "../src/kernel/state-diff.js";
import type { ChangeClaim, ChangeObservation } from "../src/kernel/state-diff.js";

// W072 I-9 (docs/TASK_TODO_LEDGER_PARITY.md §3.9): the state-diff re-query
// gate. The core spec case is a claimed change that did not appear in the
// target — assertion alone must not validate completion. Diagnostics are
// deterministic: claimed subjects are scanned in claim order and the first
// offender is reported.

function claim(...subjects: readonly (readonly [string, string])[]): ChangeClaim {
  return { subjects: subjects.map(([path, expectedFingerprint]) => ({ path, expectedFingerprint })) };
}

function observed(...subjects: readonly (readonly [string, string])[]): ChangeObservation {
  return { observed: subjects.map(([path, fingerprint]) => ({ path, fingerprint })) };
}

test("confirmed: every claimed subject is re-observed with a matching fingerprint", () => {
  const verdict = evaluateStateDiff(claim(["src/a.ts", "sha-a"]), observed(["src/a.ts", "sha-a"]));
  assert.equal(verdict.kind, "confirmed");
});

test("absent: a claimed change that did not appear in the target is rejected", () => {
  const verdict = evaluateStateDiff(claim(["src/a.ts", "sha-a"]), observed());
  assert.equal(verdict.kind, "absent");
  assert.equal(verdict.code, "STATE_DIFF_ABSENT");
  assert.deepEqual(verdict.subjects, ["src/a.ts"]);
});

test("mismatch: a re-observed subject with a different fingerprint is rejected", () => {
  const verdict = evaluateStateDiff(claim(["src/a.ts", "sha-a"]), observed(["src/a.ts", "sha-b"]));
  assert.equal(verdict.kind, "mismatch");
  assert.equal(verdict.code, "STATE_DIFF_MISMATCH");
  assert.deepEqual(verdict.subjects, ["src/a.ts"]);
});

test("empty claim: a gate over nothing confirms nothing and never silently passes", () => {
  const verdict = evaluateStateDiff(claim(), observed(["src/a.ts", "sha-a"]));
  assert.equal(verdict.kind, "empty");
  assert.equal(verdict.code, "STATE_DIFF_EMPTY");
  assert.deepEqual(verdict.subjects, []);
});

test("deterministic diagnostics: the first claimed offender is reported in claim order", () => {
  // b.ts sorts before a.ts alphabetically; claim order is preserved so the
  // diagnostic does not depend on map/sort ordering.
  const verdict = evaluateStateDiff(
    claim(["src/b.ts", "sha-b"], ["src/a.ts", "sha-a"]),
    observed(["src/a.ts", "sha-a"]),
  );
  assert.equal(verdict.kind, "absent");
  assert.deepEqual(verdict.subjects, ["src/b.ts"]);
});

test("multi-subject partial failure: absent and mismatch each name their offending subject", () => {
  const absent = evaluateStateDiff(
    claim(["src/a.ts", "sha-a"], ["src/b.ts", "sha-b"]),
    observed(["src/a.ts", "sha-a"]),
  );
  assert.equal(absent.kind, "absent");
  assert.equal(absent.code, "STATE_DIFF_ABSENT");
  assert.deepEqual(absent.subjects, ["src/b.ts"]);

  const mismatch = evaluateStateDiff(
    claim(["src/a.ts", "sha-a"], ["src/b.ts", "sha-b"]),
    observed(["src/a.ts", "sha-a"], ["src/b.ts", "sha-WRONG"]),
  );
  assert.equal(mismatch.kind, "mismatch");
  assert.equal(mismatch.code, "STATE_DIFF_MISMATCH");
  assert.deepEqual(mismatch.subjects, ["src/b.ts"]);
  assert.equal(mismatch.expectedFingerprint, "sha-b");
  assert.equal(mismatch.observedFingerprint, "sha-WRONG");
});
