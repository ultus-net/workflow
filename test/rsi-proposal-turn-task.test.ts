// fix/hub-proposal-task-lifecycle: the RSI proposal turn's bookkeeping task
// shares the hub's single kernel graph with everything else. A task left
// IN_PROGRESS after the turn collides with the run begin's own IN_PROGRESS
// task — the next activation fails closed with "multiple IN_PROGRESS tasks
// require an explicit active task selection" and the loop dies at iters=0
// (observed live 2026-09-26, lesson 98dd6a33 — that live failure is the red).
// This file pins the repair contract: a proposal turn's task is opened per
// turn and closed (VERIFIED on success / FAILED on error) so activation
// recovers.
import test from "node:test";
import assert from "node:assert/strict";

import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId } from "../src/kernel/contracts.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { beginProposalTurnTask } from "../src/integrations/self-improvement-agent.js";

const WS = "/tmp/rsi-proposal-turn-task-test";

function compose() {
  const graph = new TaskGraph([
    { id: taskId("interactive"), title: "Interactive coding session", state: "READY", dependencies: [], requiredEvidence: [] },
  ]);
  const host = hostCapabilities({ transport: "native", authoritativePreMutation: true });
  return { graph, host };
}

test("beginProposalTurnTask opens the task IN_PROGRESS and selects it", () => {
  const { graph, host } = compose();
  const app = new WorkflowApplication(graph, host, [], new Set(["read"]), WS);
  const turn = beginProposalTurnTask(app);
  assert.equal(graph.get(turn.taskId).state, "IN_PROGRESS");
  assert.equal(app.activeTaskId(), turn.taskId);
});

test("a proposal task left IN_PROGRESS poisons activation; completing it repairs it", () => {
  const { graph, host } = compose();
  const app = new WorkflowApplication(graph, host, [], new Set(["read"]), WS);
  const turn = beginProposalTurnTask(app);

  // The run begin's own task goes IN_PROGRESS on the shared graph.
  const app2 = new WorkflowApplication(graph, host, [], new Set(["read", "mutation", "process"]), WS);
  const runId = taskId("run:candidate-1");
  app2.addTask({ id: runId, title: "run", dependencies: [], requiredEvidence: [] });
  app2.transition(runId, "IN_PROGRESS");

  // A fresh application's activation now fails closed (the observed loop death).
  const app3 = new WorkflowApplication(graph, host, [], new Set(["read"]), WS);
  assert.throws(() => app3.startInteractiveTask(), /multiple IN_PROGRESS tasks require an explicit active task selection/);

  // The repair: the proposal turn's task completes; activation recovers.
  turn.complete();
  assert.equal(graph.get(turn.taskId).state, "VERIFIED");
  assert.equal(app3.startInteractiveTask(), runId);
});

test("a failed proposal turn ends FAILED and also unblocks activation", () => {
  const { graph, host } = compose();
  const app = new WorkflowApplication(graph, host, [], new Set(["read"]), WS);
  const turn = beginProposalTurnTask(app);
  turn.fail();
  assert.equal(graph.get(turn.taskId).state, "FAILED");
  const app2 = new WorkflowApplication(graph, host, [], new Set(["read"]), WS);
  assert.doesNotThrow(() => app2.startInteractiveTask());
});

test("each turn opens a fresh task — a completed earlier turn never blocks the next", () => {
  const { graph, host } = compose();
  const app = new WorkflowApplication(graph, host, [], new Set(["read"]), WS);
  const turn1 = beginProposalTurnTask(app);
  turn1.complete();
  const turn2 = beginProposalTurnTask(app);
  assert.notEqual(turn2.taskId, turn1.taskId);
  assert.equal(graph.get(turn2.taskId).state, "IN_PROGRESS");
  turn2.complete();
  assert.equal(graph.get(turn2.taskId).state, "VERIFIED");
});