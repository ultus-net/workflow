import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskGraph,
  WorkflowApplication,
  evidenceId,
  hostCapabilities,
  observationId,
  taskId,
  type Evidence,
  type WorkflowTask,
} from "../src/index.js";

// ── P3 (issue #282) — the kernel authority vocabulary + the authorized-attach
// pointer. The approved design: docs/P3_AUTHORITY_VOCABULARY_BRIEF.md.
//
// The pins below target the NEW behavior: an operator decision opens a
// DECISION gate only; a decision can never open an evidence gate and evidence
// can never open a decision gate (the axes are disjoint by construction);
// malformed/stale/actor-mismatched decision records fail closed; the
// producing-flow pointer is authority-recorded, inert, and never
// client-supplied; and the claim-shaped input stays unrepresentable (the
// type-level pin lives in test/contracts.test.ts).

const task = (id: string, extra: Record<string, unknown> = {}): WorkflowTask => ({
  id: taskId(id),
  title: id,
  state: "BLOCKED",
  dependencies: [],
  requiredEvidence: [],
  ...extra,
});

const operatorAttribution = {
  actor: "operator" as const,
  authority: "operator decision (application authority)",
  observedAt: "2026-09-30T00:00:00.000Z",
};

type DecisionRecordShape = {
  authority: "operator";
  subject: string;
  actor: "operator" | "agent" | "system" | "scheduler";
  decidedAt: string;
  mutationEpoch: number;
};

const decision = (subject: string, epoch: number, extra: Record<string, unknown> = {}): DecisionRecordShape => ({
  authority: "operator",
  subject,
  actor: "operator",
  decidedAt: "2026-09-30T00:00:00.000Z",
  mutationEpoch: epoch,
  ...extra,
} as DecisionRecordShape);

/** Drives a task to VERIFYING so the VERIFIED gate is reachable. */
function toVerifying(graph: TaskGraph, id: string): void {
  assert.equal(graph.transition(taskId(id), "IN_PROGRESS").kind, "accepted");
  assert.equal(graph.transition(taskId(id), "VERIFYING").kind, "accepted");
}

test("P3: a missing operator decision refuses VERIFIED with source 'decision'", () => {
  const graph = new TaskGraph([
    task("A", { requiredDecisions: [{ authority: "operator", subject: "release" }] }),
  ]);
  toVerifying(graph, "A");

  const refusal = graph.transition(taskId("A"), "VERIFIED", operatorAttribution);
  assert.equal(refusal.kind, "rejected");
  if (refusal.kind !== "rejected") return;
  assert.equal(refusal.code, "DECISION_REQUIRED");
  assert.deepEqual(refusal.missing, [
    { source: "decision", authority: "operator", subject: "release", why: "no operator decision observed" },
  ]);
  // State did not advance (fail closed, no consumption).
  assert.equal(graph.get(taskId("A")).state, "VERIFYING");
});

test("P3: a matching operator decision opens the decision gate", () => {
  const graph = new TaskGraph([
    task("A", { requiredDecisions: [{ authority: "operator", subject: "release" }] }),
  ]);
  toVerifying(graph, "A");

  const accepted = graph.transition(taskId("A"), "VERIFIED", operatorAttribution, undefined, [
    decision("release", graph.mutationEpoch),
  ]);
  assert.equal(accepted.kind, "accepted");
  assert.equal(graph.get(taskId("A")).state, "VERIFIED");
});

test("P3: a decision NEVER opens an evidence gate", () => {
  const graph = new TaskGraph([
    task("A", { requiredEvidence: [{ authority: "environment", subject: "tests" }] }),
  ]);
  toVerifying(graph, "A");

  // An operator decision naming the evidence subject is not evidence.
  const refusal = graph.transition(taskId("A"), "VERIFIED", operatorAttribution, undefined, [
    decision("tests", graph.mutationEpoch),
  ]);
  assert.equal(refusal.kind, "rejected");
  if (refusal.kind !== "rejected") return;
  assert.equal(refusal.code, "EVIDENCE_REQUIRED");
  assert.equal(graph.get(taskId("A")).state, "VERIFYING");
});

test("P3: evidence NEVER opens a decision gate", () => {
  const graph = new TaskGraph([
    task("A", {
      requiredEvidence: [],
      requiredDecisions: [{ authority: "operator", subject: "release" }],
    }),
  ]);
  toVerifying(graph, "A");
  const passingEvidence: Evidence = {
    id: evidenceId("ev-1"),
    observationId: observationId("obs-1"),
    authority: "environment",
    subject: "release",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: graph.mutationEpoch,
    observedAt: "2026-09-30T00:00:00.000Z",
  };
  graph.recordEvidence(passingEvidence);

  const refusal = graph.transition(taskId("A"), "VERIFIED", operatorAttribution);
  assert.equal(refusal.kind, "rejected");
  if (refusal.kind !== "rejected") return;
  assert.equal(refusal.code, "DECISION_REQUIRED");
});

test("P3: a malformed operator decision refuses fail-closed", () => {
  const graph = new TaskGraph([
    task("A", { requiredDecisions: [{ authority: "operator", subject: "release" }] }),
  ]);
  toVerifying(graph, "A");

  const refusal = graph.transition(taskId("A"), "VERIFIED", operatorAttribution, undefined, [
    decision("   ", graph.mutationEpoch),
  ]);
  assert.equal(refusal.kind, "rejected");
  if (refusal.kind === "rejected") assert.equal(refusal.code, "DECISION_MALFORMED");
  assert.equal(graph.get(taskId("A")).state, "VERIFYING");
});

test("P3: a stale operator decision refuses fail-closed", () => {
  const graph = new TaskGraph([
    task("A", { requiredDecisions: [{ authority: "operator", subject: "release" }] }),
  ]);
  toVerifying(graph, "A");
  graph.recordMutation(["unrelated"]);
  assert.equal(graph.mutationEpoch, 1);

  const refusal = graph.transition(taskId("A"), "VERIFIED", operatorAttribution, undefined, [
    decision("release", 0),
  ]);
  assert.equal(refusal.kind, "rejected");
  if (refusal.kind === "rejected") assert.equal(refusal.code, "DECISION_STALE");
  assert.equal(graph.get(taskId("A")).state, "VERIFYING");
});

test("P3: an actor-mismatched operator decision refuses fail-closed", () => {
  const graph = new TaskGraph([
    task("A", { requiredDecisions: [{ authority: "operator", subject: "release" }] }),
  ]);
  toVerifying(graph, "A");

  const refusal = graph.transition(taskId("A"), "VERIFIED", operatorAttribution, undefined, [
    decision("release", graph.mutationEpoch, { actor: "agent" }),
  ]);
  assert.equal(refusal.kind, "rejected");
  if (refusal.kind === "rejected") assert.equal(refusal.code, "DECISION_ACTOR_MISMATCH");
  assert.equal(graph.get(taskId("A")).state, "VERIFYING");
});

test("P3: a client-supplied producing-flow pointer is rejected", () => {
  const graph = new TaskGraph([
    task("A", { requiredDecisions: [{ authority: "operator", subject: "release" }] }),
  ]);
  toVerifying(graph, "A");

  const refusal = graph.transition(taskId("A"), "VERIFIED", operatorAttribution, undefined, [
    decision("release", graph.mutationEpoch, { producingFlow: { flow: "client-invented" } }),
  ]);
  assert.equal(refusal.kind, "rejected");
  if (refusal.kind === "rejected") assert.equal(refusal.code, "DECISION_MALFORMED");
});

test("P3: the authority-recorded producing-flow pointer surfaces on an evidence refusal (inert)", () => {
  const pointer = { flow: "hub-test-runner" };
  const graph = new TaskGraph([
    task("A", { requiredEvidence: [{ authority: "environment", subject: "tests", producingFlow: pointer }] }),
  ]);
  toVerifying(graph, "A");

  const refusal = graph.transition(taskId("A"), "VERIFIED");
  assert.equal(refusal.kind, "rejected");
  if (refusal.kind !== "rejected") return;
  assert.equal(refusal.code, "EVIDENCE_REQUIRED");
  assert.deepEqual(refusal.missing, [
    { authority: "environment", subject: "tests", why: "no evidence observed", producingFlow: pointer },
  ]);
});

test("P3: the authority-recorded producing-flow pointer surfaces on a decision refusal (inert)", () => {
  const pointer = { flow: "operator-decision-route" };
  const graph = new TaskGraph([
    task("A", { requiredDecisions: [{ authority: "operator", subject: "release", producingFlow: pointer }] }),
  ]);
  toVerifying(graph, "A");

  const refusal = graph.transition(taskId("A"), "VERIFIED", operatorAttribution);
  assert.equal(refusal.kind, "rejected");
  if (refusal.kind !== "rejected") return;
  assert.deepEqual(refusal.missing, [
    { source: "decision", authority: "operator", subject: "release", why: "no operator decision observed", producingFlow: pointer },
  ]);
});

test("P3: the application authority is the seam that admits an operator decision", () => {
  const graph = new TaskGraph([
    task("A", { requiredDecisions: [{ authority: "operator", subject: "release" }] }),
  ]);
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
  assert.equal(application.transition(taskId("A"), "IN_PROGRESS").kind, "accepted");
  assert.equal(application.transition(taskId("A"), "VERIFYING").kind, "accepted");

  const refused = application.transition(taskId("A"), "VERIFIED", operatorAttribution);
  assert.equal(refused.kind, "rejected");
  if (refused.kind === "rejected") assert.equal(refused.code, "DECISION_REQUIRED");

  const accepted = application.transition(taskId("A"), "VERIFIED", operatorAttribution, undefined, [
    decision("release", graph.mutationEpoch),
  ]);
  assert.equal(accepted.kind, "accepted");
  assert.equal(graph.get(taskId("A")).state, "VERIFIED");
});
