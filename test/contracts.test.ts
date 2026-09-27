import assert from "node:assert/strict";
import test from "node:test";

import {
  evidenceId,
  mutationId,
  observationId,
  taskId,
  type Evidence,
  type WorkflowTask,
} from "../src/index.js";
import { TaskGraph } from "../src/kernel/task-graph.js";

test("domain identifiers reject empty values", () => {
  for (const createId of [taskId, evidenceId, observationId, mutationId]) {
    assert.throws(() => createId("  "), TypeError);
  }
});

// ── W157: the kernel transition-attribution contract ────────────────────────
// The kernel fabricates no attribution and reads no clock: a caller-supplied
// block rides the record verbatim, absence stays legal (the timeline renders
// the explicit unattributed state), and the graph stamps ONLY its own
// deterministic knowledge — the evidence-invalidation demotions — with the
// application's observation time.

test("W157: a caller-supplied attribution rides the accepted transition verbatim; absence stays legal", () => {
  const graph = new TaskGraph([{ id: taskId("t1"), title: "T1", state: "READY", dependencies: [], requiredEvidence: [] }]);
  const attributed = graph.transition(taskId("t1"), "IN_PROGRESS", {
    actor: "operator",
    authority: "operator task command (application authority)",
    observedAt: "2026-09-27T00:00:00.000Z",
  });
  assert.equal(attributed.kind, "accepted");
  if (attributed.kind === "accepted") {
    assert.deepEqual(attributed.transition.attribution, {
      actor: "operator",
      authority: "operator task command (application authority)",
      observedAt: "2026-09-27T00:00:00.000Z",
    }, "the block rides verbatim — the kernel adds and invents nothing");
  }
  const graph2 = new TaskGraph([{ id: taskId("t2"), title: "T2", state: "READY", dependencies: [], requiredEvidence: [] }]);
  const bare = graph2.transition(taskId("t2"), "IN_PROGRESS");
  assert.equal(bare.kind, "accepted");
  if (bare.kind === "accepted") {
    assert.equal("attribution" in bare.transition, false, "absence stays legal — the unattributed state is a contract citizen");
  }
});

test("W157: the invalidation demotions are stamped system/evidence-invalidation with the caller's observation time, or unattributed without one", () => {
  const makeVerifiedTask = (): TaskGraph => {
    const graph = new TaskGraph([
      { id: taskId("v"), title: "V", state: "IN_PROGRESS", dependencies: [], requiredEvidence: [{ authority: "environment", subject: "test:v" }] },
    ]);
    const promoted = graph.transition(taskId("v"), "VERIFYING");
    assert.equal(promoted.kind, "accepted");
    graph.recordEvidence({
      id: evidenceId("ev:v"),
      observationId: observationId("obs:v"),
      authority: "environment",
      subject: "test:v",
      result: "passed",
      freshness: "fresh",
      mutationEpoch: graph.mutationEpoch,
      observedAt: "2026-09-27T00:00:00.000Z",
    });
    const verified = graph.transition(taskId("v"), "VERIFIED");
    assert.equal(verified.kind, "accepted");
    return graph;
  };
  const withTime = makeVerifiedTask().recordMutation(["test:v"], "2026-09-27T01:00:00.000Z");
  const demoted = withTime.find((row) => row.from === "VERIFIED");
  assert.ok(demoted !== undefined, "the invalidation demoted the verified task");
  assert.deepEqual(demoted.attribution, {
    actor: "system",
    authority: "evidence invalidation (freshness)",
    observedAt: "2026-09-27T01:00:00.000Z",
  }, "the demotion is the system's deterministic doing; the time is the caller's");
  const withoutTime = makeVerifiedTask().recordMutation(["test:v"]);
  const bareDemotion = withoutTime.find((row) => row.from === "VERIFIED");
  assert.equal(bareDemotion === undefined || "attribution" in bareDemotion === false, true, "no caller time, no fabricated attribution");
});

test("task and evidence contracts bind verification data to explicit subjects", () => {
  const task: WorkflowTask = {
    id: taskId("W002"),
    title: "Define kernel contracts",
    state: "READY",
    dependencies: [],
    requiredEvidence: [{ authority: "environment", subject: "typecheck" }],
  };
  const evidence: Evidence = {
    id: evidenceId("ev-1"),
    observationId: observationId("obs-1"),
    authority: "environment",
    subject: "typecheck",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: 0,
    observedAt: "2026-09-11T00:00:00.000Z",
  };

  assert.equal(task.requiredEvidence[0]?.subject, evidence.subject);
  assert.equal(evidence.result, "passed");
});
