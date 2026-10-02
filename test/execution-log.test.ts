import assert from "node:assert/strict";
import test from "node:test";

import { taskId, stepId, type TaskId, type TaskState } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import {
  ExecutionLog,
  replay,
  type ExecutionLogDraft,
  type ExecutionLogEntry,
} from "../src/kernel/execution-log.js";

const T = taskId("t1");
const OTHER = taskId("t2");

function transition(to: TaskState, from: TaskState, task = T): ExecutionLogDraft {
  return { kind: "transition", at: "2026-10-02T00:00:00Z", taskId: task, from, to };
}

test("append assigns a monotonic seq starting at zero", () => {
  const log = new ExecutionLog();
  assert.equal(log.append(transition("IN_PROGRESS", "READY")).seq, 0);
  assert.equal(log.append(transition("VERIFYING", "IN_PROGRESS")).seq, 1);
  assert.equal(log.append({
    kind: "evidence",
    at: "2026-10-02T00:00:01Z",
    taskId: T,
    summary: "typecheck passed",
  }).seq, 2);
});

test("a supplied seq that is not exactly next is rejected", () => {
  const log = new ExecutionLog();
  log.append(transition("IN_PROGRESS", "READY")); // seq 0
  assert.throws(() => log.append({ ...transition("VERIFYING", "IN_PROGRESS"), seq: 5 }), TypeError);
  assert.throws(() => log.append({ ...transition("VERIFYING", "IN_PROGRESS"), seq: 0 }), TypeError);
  // Nothing was appended by the rejected calls.
  assert.equal(log.entries().length, 1);
  assert.equal(log.append({ ...transition("VERIFYING", "IN_PROGRESS"), seq: 1 }).seq, 1);
});

test("prior entries cannot be mutated through the returned array", () => {
  const log = new ExecutionLog();
  const appended = log.append(transition("IN_PROGRESS", "READY"));
  assert.ok(Object.isFrozen(appended));
  const first = log.entries();
  assert.equal(first.length, 1);
  (first as ExecutionLogEntry[]).push(transition("FAILED", "IN_PROGRESS") as ExecutionLogEntry);
  (first as ExecutionLogEntry[]).length = 0;
  assert.equal(log.entries().length, 1);
  assert.equal(log.entries()[0]?.seq, 0);
});

test("replay reconstructs the same final state map as the live transitions", () => {
  const graph = new TaskGraph([
    { id: T, title: "Task", state: "READY", dependencies: [], requiredEvidence: [] },
  ]);
  const initial = new Map<TaskId, TaskState>([[T, "READY"]]);
  const log = new ExecutionLog();
  for (const [to, from] of [["IN_PROGRESS", "READY"], ["FAILED", "IN_PROGRESS"], ["READY", "FAILED"], ["IN_PROGRESS", "READY"]] as const) {
    const result = graph.transition(T, to);
    assert.equal(result.kind, "accepted");
    log.append(transition(to, from));
  }
  const replayed = replay(log.entries(), initial);
  for (const task of graph.tasks()) {
    assert.equal(replayed.get(task.id), task.state);
  }
  assert.equal(replayed.get(T), "IN_PROGRESS");
});

test("replay is deterministic: two runs over the same log are equal", () => {
  const log = new ExecutionLog();
  log.append(transition("IN_PROGRESS", "READY"));
  log.append(transition("VERIFYING", "IN_PROGRESS"));
  const initial = new Map<TaskId, TaskState>([[T, "READY"]]);
  const a = replay(log.entries(), initial);
  const b = replay(log.entries(), initial);
  assert.deepEqual([...a.entries()], [...b.entries()]);
  // The projection did not mutate the caller's initial map.
  assert.equal(initial.get(T), "READY");
});

test("evidence and step entries are retained in order but do not affect replay", () => {
  const log = new ExecutionLog();
  log.append(transition("IN_PROGRESS", "READY"));
  log.append({ kind: "evidence", at: "2026-10-02T00:00:01Z", taskId: T, summary: "tests passed", ref: "store-key" });
  log.append({ kind: "step", at: "2026-10-02T00:00:02Z", taskId: T, stepId: stepId("s1"), from: "IN_PROGRESS", to: "COMPLETED" });
  log.append(transition("VERIFYING", "IN_PROGRESS"));
  assert.deepEqual(log.entries().map((entry) => entry.kind), ["transition", "evidence", "step", "transition"]);
  const replayed = replay(log.entries(), new Map<TaskId, TaskState>([[T, "READY"]]));
  assert.equal(replayed.get(T), "VERIFYING");
});

test("replay refuses a transition for a task absent from the initial states", () => {
  const log = new ExecutionLog();
  log.append(transition("IN_PROGRESS", "READY", OTHER));
  assert.throws(
    () => replay(log.entries(), new Map<TaskId, TaskState>([[T, "READY"]])),
    /unknown task/,
  );
});

test("forTask filters entries by task and preserves append order", () => {
  const log = new ExecutionLog();
  log.append(transition("IN_PROGRESS", "READY", T));
  log.append(transition("IN_PROGRESS", "READY", OTHER));
  log.append(transition("VERIFYING", "IN_PROGRESS", T));
  const mine = log.forTask(T);
  assert.deepEqual(mine.map((entry) => entry.seq), [0, 2]);
  assert.deepEqual(log.forTask(OTHER).map((entry) => entry.seq), [1]);
  assert.equal(log.forTask(taskId("absent")).length, 0);
});
