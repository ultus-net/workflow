import assert from "node:assert/strict";
import test from "node:test";

import {
  evidenceId,
  observationId,
  stepId,
  taskId,
  type Evidence,
  type WorkflowTask,
} from "../src/kernel/contracts.js";
import { TaskGraph, isRunComplete } from "../src/kernel/task-graph.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { hostCapabilities } from "../src/application/host.js";

const T = taskId("t1");
const DONE = { authority: "environment" as const, subject: "step:done" };

function task(): WorkflowTask {
  return { id: T, title: "Task", state: "READY", dependencies: [], requiredEvidence: [] };
}

function evidence(subject: string, epoch = 0): Evidence {
  return {
    id: evidenceId(`e-${subject}`),
    observationId: observationId(`o-${subject}`),
    authority: "environment",
    subject,
    result: "passed",
    freshness: "fresh",
    mutationEpoch: epoch,
    observedAt: new Date().toISOString(),
  };
}

function inProgressTask(): TaskGraph {
  const graph = new TaskGraph([task()]);
  assert.equal(graph.transition(T, "IN_PROGRESS").kind, "accepted");
  return graph;
}

test("defineSteps assigns stable ids and starts every step PENDING", () => {
  const graph = inProgressTask();
  const steps = graph.defineSteps(T, [{ content: "first", requiredEvidence: [DONE] }, { content: "second", requiredEvidence: [DONE] }]);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((step) => step.state), ["PENDING", "PENDING"]);
  assert.notEqual(steps[0]?.id, steps[1]?.id);
});

test("explicit step ids cannot overwrite a step owned by another task", () => {
  const other = taskId("other");
  const graph = new TaskGraph([task(), { ...task(), id: other }]);
  const [foreign] = graph.defineSteps(other, [{ id: "shared", content: "foreign", requiredEvidence: [DONE] }]);
  assert.ok(foreign !== undefined);
  assert.throws(() => graph.defineSteps(T, [{ id: "shared", content: "collision", requiredEvidence: [DONE] }]), /belongs to task/);
  assert.equal(graph.step(foreign.id).taskId, other);
});

test("an existing ledger cannot be cleared to escape the step gate", () => {
  const graph = inProgressTask();
  graph.defineSteps(T, [{ content: "keep", requiredEvidence: [DONE] }]);
  assert.throws(() => graph.defineSteps(T, []), /cannot clear task/);
});

test("I-8: a task cannot start two steps concurrently", () => {
  const graph = inProgressTask();
  const [a, b] = graph.defineSteps(T, [{ content: "a", requiredEvidence: [DONE] }, { content: "b", requiredEvidence: [DONE] }]);
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(graph.startStep(a.id).kind, "accepted");
  const second = graph.startStep(b.id);
  assert.equal(second.kind, "rejected");
  if (second.kind === "rejected") assert.equal(second.code, "STEP_ALREADY_IN_PROGRESS");
});

test("I-2: an active step cannot be silently removed from the ledger", () => {
  const graph = inProgressTask();
  const [first, second] = graph.defineSteps(T, [{ content: "first", requiredEvidence: [DONE] }, { content: "second", requiredEvidence: [DONE] }]);
  assert.ok(first !== undefined && second !== undefined);
  graph.startStep(first.id);
  // Re-submitting the ledger without the active first step must throw.
  assert.throws(
    () => graph.defineSteps(T, [{ id: second.id, content: "second", requiredEvidence: [DONE] }]),
    /without being completed or cancelled/,
  );
  // It may leave the ledger only after an explicit terminal transition.
  assert.equal(graph.cancelStep(first.id).kind, "accepted");
  assert.doesNotThrow(() => graph.defineSteps(T, [{ id: second.id, content: "second", requiredEvidence: [DONE] }]));
});

test("I-3: completion requires fresh passing evidence for the step's requirements", () => {
  const graph = inProgressTask();
  const [step] = graph.defineSteps(T, [{ content: "edit", requiredEvidence: [{ authority: "environment", subject: "step:s1" }] }]);
  assert.ok(step !== undefined);
  assert.equal(graph.startStep(step.id).kind, "accepted");

  const without = graph.completeStep(step.id);
  assert.equal(without.kind, "rejected");
  if (without.kind === "rejected") assert.equal(without.code, "STEP_EVIDENCE_REQUIRED");

  graph.recordEvidence(evidence("step:s1"));
  const completed = graph.completeStep(step.id);
  assert.equal(completed.kind, "accepted");
  assert.equal(graph.step(step.id).state, "COMPLETED");
});

test("I-3: a step cannot complete before it has started", () => {
  const graph = inProgressTask();
  const [step] = graph.defineSteps(T, [{ content: "pending", requiredEvidence: [DONE] }]);
  assert.ok(step !== undefined);
  const result = graph.completeStep(step.id);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.equal(result.code, "ILLEGAL_STEP_TRANSITION");
});

test("I-4: a task cannot reach VERIFYING while steps are open, and can once all are terminal", () => {
  const graph = inProgressTask();
  const [a, b] = graph.defineSteps(T, [{ content: "a", requiredEvidence: [DONE] }, { content: "b", requiredEvidence: [DONE] }]);
  assert.ok(a !== undefined && b !== undefined);

  graph.recordEvidence(evidence("step:done"));
  const early = graph.transition(T, "VERIFYING");
  assert.equal(early.kind, "rejected");
  if (early.kind === "rejected") assert.equal(early.code, "STEPS_OPEN");

  for (const step of [a, b]) {
    assert.equal(graph.startStep(step.id).kind, "accepted");
    assert.equal(graph.completeStep(step.id).kind, "accepted");
  }
  assert.equal(graph.transition(T, "VERIFYING").kind, "accepted");
});

test("I-1 support: activeStepId reports the in-progress step", () => {
  const graph = inProgressTask();
  const [a, b] = graph.defineSteps(T, [{ content: "a", requiredEvidence: [DONE] }, { content: "b", requiredEvidence: [DONE] }]);
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(graph.activeStepId(T), undefined);
  graph.startStep(b.id);
  assert.equal(graph.activeStepId(T), b.id);
});

test("isRunComplete requires every task VERIFIED and a non-empty graph", () => {
  assert.equal(isRunComplete([]), false);
  assert.equal(isRunComplete([{ ...task(), state: "READY" }]), false);
  assert.equal(isRunComplete([{ ...task(), state: "VERIFIED" }]), true);
  assert.equal(isRunComplete([{ ...task(), state: "VERIFIED" }, { ...task(), id: taskId("t2"), state: "IN_PROGRESS" }]), false);
});

test("persistence round-trips steps and rejects a completed step without evidence", () => {
  const graph = inProgressTask();
  const [step] = graph.defineSteps(T, [{ content: "edit", requiredEvidence: [{ authority: "environment", subject: "step:s1" }] }]);
  assert.ok(step !== undefined);
  graph.startStep(step.id);
  graph.recordEvidence(evidence("step:s1"));
  graph.completeStep(step.id);

  const persisted = graph.persistedState();
  const restored = TaskGraph.restore(persisted);
  assert.equal(restored.steps().length, 1);
  assert.equal(restored.step(step.id).state, "COMPLETED");

  // A forged persisted state cannot claim a step completed without evidence.
  assert.throws(
    () => TaskGraph.restore({
      ...persisted,
      steps: [{ id: stepId("s-bad"), taskId: T, content: "x", state: "COMPLETED", requiredEvidence: [{ authority: "environment", subject: "missing" }] }],
    }),
    /lacks fresh passing evidence/,
  );

  assert.throws(
    () => TaskGraph.restore({
      ...persisted,
      tasks: [{ ...persisted.tasks[0]!, state: "VERIFIED" }],
      steps: [{ ...step, state: "PENDING" }],
    }),
    /has open steps/,
  );
});

test("I-1: once a task declares a step ledger, mutations require an in-progress step", () => {
  const graph = new TaskGraph([task()]);
  const application = new WorkflowApplication(graph, hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  assert.equal(graph.transition(T, "IN_PROGRESS").kind, "accepted");

  const mutation = {
    sessionId: "s",
    taskId: T,
    tool: "write_file",
    mutating: true,
    subjects: ["src/a.ts"],
    input: {},
  };
  // No ledger yet: legacy active-task behavior allows the mutation.
  assert.equal(application.authorize(mutation).kind, "allow");

  const [step] = application.defineTaskSteps(T, [{ content: "edit a.ts", requiredEvidence: [DONE] }]);
  assert.ok(step !== undefined);
  const denied = application.authorize(mutation);
  assert.equal(denied.kind, "deny");
  if (denied.kind === "deny") assert.equal(denied.code, "NO_ACTIVE_STEP");

  assert.equal(application.startTaskStep(step.id).kind, "accepted");
  assert.equal(application.authorize(mutation).kind, "allow");
  assert.equal(application.isRunComplete(), false);
});