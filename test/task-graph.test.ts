import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskGraph,
  evidenceId,
  observationId,
  taskId,
  type Evidence,
  type WorkflowTask,
} from "../src/index.js";

const task = (id: string, dependencies: readonly string[] = []): WorkflowTask => ({
  id: taskId(id),
  title: id,
  state: "BLOCKED",
  dependencies: dependencies.map(taskId),
  requiredEvidence: [],
});

test("readiness is derived from dependency verification", () => {
  const graph = new TaskGraph([task("A"), task("B", ["A"])]);

  assert.equal(graph.get(taskId("A")).state, "READY");
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
  assert.equal(graph.transition(taskId("A"), "IN_PROGRESS").kind, "accepted");
  assert.equal(graph.transition(taskId("A"), "VERIFYING").kind, "accepted");
  assert.equal(graph.transition(taskId("A"), "VERIFIED").kind, "accepted");
  assert.equal(graph.get(taskId("B")).state, "READY");
});

test("illegal transitions have stable rejection codes", () => {
  const graph = new TaskGraph([task("A"), task("B", ["A"])]);

  const result = graph.transition(taskId("B"), "IN_PROGRESS");

  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.equal(result.code, "ILLEGAL_TRANSITION");
  }
});

test("graph rejects missing, self, and transitive cyclic dependencies", () => {
  assert.throws(() => new TaskGraph([task("A", ["missing"])]), /missing dependency/);
  assert.throws(() => new TaskGraph([task("A", ["A"])]), /depend on itself/);
  assert.throws(
    () => new TaskGraph([task("A", ["C"]), task("B", ["A"]), task("C", ["B"])]),
    /cycle/,
  );
});

test("adding a dependency re-blocks eligible downstream work", () => {
  const graph = new TaskGraph([task("A"), task("B")]);

  assert.equal(graph.get(taskId("B")).state, "READY");
  graph.addDependency(taskId("B"), taskId("A"));
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
});

test("adding a dependency rejects cycles without mutating the graph", () => {
  const graph = new TaskGraph([task("A"), task("B", ["A"])]);

  assert.throws(() => graph.addDependency(taskId("A"), taskId("B")), /cycle/);
  assert.deepEqual(graph.get(taskId("A")).dependencies, []);
});

test("adding a discovered task derives readiness and rejects invalid graph additions", () => {
  const graph = new TaskGraph([task("A")]);

  graph.addTask({
    id: taskId("B"),
    title: "Discovered prerequisite",
    state: "BLOCKED",
    dependencies: [taskId("A")],
    requiredEvidence: [],
  });
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
  assert.throws(
    () => graph.addTask({ ...task("C"), dependencies: [taskId("missing")] }),
    /missing dependency/,
  );
  assert.throws(() => graph.addTask(task("A")), /duplicate task/);
});

test("verification requires fresh passing evidence admitted at a valid mutation epoch", () => {
  const graph = new TaskGraph([
    {
      ...task("A"),
      requiredEvidence: [{ authority: "environment", subject: "typecheck" }],
    },
  ]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  graph.transition(taskId("A"), "VERIFYING");

  const missing = graph.transition(taskId("A"), "VERIFIED");
  assert.equal(missing.kind, "rejected");
  if (missing.kind === "rejected") assert.equal(missing.code, "EVIDENCE_REQUIRED");

  graph.recordEvidence(evidence("typecheck", "failed", graph.mutationEpoch));
  const failed = graph.transition(taskId("A"), "VERIFIED");
  assert.equal(failed.kind, "rejected");
  if (failed.kind === "rejected") assert.equal(failed.code, "EVIDENCE_REQUIRED");

  graph.recordEvidence(evidence("typecheck", "passed", graph.mutationEpoch));
  assert.equal(graph.transition(taskId("A"), "VERIFIED").kind, "accepted");
});

test("a relevant mutation invalidates evidence and verified task state", () => {
  const graph = new TaskGraph([
    {
      ...task("A"),
      requiredEvidence: [{ authority: "environment", subject: "typecheck" }],
    },
    task("B", ["A"]),
  ]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  graph.transition(taskId("A"), "VERIFYING");
  graph.recordEvidence(evidence("typecheck", "passed", graph.mutationEpoch));
  graph.transition(taskId("A"), "VERIFIED");
  assert.equal(graph.get(taskId("B")).state, "READY");

  graph.recordMutation(["typecheck"]);

  assert.equal(graph.get(taskId("A")).state, "VERIFYING");
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
  assert.equal(graph.evidenceFor("typecheck")[0]?.freshness, "stale");
});

test("an unrelated mutation does not invalidate fresh evidence", () => {
  const graph = new TaskGraph([{ ...task("A"), requiredEvidence: [{ authority: "environment", subject: "typecheck" }] }]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  graph.transition(taskId("A"), "VERIFYING");
  graph.recordEvidence(evidence("typecheck", "passed", graph.mutationEpoch));
  graph.recordMutation(["unrelated"]);
  assert.equal(graph.transition(taskId("A"), "VERIFIED").kind, "accepted");
  assert.equal(graph.evidenceFor("typecheck")[0]?.freshness, "fresh");
});

function evidence(subject: string, result: "passed" | "failed", epoch: number): Evidence {
  return {
    id: evidenceId(`ev-${subject}-${result}-${epoch}`),
    observationId: observationId(`obs-${subject}-${result}-${epoch}`),
    authority: "environment",
    subject,
    result,
    freshness: "fresh",
    mutationEpoch: epoch,
    observedAt: "2026-09-11T00:00:00.000Z",
  };
}
