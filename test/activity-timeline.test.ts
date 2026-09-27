import assert from "node:assert/strict";
import { test } from "node:test";

import { TIMELINE_RETENTION, activityTimeline } from "../src/integrations/activity-timeline.js";

// W152 — the unified activity timeline's projection, pinned per the
// borrowings spec's Wave 3 acceptance criteria:
//   1. every rendered row's actor/authority comes from the underlying record;
//      a row with missing attribution renders the EXPLICIT "unattributed"
//      state — the kernel's TransitionRecord carries only {taskId, from, to}
//      (verified 2026-09-27, src/kernel/contracts.ts:72-76), so its rows are
//      the missing-attribution case, and the UI never synthesizes a guess;
//   2. the feed is append-only: the projection is pure over its inputs;
//   3. the retention statement matches the hub's actual persistence (the hub
//      composes its applications in-memory — no store is wired in hub.ts).

const transition = (taskId: string, from: string, to: string) => ({ taskId, from, to });

test("W152: kernel transition rows render the explicit unattributed state with the record's own truth", () => {
  const timeline = activityTimeline({
    transitions: [
      transition("run:schedule:nightly:abc", "READY", "IN_PROGRESS"),
      transition("run:author-1", "IN_PROGRESS", "VERIFYING"),
      transition("kernel-task-no-title", "BLOCKED", "READY"),
    ],
    tasks: [{ id: "run:schedule:nightly:abc", title: "Nightly audit" }],
  });
  assert.equal(timeline.rows.length, 3);
  const [begin, verifying, untitled] = timeline.rows;
  assert.equal(begin?.kind, "transition");
  assert.equal(begin?.actor, "unattributed", "the kernel records no actor — the row says so, never a guess");
  assert.equal(begin?.authority, "unattributed", "the kernel records no authority basis — the row says so");
  assert.equal(begin?.at, null, "the kernel records no time — the row stays timeless, no fabricated timestamp");
  assert.equal(begin?.summary, "Nightly audit: READY → IN_PROGRESS", "the title joins from the tasks list");
  assert.equal(verifying?.summary, "run:author-1: IN_PROGRESS → VERIFYING", "a task without a served title renders its kernel id, not a fabricated title");
  assert.equal(untitled?.actor, "unattributed");
});

test("W152: registry rows carry the attribution and time their records actually hold", () => {
  const timeline = activityTimeline({
    transitions: [],
    tasks: [{ id: "run:nightly:abc", title: "Nightly audit" }],
    reviewOutcomes: new Map([
      ["author-1", { reviewerRunId: "schedule:hub-reviewer-1", verdict: "approved", recorded: true, summary: "five axes pass" }],
      ["author-2", { reviewerRunId: "schedule:hub-reviewer-2", verdict: "changes_requested", recorded: false, summary: "weak", parseFailure: "names fewer than three axes" }],
    ]),
    blockingReasons: new Map([["author-3", "test evidence stale"]]),
    completionClaims: new Map([["author-4", { runId: "author-4", claim: "tests pass", verifiedAtClaim: false, observedAt: "2026-09-27T10:00:00.000Z" }]]),
    runUsage: new Map([["author-5", { requests: 3, promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.01, recordedAt: "2026-09-27T11:00:00.000Z" }]]),
    runOrigins: new Map([
      ["schedule:nightly:abc", { kind: "schedule", scheduleId: "nightly" }],
      ["schedule:gone:def", { kind: "schedule", scheduleId: "gone" }],
    ]),
    schedules: [{ id: "nightly", title: "Nightly audit" }],
    budgetIncidents: [{ sessionId: "s1", title: "capped session", tier: "abort", mechanism: "local guard", reason: "2x cap" }],
  });
  const byKind = (kind: string): typeof timeline.rows => timeline.rows.filter((row) => row.kind === kind);

  const review = byKind("review");
  assert.equal(review.length, 2);
  assert.equal(review[0]?.actor, "agent (reviewer)", "the record is the reviewer's verdict — the actor is the reviewer family");
  assert.equal(review[0]?.authority, "review-gate verdict record (admitted)");
  assert.equal(review[1]?.authority, "review-gate verdict record (not admitted)", "an unadmitted verdict says so — the record's own recorded flag");
  assert.match(review[1]?.summary ?? "", /parse failure: names fewer than three axes/);
  assert.equal(review[0]?.at, null, "the verdict record carries no time — timeless, honestly");

  const gate = byKind("gate");
  assert.equal(gate[0]?.actor, "system", "the blocking-reason record is the gate's — the kind is the GATE's (the W150 rule)");
  assert.equal(gate[0]?.authority, "recorded blocking reason (run registry)");

  const claim = byKind("claim");
  assert.equal(claim[0]?.at, "2026-09-27T10:00:00.000Z", "the claim record carries its own observedAt");
  assert.match(claim[0]?.authority ?? "", /verified at claim: no/);

  const usage = byKind("usage");
  assert.equal(usage[0]?.at, "2026-09-27T11:00:00.000Z");
  assert.match(usage[0]?.summary ?? "", /150 tokens/);

  const origin = byKind("origin");
  assert.equal(origin.length, 2);
  assert.equal(origin[0]?.actor, "scheduler");
  assert.match(origin[0]?.summary ?? "", /schedule Nightly audit fired run schedule:nightly:abc/, "the schedule title joins from the registry");
  assert.match(origin[1]?.summary ?? "", /schedule gone fired run/, "a deleted schedule renders its registry id (tombstone attribution), never a dangling row");

  const budget = byKind("budget");
  assert.equal(budget[0]?.actor, "budget guard", "the W045 posture attribution carries over");
  assert.match(budget[0]?.authority ?? "", /W045: local guard/);
});

test("W152: absent registries degrade with named absences and produce no rows — never fabricated feed entries", () => {
  const bare = activityTimeline({ transitions: [], tasks: [] });
  assert.deepEqual(bare.rows, []);
  assert.deepEqual(bare.degraded, [
    "run-gate observability",
    "completion-claims journal",
    "per-run usage records",
    "run origin records",
    "per-session budget state",
  ]);
  assert.match(bare.retention, /reset when the hub process restarts/, "the retention wording matches the hub's actual in-memory persistence");

  const partial = activityTimeline({
    transitions: [transition("run:a", "READY", "IN_PROGRESS")],
    tasks: [{ id: "run:a", title: "A" }],
    reviewOutcomes: new Map(),
    blockingReasons: new Map(),
  });
  assert.equal(partial.rows.length, 1, "only the kernel row exists — the absent registries contribute nothing");
  assert.deepEqual(partial.degraded, [
    "completion-claims journal",
    "per-run usage records",
    "run origin records",
    "per-session budget state",
  ], "the present registries are not named as degraded");
});

test("W157: an attributed kernel transition row consumes the record's attribution verbatim; an unattributed one stays explicit", () => {
  const timeline = activityTimeline({
    transitions: [
      { taskId: "run:schedule:nightly:abc", from: "READY", to: "IN_PROGRESS", attribution: { actor: "scheduler", authority: "schedule-fired run begin (origin nightly)", observedAt: "2026-09-27T00:00:00.000Z" } },
      { taskId: "run:author-1", from: "IN_PROGRESS", to: "VERIFYING" },
    ],
    tasks: [{ id: "run:schedule:nightly:abc", title: "Nightly audit" }],
  });
  const [attributed, bare] = timeline.rows;
  assert.equal(attributed?.actor, "scheduler", "the record's stamp is consumed verbatim — the row does not re-derive it");
  assert.equal(attributed?.authority, "schedule-fired run begin (origin nightly)");
  assert.equal(attributed?.at, "2026-09-27T00:00:00.000Z", "the record's own time renders — no fabricated timestamp");
  assert.equal(bare?.actor, "unattributed", "absence stays the explicit unattributed state (criterion 1's pinned case)");
  assert.equal(bare?.at, null);
});

test("W152: the projection is pure — identical inputs produce identical feeds", () => {
  const input = () => ({
    transitions: [transition("run:x", "READY", "IN_PROGRESS")],
    tasks: [{ id: "run:x", title: "X" }],
    reviewOutcomes: new Map([["x", { reviewerRunId: "r", verdict: "approved", recorded: true, summary: "s" }]]),
  });
  const first = activityTimeline(input());
  const second = activityTimeline(input());
  assert.deepEqual(first, second);
  assert.equal(first.rows.length, 2);
  assert.equal(TIMELINE_RETENTION, activityTimeline(input()).retention);
});