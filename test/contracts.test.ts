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

test("domain identifiers reject empty values", () => {
  for (const createId of [taskId, evidenceId, observationId, mutationId]) {
    assert.throws(() => createId("  "), TypeError);
  }
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
