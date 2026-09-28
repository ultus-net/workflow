import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskGraph,
  WorkflowApplication,
  evidenceId,
  hostCapabilities,
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

const operatorSays = (authority = "operator surface (W166 pin)"): TransitionAttribution => ({
  actor: "operator",
  authority,
  observedAt: "2026-09-27T12:00:00.000Z",
});

const agentBlock = (overrides: Partial<BlockedRecord> = {}): BlockedRecord => ({
  owner: "agent",
  action: "resume once the operator answers in the thread",
  reason: "awaiting the design decision",
  enteredAt: "2026-09-27T12:00:00.000Z",
  ...overrides,
});

const operatorBlock = (overrides: Partial<BlockedRecord> = {}): BlockedRecord => ({
  owner: "operator",
  action: "approve the design",
  enteredAt: "2026-09-27T12:00:00.000Z",
  ...overrides,
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

/** A task blocked for a REASON while its dependency is unresolved: the task
 * admitted itself BLOCKED from IN_PROGRESS after the dependency's evidence was
 * invalidated — the record rides on top of a dependency-derived block. */
function dualBlockedGraph(action = "resume once the build re-verifies"): TaskGraph {
  const graph = new TaskGraph([
    { ...task("A"), requiredEvidence: [{ authority: "environment", subject: "build" }] },
    task("B", ["A"]),
  ]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  graph.transition(taskId("A"), "VERIFYING");
  graph.recordEvidence(evidence("build", graph.mutationEpoch));
  graph.transition(taskId("A"), "VERIFIED");
  graph.transition(taskId("B"), "IN_PROGRESS");
  graph.recordMutation(["build"]);
  const result = graph.transition(taskId("B"), "BLOCKED", agentSays(), {
    owner: "agent",
    action,
    enteredAt: "2026-09-27T12:00:00.000Z",
  });
  assert.equal(result.kind, "accepted");
  return graph;
}

test("W166: an agent admits itself BLOCKED from IN_PROGRESS with a named owner + action; the record rides verbatim", () => {
  const graph = new TaskGraph([task("A"), task("B")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const result = graph.transition(taskId("A"), "BLOCKED", agentSays(), agentBlock());
  assert.equal(result.kind, "accepted");
  const blocked = graph.get(taskId("A"));
  assert.equal(blocked.state, "BLOCKED");
  // Purity: the record is plain caller data — enteredAt round-trips verbatim
  // (an arbitrary caller string, not a kernel clock read).
  assert.deepEqual(blocked.blocked, agentBlock());
  if (result.kind === "accepted") {
    assert.equal(result.transition.from, "IN_PROGRESS");
    assert.equal(result.transition.to, "BLOCKED");
    // W157: the caller's attribution rides the accepted record verbatim.
    assert.deepEqual(result.transition.attribution, agentSays());
  }
});

test("W166: admission fails closed without a record (BLOCKED_RECORD_REQUIRED)", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const result = graph.transition(taskId("A"), "BLOCKED", agentSays());
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.equal(result.code, "BLOCKED_RECORD_REQUIRED");
  assert.equal(graph.get(taskId("A")).state, "IN_PROGRESS");
});

test("W166: admission fails closed without attribution — the kernel cannot verify self-naming (BLOCKED_OWNER_UNVERIFIED)", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const result = graph.transition(taskId("A"), "BLOCKED", undefined, agentBlock());
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.equal(result.code, "BLOCKED_OWNER_UNVERIFIED");
  assert.equal(graph.get(taskId("A")).state, "IN_PROGRESS");
});

test("W166: an agent cannot volunteer another actor as the unblock owner (BLOCKED_OWNER_MISMATCH)", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const result = graph.transition(taskId("A"), "BLOCKED", agentSays(), operatorBlock());
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.equal(result.code, "BLOCKED_OWNER_MISMATCH");
  assert.equal(graph.get(taskId("A")).state, "IN_PROGRESS");
});

test("W166: the rule is uniform — the operator surface cannot name an agent as the unblock owner either", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const result = graph.transition(taskId("A"), "BLOCKED", operatorSays(), agentBlock());
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.equal(result.code, "BLOCKED_OWNER_MISMATCH");
});

test("W166: a READY → BLOCKED admission sticks — the record holds against a dependency-ready steady state", () => {
  const graph = new TaskGraph([task("A"), task("B")]);
  const result = graph.transition(taskId("A"), "BLOCKED", operatorSays(), operatorBlock());
  assert.equal(result.kind, "accepted");
  assert.equal(graph.get(taskId("A")).state, "BLOCKED");
  // Unrelated churn triggers recompute passes; the record still holds the block.
  graph.transition(taskId("B"), "IN_PROGRESS");
  graph.recordMutation(["unrelated-subject"]);
  assert.equal(graph.get(taskId("A")).state, "BLOCKED");
  assert.ok(graph.get(taskId("A")).blocked !== undefined);
});

test("W166: a record without a usable action or enteredAt is refused (BLOCKED_RECORD_MALFORMED)", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const blankAction = graph.transition(taskId("A"), "BLOCKED", agentSays(), agentBlock({ action: "   " }));
  assert.equal(blankAction.kind, "rejected");
  if (blankAction.kind === "rejected") assert.equal(blankAction.code, "BLOCKED_RECORD_MALFORMED");
  const blankEnteredAt = graph.transition(taskId("A"), "BLOCKED", agentSays(), agentBlock({ enteredAt: "" }));
  assert.equal(blankEnteredAt.kind, "rejected");
  if (blankEnteredAt.kind === "rejected") assert.equal(blankEnteredAt.code, "BLOCKED_RECORD_MALFORMED");
  assert.equal(graph.get(taskId("A")).state, "IN_PROGRESS");
});

test("W166: a record whose reason is present but not a string is refused (BLOCKED_RECORD_MALFORMED) — red-first", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  // The optional reason rides the admitted task verbatim; when present it
  // must still be a string — non-string caller data is malformed, not context.
  const numericReason = graph.transition(taskId("A"), "BLOCKED", agentSays(), { ...agentBlock(), reason: 42 } as unknown as BlockedRecord);
  assert.equal(numericReason.kind, "rejected");
  if (numericReason.kind === "rejected") assert.equal(numericReason.code, "BLOCKED_RECORD_MALFORMED");
  const objectReason = graph.transition(taskId("A"), "BLOCKED", agentSays(), { ...agentBlock(), reason: { evil: true } } as unknown as BlockedRecord);
  assert.equal(objectReason.kind, "rejected");
  if (objectReason.kind === "rejected") assert.equal(objectReason.code, "BLOCKED_RECORD_MALFORMED");
  assert.equal(graph.get(taskId("A")).state, "IN_PROGRESS");
});

test("W166: a blocked record supplied on a non-admission transition is refused (BLOCKED_RECORD_MISPLACED)", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const misplaced = graph.transition(taskId("A"), "VERIFYING", agentSays(), agentBlock());
  assert.equal(misplaced.kind, "rejected");
  if (misplaced.kind === "rejected") assert.equal(misplaced.code, "BLOCKED_RECORD_MISPLACED");
  // The retry path is dependency-derived by construction; a record there is misplaced too.
  graph.transition(taskId("A"), "FAILED");
  const onRetry = graph.transition(taskId("A"), "BLOCKED", operatorSays(), operatorBlock());
  assert.equal(onRetry.kind, "rejected");
  if (onRetry.kind === "rejected") assert.equal(onRetry.code, "BLOCKED_RECORD_MISPLACED");
});

test("W166: a blocked record supplied on the explicit BLOCKED → READY exit is refused (BLOCKED_RECORD_MISPLACED) (guard)", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  assert.equal(graph.transition(taskId("A"), "BLOCKED", agentSays(), agentBlock()).kind, "accepted");
  // The explicit exit rides owner attribution only; a caller-supplied record
  // there is misplaced caller data — refused, and the one-shot consumption
  // never fires (the record stays held on the task).
  const exit = graph.transition(taskId("A"), "READY", agentSays("agent resumes (the named action)"), agentBlock({ action: "a record riding the exit" }));
  assert.equal(exit.kind, "rejected");
  if (exit.kind === "rejected") assert.equal(exit.code, "BLOCKED_RECORD_MISPLACED");
  const held = graph.get(taskId("A"));
  assert.equal(held.state, "BLOCKED");
  // The stored record is untouched — the refused exit never consumed it.
  assert.deepEqual(held.blocked, agentBlock());
});

test("W166: the named owner's action consumes the record one-shot on the explicit BLOCKED → READY exit", () => {
  const graph = new TaskGraph([task("A"), task("B")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  assert.equal(graph.transition(taskId("A"), "BLOCKED", agentSays(), agentBlock({ action: "resume the work" })).kind, "accepted");
  const result = graph.transition(taskId("A"), "READY", agentSays("agent resumes (the named action)"));
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") {
    assert.equal(result.transition.from, "BLOCKED");
    assert.equal(result.transition.to, "READY");
  }
  const done = graph.get(taskId("A"));
  assert.equal(done.state, "READY");
  // One-shot consumption (the W112 grant-lifecycle shape): the action is
  // spent and the record leaves the task entirely.
  assert.equal(done.blocked, undefined);
  // A second exit attempt is a plain illegal transition — the block is spent.
  assert.equal(graph.transition(taskId("A"), "READY", agentSays()).kind, "rejected");
});

test("W166: only the named owner consumes the action — a foreign actor or no attribution is refused", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  assert.equal(graph.transition(taskId("A"), "BLOCKED", agentSays(), agentBlock()).kind, "accepted");
  const foreign = graph.transition(taskId("A"), "READY", operatorSays());
  assert.equal(foreign.kind, "rejected");
  if (foreign.kind === "rejected") assert.equal(foreign.code, "BLOCKED_OWNER_MISMATCH");
  assert.equal(graph.get(taskId("A")).state, "BLOCKED");
  const unattributed = graph.transition(taskId("A"), "READY");
  assert.equal(unattributed.kind, "rejected");
  if (unattributed.kind === "rejected") assert.equal(unattributed.code, "BLOCKED_OWNER_UNVERIFIED");
  assert.equal(graph.get(taskId("A")).state, "BLOCKED");
});

test("W166: the exit keeps dependency-derived readiness — a dependency-blocked task cannot exit by action alone", () => {
  const graph = dualBlockedGraph();
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
  const result = graph.transition(taskId("B"), "READY", agentSays("the named action, early"));
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.equal(result.code, "DEPENDENCY_READINESS_REQUIRED");
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
});

test("W166: a dependency-derived BLOCKED (no record) cannot exit by an explicit action (BLOCKED_EXIT_WITHOUT_ACTION)", () => {
  const graph = new TaskGraph([task("A"), task("B", ["A"])]);
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
  const result = graph.transition(taskId("B"), "READY", operatorSays());
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.equal(result.code, "BLOCKED_EXIT_WITHOUT_ACTION");
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
});

test("W166: the dependency graph resolving on its own exits the block — the record stays as stale context", () => {
  const graph = dualBlockedGraph();
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
  // The dependency re-verifies; the graph resolves on its own.
  graph.recordEvidence(evidence("build", graph.mutationEpoch));
  graph.transition(taskId("A"), "VERIFIED");
  const released = graph.get(taskId("B"));
  assert.equal(released.state, "READY");
  // The automatic exit does NOT consume the record: it rides as stale
  // context, not a live block (the projection decides how to render it).
  assert.ok(released.blocked !== undefined);
  assert.equal(released.blocked?.action, "resume once the build re-verifies");
});

test("W166: a stale-context record never holds a later dependency-derived block", () => {
  const graph = dualBlockedGraph();
  graph.recordEvidence(evidence("build", graph.mutationEpoch));
  graph.transition(taskId("A"), "VERIFIED");
  assert.equal(graph.get(taskId("B")).state, "READY");
  // The task re-blocks for dependency reasons while the stale record rides.
  graph.addTask(task("C"));
  graph.addDependency(taskId("B"), taskId("C"));
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
  // The dependency graph resolves again; the stale record does not hold it.
  graph.transition(taskId("C"), "IN_PROGRESS");
  graph.transition(taskId("C"), "VERIFYING");
  graph.transition(taskId("C"), "VERIFIED");
  assert.equal(graph.get(taskId("B")).state, "READY");
});

test("W166: restore admits a persisted live block and keeps it held; stale-context records persist too; the recordless invariant is unchanged", () => {
  const record = agentBlock();
  const live = TaskGraph.restore({
    tasks: [{ ...task("A"), state: "BLOCKED", blocked: record }],
    evidence: [],
    mutationEpoch: 0,
  });
  // The record holds the block across restore: BLOCKED with verified
  // dependencies is a legal persisted state when a live record holds it.
  assert.equal(live.get(taskId("A")).state, "BLOCKED");
  assert.deepEqual(live.get(taskId("A")).blocked, record);

  const stale = TaskGraph.restore({
    tasks: [{ ...task("A"), state: "READY", blocked: record }],
    evidence: [],
    mutationEpoch: 0,
  });
  assert.equal(stale.get(taskId("A")).state, "READY");
  assert.deepEqual(stale.get(taskId("A")).blocked, record);

  // The recordless invariant is unchanged: a recordless BLOCKED task whose
  // dependencies are all VERIFIED is corrupt, exactly as before W166.
  assert.throws(
    () => TaskGraph.restore({ tasks: [{ ...task("A"), state: "BLOCKED" }], evidence: [], mutationEpoch: 0 }),
    /inconsistent dependency readiness/,
  );
});

test("W166: the FAILED → BLOCKED retry path stays recordless and ungated (guard)", () => {
  const graph = new TaskGraph([
    { ...task("A"), requiredEvidence: [{ authority: "environment", subject: "build" }] },
    task("B", ["A"]),
  ]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  graph.transition(taskId("A"), "VERIFYING");
  graph.recordEvidence(evidence("build", graph.mutationEpoch));
  graph.transition(taskId("A"), "VERIFIED");
  graph.transition(taskId("B"), "IN_PROGRESS");
  graph.transition(taskId("B"), "FAILED");
  // The dependency becomes unresolved (its evidence goes stale)...
  graph.recordMutation(["build"]);
  // ...and the retry path sends the FAILED task back to BLOCKED, recordless:
  // no attribution, no record, and the admission gate does not apply.
  const result = graph.transition(taskId("B"), "BLOCKED");
  assert.equal(result.kind, "accepted");
  assert.equal(graph.get(taskId("B")).state, "BLOCKED");
  assert.equal(graph.get(taskId("B")).blocked, undefined);
});

test("W166: no actor outside the W157 vocabulary can be admitted even when caller and record collude", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const collusion = graph.transition(
    taskId("A"),
    "BLOCKED",
    { actor: "phantom" as unknown as TransitionAttribution["actor"], authority: "colluding caller", observedAt: "2026-09-27T12:00:00.000Z" },
    { owner: "phantom" as unknown as BlockedRecord["owner"], action: "unblock", enteredAt: "2026-09-27T12:00:00.000Z" },
  );
  assert.equal(collusion.kind, "rejected");
  if (collusion.kind === "rejected") assert.equal(collusion.code, "BLOCKED_OWNER_MISMATCH");
  assert.equal(graph.get(taskId("A")).state, "IN_PROGRESS");
});

test("W166: the application authority forwards the admission — the self-naming gate holds through the product path", () => {
  const graph = new TaskGraph([task("A"), task("B")]);
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
  application.transition(taskId("A"), "IN_PROGRESS");
  const admitted = application.transition(
    taskId("A"),
    "BLOCKED",
    operatorSays(),
    operatorBlock({ action: "hold for the design decision" }),
  );
  assert.equal(admitted.kind, "accepted");
  assert.equal(application.snapshot().tasks.find((entry) => entry.id === taskId("A"))?.state, "BLOCKED");
  application.transition(taskId("B"), "IN_PROGRESS");
  const foreign = application.transition(
    taskId("B"),
    "BLOCKED",
    agentSays(),
    operatorBlock({ action: "not mine to name" }),
  );
  assert.equal(foreign.kind, "rejected");
  if (foreign.kind === "rejected") assert.equal(foreign.code, "BLOCKED_OWNER_MISMATCH");
});
