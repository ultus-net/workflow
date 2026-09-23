import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateTaskGraphInvariants } from "../src/kernel/invariants.js";
import type { Evidence, WorkflowTask } from "../src/kernel/contracts.js";

// W107 (amux C2): the invariants panel's evaluation lives in the KERNEL —
// pure state inspection, no IO — and every row reports its JUDGED POPULATION
// so an all-clear is never vacuous. A zero population renders
// "could-not-discriminate" (the amux distinction), never a silent pass.

function task(overrides: Partial<Omit<WorkflowTask, "id">> & { id: string }): WorkflowTask {
  return {
    title: `task ${overrides.id}`,
    state: "READY",
    dependencies: [],
    requiredEvidence: [],
    ...overrides,
  } as WorkflowTask;
}

function evidence(overrides: Partial<Omit<Evidence, "id">> & { id: string; subject: string }): Evidence {
  const { id, ...rest } = overrides;
  return {
    id: id as Evidence["id"],
    observationId: `obs-${id}` as Evidence["observationId"],
    authority: "environment",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: 1,
    observedAt: "2026-09-23T00:00:00.000Z",
    ...rest,
  } as Evidence;
}

test("empty populations discriminate nothing: could-not-discriminate, never a silent pass", () => {
  const rows = evaluateTaskGraphInvariants({ tasks: [], evidence: [] });
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.verdict, "could-not-discriminate", row.id);
    assert.equal(row.judged, 0, row.id);
  }
});

test("state-legality judges every task and reports the judged population", () => {
  const rows = evaluateTaskGraphInvariants({
    tasks: [task({ id: "t1", state: "READY" }), task({ id: "t2", state: "VERIFIED" })],
    evidence: [],
  });
  const legality = rows.find((row) => row.id === "state-legality");
  assert.ok(legality);
  assert.equal(legality.verdict, "passed");
  assert.equal(legality.judged, 2);
});

test("state-legality fails with the offending task ids when a state is outside the legal set", () => {
  // The kernel cannot produce an illegal state by construction — the
  // evaluator's FAILED branch exists for persisted/corrupt inputs, which is
  // exactly the shape the evaluator must discriminate.
  const rows = evaluateTaskGraphInvariants({
    tasks: [task({ id: "t1", state: "READY" }), task({ id: "t2", state: "SHRUGGED" as unknown as WorkflowTask["state"] })],
    evidence: [],
  });
  const legality = rows.find((row) => row.id === "state-legality");
  assert.ok(legality);
  assert.equal(legality.verdict, "failed");
  assert.equal(legality.judged, 2);
  assert.deepEqual(legality.failures, ["t2"]);
});

test("verified-evidence-fresh judges verified tasks; non-verified tasks stay out of the population", () => {
  const rows = evaluateTaskGraphInvariants({
    tasks: [
      task({ id: "v1", state: "VERIFIED", requiredEvidence: [{ authority: "environment", subject: "artifact-a" }] }),
      task({ id: "r1", state: "READY" }),
    ],
    evidence: [evidence({ id: "e1", subject: "artifact-a" })],
  });
  const fresh = rows.find((row) => row.id === "verified-evidence-fresh");
  assert.ok(fresh);
  assert.equal(fresh.verdict, "passed");
  assert.equal(fresh.judged, 1);
});

test("verified-evidence-fresh fails when a verified task lacks fresh passing evidence for a required subject", () => {
  const rows = evaluateTaskGraphInvariants({
    tasks: [
      task({ id: "v1", state: "VERIFIED", requiredEvidence: [{ authority: "environment", subject: "artifact-a" }, { authority: "environment", subject: "artifact-b" }] }),
    ],
    evidence: [evidence({ id: "e1", subject: "artifact-a" })],
  });
  const fresh = rows.find((row) => row.id === "verified-evidence-fresh");
  assert.ok(fresh);
  assert.equal(fresh.verdict, "failed");
  assert.deepEqual(fresh.failures, ["v1"]);
});

test("verified-evidence-fresh counts stale evidence as a failure, matching the kernel's freshness vocabulary", () => {
  const rows = evaluateTaskGraphInvariants({
    tasks: [task({ id: "v1", state: "VERIFIED", requiredEvidence: [{ authority: "environment", subject: "artifact-a" }] })],
    evidence: [evidence({ id: "e1", subject: "artifact-a", freshness: "stale" })],
  });
  const fresh = rows.find((row) => row.id === "verified-evidence-fresh");
  assert.ok(fresh);
  assert.equal(fresh.verdict, "failed");
});

test("evidence-record-shape judges every evidence record and reports its population", () => {
  const rows = evaluateTaskGraphInvariants({
    tasks: [],
    evidence: [evidence({ id: "e1", subject: "a" }), evidence({ id: "e2", subject: "b" })],
  });
  const shape = rows.find((row) => row.id === "evidence-record-shape");
  assert.ok(shape);
  assert.equal(shape.verdict, "passed");
  assert.equal(shape.judged, 2);
});

test("evidence-record-shape fails on an out-of-union authority", () => {
  const rows = evaluateTaskGraphInvariants({
    tasks: [],
    evidence: [evidence({ id: "e1", subject: "a", authority: "vibes" as unknown as Evidence["authority"] })],
  });
  const shape = rows.find((row) => row.id === "evidence-record-shape");
  assert.ok(shape);
  assert.equal(shape.verdict, "failed");
  assert.deepEqual(shape.failures, ["e1"]);
});
