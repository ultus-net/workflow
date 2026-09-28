import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskGraph,
  taskId,
  type BlockedRecord,
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

const agentSays: TransitionAttribution = {
  actor: "agent",
  authority: "agent turn (W166 P2-2 pin)",
  observedAt: "2026-09-27T12:00:00.000Z",
};

const agentBlock: BlockedRecord = {
  owner: "agent",
  action: "resume once the operator answers in the thread",
  enteredAt: "2026-09-27T12:00:00.000Z",
};

// W166 P2-2 (guard): a directly-constructed IN_PROGRESS admission diverges from
// its accepted result — the five-axis review of 54e307d's recorded follow-up.
// #seedReadiness seeds #lastReady from dependency states at construction
// (task-graph.ts:673-678), and #recomputeReadiness updates it only for
// READY/BLOCKED tasks, skipping IN_PROGRESS (task-graph.ts:649-651), so a task
// constructed IN_PROGRESS over a non-VERIFIED dependency keeps lastReady=false
// while its dependencies resolve. The admission then reports accepted/to:BLOCKED,
// yet the same call's recompute sees ready=true with lastReady=false — the
// graph-resolved auto-exit fires — and flip-reverts the task to READY. The
// review found this shape unreachable via product paths; re-verified on
// main@d4f9320, site by site:
//   - graph.addTask's only src/ caller forces BLOCKED (workflow.ts:317); the
//     application addTask takes Omit<WorkflowTask, "state">, so its five call
//     sites (task-commands.ts:83, web.ts:768, opencode-server-authority.ts:111,
//     self-improvement-agent.ts:72, run-registry.ts:422) cannot express a state.
//   - restore coerces IN_PROGRESS→FAILED before construction
//     (task-graph.ts:117-120); persistence.ts:24 is the only src/ caller.
//   - direct TaskGraph literals: hub.ts:56 and universal-tui.tsx:36 seed READY;
//     web-service.ts:37 and contained-shell.ts:48 seed BLOCKED (a BLOCKED task
//     can never take an admission); opencode-server.ts:196 is empty;
//     acp-tui.tsx:36 and ink-tui.tsx:120 construct IN_PROGRESS but seed
//     lastReady=true (deps [] is vacuously ready; ink-tui's W003 depends on a
//     VERIFIED W001). No product site seeds lastReady=false on IN_PROGRESS —
//     the only such shape is the webui demo fixture
//     (fixtures/webui-demo-server.ts:29), test-only and never admitted BLOCKED.
// This test constructs the shape directly — the only way to reach it — and
// pins the divergence exactly so it cannot silently become reachable.
test("W166 P2-2 (guard): the directly-constructed IN_PROGRESS admission returns accepted/to:BLOCKED while the same recompute flip-reverts to READY", () => {
  const graph = new TaskGraph([
    task("A"),
    { ...task("B"), state: "IN_PROGRESS", dependencies: [taskId("A")] },
  ]);
  // lastReady[B] seeded false (A is not VERIFIED at construction) and frozen
  // there: every recompute pass skips IN_PROGRESS. A's recordless block
  // resolves by design; A then verifies — B stays IN_PROGRESS throughout.
  graph.transition(taskId("A"), "IN_PROGRESS");
  graph.transition(taskId("A"), "VERIFYING");
  graph.transition(taskId("A"), "VERIFIED");
  assert.equal(graph.get(taskId("B")).state, "IN_PROGRESS");

  const admission = graph.transition(taskId("B"), "BLOCKED", agentSays, agentBlock);
  assert.equal(admission.kind, "accepted");
  if (admission.kind !== "accepted") return;
  assert.equal(admission.transition.from, "IN_PROGRESS");
  assert.equal(admission.transition.to, "BLOCKED");
  // The same recompute pass released the record (graphResolved) and the task
  // flip-reverted to READY behind the accepted result — the divergence.
  assert.equal(graph.get(taskId("B")).state, "READY");
  // The automatic exit does not consume the record: it rides as stale context.
  assert.ok(graph.get(taskId("B")).blocked !== undefined);
});
