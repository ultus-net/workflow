import assert from "node:assert/strict";
import test from "node:test";

import { taskId, stepId, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { hostCapabilities } from "../src/application/host.js";

const T = taskId("t1");
const U = taskId("t2");
const DONE = { authority: "environment" as const, subject: "step:done" };

function task(id = T): WorkflowTask {
  return { id, title: String(id), state: "READY", dependencies: [], requiredEvidence: [] };
}

function application(...tasks: readonly WorkflowTask[]): WorkflowApplication {
  return new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
}

function inProgress(app: WorkflowApplication, id = T): void {
  assert.equal(app.transition(id, "IN_PROGRESS").kind, "accepted");
}

test("projection carries the task's active step while one is IN_PROGRESS", () => {
  const app = application(task());
  inProgress(app);
  const [step] = app.defineTaskSteps(T, [{ content: "edit", requiredEvidence: [DONE] }]);
  assert.ok(step !== undefined);
  assert.equal(app.startTaskStep(step.id).kind, "accepted");

  const projected = app.snapshot().tasks.find((projection) => projection.id === T);
  assert.equal(projected?.stepId, stepId("t1-step-1"));
});

test("projection omits stepId when no step is IN_PROGRESS", () => {
  const app = application(task());
  inProgress(app);
  app.defineTaskSteps(T, [{ content: "edit", requiredEvidence: [DONE] }]);

  const projected = app.snapshot().tasks.find((projection) => projection.id === T);
  assert.ok(projected !== undefined);
  assert.equal("stepId" in projected, false, "a PENDING-only ledger projects no active step");
});

test("two tasks each project their own active step", () => {
  const app = application(task(T), task(U));
  inProgress(app, T);
  inProgress(app, U);
  const [first] = app.defineTaskSteps(T, [{ content: "first", requiredEvidence: [DONE] }]);
  const [second] = app.defineTaskSteps(U, [{ content: "second", requiredEvidence: [DONE] }]);
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(app.startTaskStep(first.id).kind, "accepted");
  assert.equal(app.startTaskStep(second.id).kind, "accepted");

  const byId = new Map(app.snapshot().tasks.map((projection) => [projection.id, projection]));
  assert.equal(byId.get(T)?.stepId, first.id);
  assert.equal(byId.get(U)?.stepId, second.id);
});
