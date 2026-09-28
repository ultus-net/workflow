import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskGraph,
  evidenceId,
  observationId,
  taskId,
  type BlockedRecord,
  type Evidence,
  type TransitionAttribution,
  type WorkflowTask,
} from "../src/index.js";

const task = (id: string, dependencies: readonly string[] = []): WorkflowTask => ({
  id: taskId(id),
  title: id,
  state: "BLOCKED",
  dependencies: dependencies.map(taskId),
  requiredEvidence: [],
});

const agentSays = (authority = "agent turn (W166 pin)"): TransitionAttribution => ({
  actor: "agent",
  authority,
  observedAt: "2026-09-27T12:00:00.000Z",
});

const agentBlock = (): BlockedRecord => ({
  owner: "agent",
  action: "resume once the operator answers in the thread",
  reason: "awaiting the design decision",
  enteredAt: "2026-09-27T12:00:00.000Z",
});

function evidence(subject: string, epoch: number): Evidence {
  return {
    id: evidenceId(`ev-${subject}-${epoch}`),
    observationId: observationId(`obs-${subject}-${epoch}`),
    authority: "environment",
    subject,
    result: "passed",
    freshness: "fresh",
    mutationEpoch: epoch,
    observedAt: "2026-09-27T00:00:00.000Z",
  };
}

// W166 P2-1 (the recorded kernel review follow-up on 54e307d): the FAILED →
// BLOCKED recordless retry spreads the task's carried record (transition()'s
// `{ ...task, state: requested }`), and recordHolds then treats it as live.
// The lie: a resolved blocked record resurrected by a retry must not hold the
// task in BLOCKED / must not read as an owed action. The record already exited
// live once (the graph resolved on its own and the record rides as stale
// context), and the retry path is dependency-derived by construction — a
// record there is misplaced (blocked-admission's BLOCKED_RECORD_MISPLACED pin
// refuses a caller-supplied one) — so the carried stale record must leave with
// the re-entry instead of governing it. The product path dodges this
// (retryFailedTask routes dependency-ready failures to READY), but the kernel
// accepts the recordless FAILED → BLOCKED directly.
test("W166 P2-1: a resolved blocked record resurrected by a recordless retry must not hold the task in BLOCKED or read as an owed action", () => {
  const graph = new TaskGraph([
    { ...task("A"), requiredEvidence: [{ authority: "environment", subject: "build" }] },
    task("B", ["A"]),
  ]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  graph.transition(taskId("A"), "VERIFYING");
  graph.recordEvidence(evidence("build", graph.mutationEpoch));
  graph.transition(taskId("A"), "VERIFIED");
  // B's initial dependency-derived block exits on its own.
  assert.equal(graph.get(taskId("B")).state, "READY");
  // B admits a live record against the dependency-ready steady state.
  graph.transition(taskId("B"), "IN_PROGRESS");
  assert.equal(graph.transition(taskId("B"), "BLOCKED", agentSays(), agentBlock()).kind, "accepted");
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
  // The dependency un-verifies and re-verifies: the graph resolves on its own
  // and the record exits automatically, riding as stale context (the W166
  // automatic-exit shape blocked-admission already pins).
  graph.recordMutation(["build"]);
  graph.recordEvidence(evidence("build", graph.mutationEpoch));
  graph.transition(taskId("A"), "VERIFIED");
  assert.equal(graph.get(taskId("B")).state, "READY");
  assert.ok(graph.get(taskId("B")).blocked !== undefined);
  // B fails its own work and retries recordless into BLOCKED.
  graph.transition(taskId("B"), "IN_PROGRESS");
  graph.transition(taskId("B"), "FAILED");
  assert.equal(graph.transition(taskId("B"), "BLOCKED").kind, "accepted");
  // The resolved record must not come back as a live block: the task owes no
  // action (the graph is resolved and had already released the record once),
  // so the retry lands recordless and dependency-ready — READY, not a held
  // BLOCKED with an owed action the owner never re-named.
  assert.equal(graph.get(taskId("B")).blocked, undefined);
  assert.equal(graph.get(taskId("B")).state, "READY");
});
