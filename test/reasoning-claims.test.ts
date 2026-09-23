import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createReasoningClaimMonitor,
  detectReasoningClaim,
  REASONING_CLAIM_SOURCE,
} from "../src/application/reasoning-claims.js";
import {
  WorkflowCodingSession,
  type CodingSessionDriver,
  type CodingSessionEvent,
} from "../src/application/coding-session.js";

/**
 * RSI iteration 17: the advisory reasoning-claim monitor at the control-plane
 * session seam. The pure detector pins are characterization (green on first
 * run by design); the session-integration pins are the behavioral contract —
 * RED before the WorkflowCodingSession wiring exists.
 */

/** Fake driver that emits a scripted event list, then returns. */
function scriptedDriver(events: readonly CodingSessionEvent[]): CodingSessionDriver {
  return {
    async start(_prompt, emit) {
      for (const event of events) emit(event);
    },
    async cancel() {},
  };
}

function collect(session: WorkflowCodingSession): CodingSessionEvent[] {
  const events: CodingSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

function claims(events: readonly CodingSessionEvent[]): Extract<CodingSessionEvent, { type: "reasoning-claim" }>[] {
  return events.filter(
    (event): event is Extract<CodingSessionEvent, { type: "reasoning-claim" }> => event.type === "reasoning-claim",
  );
}

test("reasoning-claims: the detector flags a completed-verification assertion with no observed tool call", () => {
  assert.equal(REASONING_CLAIM_SOURCE, "reasoning-claim");
  const flag = detectReasoningClaim({ text: "The tests all pass.", successfulToolCalls: 0 });
  assert.ok(flag, "an unbacked completed-verification claim is flagged");
  assert.equal(flag.successfulToolCalls, 0);
  assert.match(flag.sentence, /tests all pass/);
});

test("reasoning-claims: intent and conditional phrasing is never flagged (deliberate under-flagging)", () => {
  for (const text of [
    "I will run the tests now.",
    "Once I run the tests, they should pass.",
    "Let me run the build and then verify the fix.",
    "If the tests pass, I can continue.",
    "I need to run the tests before claiming this works.",
  ]) {
    assert.equal(
      detectReasoningClaim({ text, successfulToolCalls: 0 }),
      undefined,
      `hedged intent must not be flagged: ${text}`,
    );
  }
});

test("reasoning-claims: benign reasoning and any observed successful tool call suppress the flag", () => {
  assert.equal(detectReasoningClaim({ text: "First I want to read the failing test file.", successfulToolCalls: 0 }), undefined);
  assert.equal(
    detectReasoningClaim({ text: "The tests all pass.", successfulToolCalls: 1 }),
    undefined,
    "an observed successful tool call is treated as possible backing",
  );
});

test("reasoning-claims: a streamed claim with no observed action emits exactly one advisory flag per turn", async () => {
  const session = new WorkflowCodingSession(
    scriptedDriver([
      { type: "thought", text: "The tests all pass." },
      { type: "completed", result: "done" },
    ]),
  );
  const events = collect(session);
  await session.submit("do the work");

  const flags = claims(events);
  assert.equal(flags.length, 1, "exactly one flag for the turn");
  assert.match(flags[0]!.sentence, /tests all pass/);
  assert.equal(flags[0]!.successfulToolCalls, 0);
  assert.deepEqual(session.reasoningClaimStats(), { flags: 1, flaggedTurns: 1 });
});

test("reasoning-claims: hedged intent emits no flag", async () => {
  const session = new WorkflowCodingSession(
    scriptedDriver([
      { type: "thought", text: "I will run the tests now." },
      { type: "completed", result: "done" },
    ]),
  );
  const events = collect(session);
  await session.submit("do the work");

  assert.equal(claims(events).length, 0);
  assert.deepEqual(session.reasoningClaimStats(), { flags: 0, flaggedTurns: 0 });
});

test("reasoning-claims: an assertion after an observed successful tool call is not flagged", async () => {
  const session = new WorkflowCodingSession(
    scriptedDriver([
      { type: "tool", callId: "t1", title: "run tests", toolKind: "execute", status: "completed", subjects: [] },
      { type: "assistant", text: "The tests all pass." },
      { type: "completed", result: "done" },
    ]),
  );
  const events = collect(session);
  await session.submit("do the work");

  assert.equal(claims(events).length, 0, "the observed completed tool call suppresses the flag for the turn");
  assert.deepEqual(session.reasoningClaimStats(), { flags: 0, flaggedTurns: 0 });
});

test("reasoning-claims: flagging is bounded to one per turn", async () => {
  const session = new WorkflowCodingSession(
    scriptedDriver([
      { type: "thought", text: "The tests all pass." },
      { type: "assistant", text: "The build passes too." },
      { type: "completed", result: "done" },
    ]),
  );
  const events = collect(session);
  await session.submit("do the work");

  assert.equal(claims(events).length, 1, "a second claim in the same turn does not add a second flag");
  assert.deepEqual(session.reasoningClaimStats(), { flags: 1, flaggedTurns: 1 });
});

test("reasoning-claims: chunked stream deltas are accumulated before detection", async () => {
  // Production drivers emit fragments, not sentences (ACP agent_thought_chunk /
  // agent_message_chunk, OpenCode message.part.updated deltas). Per-event
  // sentence matching would never see a whole clause; the seam accumulates.
  const session = new WorkflowCodingSession(
    scriptedDriver([
      { type: "thought", text: "The tests " },
      { type: "thought", text: "all pass." },
      { type: "completed", result: "done" },
    ]),
  );
  const events = collect(session);
  await session.submit("do the work");

  const flags = claims(events);
  assert.equal(flags.length, 1, "chunked fragments across events still yield one flag");
  assert.match(flags[0]!.sentence, /tests all pass/);
});

test("reasoning-claims: a chunked assistant-delta claim is flagged too", async () => {
  const session = new WorkflowCodingSession(
    scriptedDriver([
      { type: "assistant", text: "All checks " },
      { type: "assistant", text: "pass." },
      { type: "completed", result: "done" },
    ]),
  );
  const events = collect(session);
  await session.submit("do the work");

  assert.equal(claims(events).length, 1, "assistant deltas accumulate the same way as thought deltas");
});

test("reasoning-claims: a hedged follow-on clause does not suppress a definite claim beside it", () => {
  const flag = detectReasoningClaim({ text: "The tests all pass; I still need to update the docs.", successfulToolCalls: 0 });
  assert.ok(flag, "the definite clause is flagged even though a later clause is hedged");
  assert.match(flag.sentence, /tests all pass/);
});

test("reasoning-claims: documented adjacent assertion phrasings are covered", () => {
  for (const text of ["The suite passes.", "All tests are green.", "CI is green."]) {
    assert.ok(detectReasoningClaim({ text, successfulToolCalls: 0 }), `expected a flag for: ${text}`);
  }
});

test("reasoning-claims: a completed hedged clause is evaluated once and cannot later flag", () => {
  // Regression (round-2 P2): a tail-truncating buffer would eventually drop the
  // hedge and re-evaluate the assertion. The monitor evaluates each completed
  // clause exactly once, so the hedged clause never becomes a false positive.
  const monitor = createReasoningClaimMonitor();
  assert.equal(
    monitor.push({ stream: "thought", text: "Let me check whether the tests pass." , successfulToolCalls: 0 }),
    undefined,
    "hedged clause is suppressed when it completes",
  );
  assert.equal(
    monitor.push({ stream: "thought", text: "x".repeat(4100), successfulToolCalls: 0 }),
    undefined,
    "later filler must not resurrect the already-evaluated hedged clause",
  );
});

test("reasoning-claims: a stream switch is a clause boundary (hedged thought cannot fuse onto an assistant claim)", async () => {
  // Regression (round-2 P2): fusion requires an UNTERMINATED thought final —
  // "I will run the tests" + "The tests all pass." with no separator becomes one
  // clause containing "will", suppressing the canonical unbacked claim. (A
  // terminated thought would be consumed before the switch and would not
  // discriminate the separator fix.)
  const session = new WorkflowCodingSession(
    scriptedDriver([
      { type: "thought", text: "I will run the tests" },
      { type: "assistant", text: "The tests all pass." },
      { type: "completed", result: "done" },
    ]),
  );
  const events = collect(session);
  await session.submit("do the work");

  assert.equal(claims(events).length, 1, "the assistant claim is flagged despite the hedged unterminated thought final");
});

test("reasoning-claims: a newline-terminated claim is evaluated, not stranded", () => {
  // Regression (round-3 P2): a scanner that excluded newlines from both the
  // clause and terminator classes would strand a newline-terminated claim and
  // drop it on the next slice.
  const monitor = createReasoningClaimMonitor();
  const flag = monitor.push({ stream: "thought", text: "The tests all pass\n", successfulToolCalls: 0 });
  assert.ok(flag, "a newline terminator must complete and evaluate the clause");
  assert.match(flag.sentence, /tests all pass/);
});

test("reasoning-claims: a pathological unterminated clause is evaluated once with its hedge intact", () => {
  const monitor = createReasoningClaimMonitor();
  const hedged = `Let me consider ${"x".repeat(2500)} the tests pass`;
  assert.equal(monitor.push({ stream: "thought", text: hedged, successfulToolCalls: 0 }), undefined);
  const unhedged = `Summary: ${"y".repeat(2500)} the tests all pass`;
  const flag = monitor.push({ stream: "thought", text: unhedged, successfulToolCalls: 0 });
  assert.ok(flag, "an unhedged claim in a pathological long clause is still caught");
});

test("reasoning-claims: flush evaluates an unpunctuated final clause (round-4 N1)", () => {
  const monitor = createReasoningClaimMonitor();
  assert.equal(
    monitor.push({ stream: "assistant", text: "The tests all pass", successfulToolCalls: 0 }),
    undefined,
    "an unterminated tail is not evaluated during streaming",
  );
  const flag = monitor.flush(0);
  assert.ok(flag, "the turn-end flush must evaluate the unterminated final clause");
  assert.match(flag.sentence, /tests all pass/);
});

test("reasoning-claims: flush honors the hedge and observed-action suppression", () => {
  const hedged = createReasoningClaimMonitor();
  hedged.push({ stream: "assistant", text: "I will run the tests", successfulToolCalls: 0 });
  assert.equal(hedged.flush(0), undefined, "a hedged unpunctuated tail is intent, not a claim");

  const observed = createReasoningClaimMonitor();
  observed.push({ stream: "assistant", text: "The tests all pass", successfulToolCalls: 0 });
  assert.equal(observed.flush(1), undefined, "an observed successful action suppresses the flag");

  const empty = createReasoningClaimMonitor();
  assert.equal(empty.flush(0), undefined, "an empty tail flushes to nothing");
});

test("reasoning-claims: a session's unpunctuated final assistant claim is flagged at turn end", async () => {
  const session = new WorkflowCodingSession(
    scriptedDriver([
      { type: "assistant", text: "The tests all pass" },
      { type: "completed", result: "done" },
    ]),
  );
  const events = collect(session);
  await session.submit("do the work");

  const flags = claims(events);
  assert.equal(flags.length, 1, "the unpunctuated final claim is caught by the turn-end flush");
  assert.match(flags[0]!.sentence, /tests all pass/);
  assert.deepEqual(session.reasoningClaimStats(), { flags: 1, flaggedTurns: 1 });
});

test("reasoning-claims: an unpunctuated hedged final emits no flag", async () => {
  const session = new WorkflowCodingSession(
    scriptedDriver([
      { type: "assistant", text: "I will run the tests" },
      { type: "completed", result: "done" },
    ]),
  );
  const events = collect(session);
  await session.submit("do the work");

  assert.equal(claims(events).length, 0);
  assert.deepEqual(session.reasoningClaimStats(), { flags: 0, flaggedTurns: 0 });
});

test("reasoning-claims: an unpunctuated final after an observed successful tool call is not flagged", async () => {
  const session = new WorkflowCodingSession(
    scriptedDriver([
      { type: "tool", callId: "t1", title: "run tests", toolKind: "execute", status: "completed", subjects: [] },
      { type: "assistant", text: "The tests all pass" },
      { type: "completed", result: "done" },
    ]),
  );
  const events = collect(session);
  await session.submit("do the work");

  assert.equal(claims(events).length, 0);
  assert.deepEqual(session.reasoningClaimStats(), { flags: 0, flaggedTurns: 0 });
});
