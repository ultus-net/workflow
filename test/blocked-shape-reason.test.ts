import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskGraph,
  taskId,
  type BlockedRecord,
  type WorkflowTask,
} from "../src/index.js";

const task = (id: string, dependencies: readonly string[] = []): WorkflowTask => ({
  id: taskId(id),
  title: id,
  state: "BLOCKED",
  dependencies: dependencies.map(taskId),
  requiredEvidence: [],
});

const agentBlock = (overrides: Partial<BlockedRecord> = {}): BlockedRecord => ({
  owner: "agent",
  action: "resume once the operator answers in the thread",
  reason: "awaiting the design decision",
  enteredAt: "2026-09-27T12:00:00.000Z",
  ...overrides,
});

const agentBlockWithoutReason = (): BlockedRecord => ({
  owner: "agent",
  action: "resume once the operator answers in the thread",
  enteredAt: "2026-09-27T12:00:00.000Z",
});

// Review follow-up (W166 minor-gates P3-1): admission refuses a non-string
// reason while the persisted/constructed shape assert did not — a record
// refused at ADMISSION must not be silently accepted at RESTORE/CONSTRUCTION.

test("restore refuses a persisted blocked record whose reason is not a string (shape TypeError)", () => {
  const record = agentBlock({ reason: 42 as unknown as string });
  assert.throws(
    () => TaskGraph.restore({ tasks: [{ ...task("A"), state: "BLOCKED", blocked: record }], evidence: [], mutationEpoch: 0 }),
    /malformed blocked record.*reason/,
  );
});

test("addTask refuses a constructed blocked record whose reason is not a string (shape TypeError)", () => {
  const graph = new TaskGraph([task("A")]);
  assert.throws(
    () => graph.addTask({ ...task("B"), blocked: agentBlock({ reason: null as unknown as string }) }),
    /malformed blocked record.*reason/,
  );
  assert.equal(graph.tasks().length, 1);
});

test("a string reason round-trips restore, and an absent reason stays legal", () => {
  const live = TaskGraph.restore({ tasks: [{ ...task("A"), state: "BLOCKED", blocked: agentBlock() }], evidence: [], mutationEpoch: 0 });
  assert.deepEqual(live.get(taskId("A")).blocked, agentBlock());

  const stale = TaskGraph.restore({ tasks: [{ ...task("B"), state: "READY", blocked: agentBlockWithoutReason() }], evidence: [], mutationEpoch: 0 });
  assert.deepEqual(stale.get(taskId("B")).blocked, agentBlockWithoutReason());
});
