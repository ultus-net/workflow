import assert from "node:assert/strict";
import { test } from "node:test";

import { operatorPosture, scheduleLineage, type PostureRunTask } from "../src/integrations/operator-posture.js";

// W150 — the operator posture strip + unified decision inbox's projection
// function, pinned per the borrowings spec's acceptance criteria:
//   1. counts computed ONLY from registry state; a fail-closed degraded state
//      when a registry is absent (a named absence, never a fabricated zero);
//   2. the projection mutates nothing (pure over its inputs);
//   3. the decision list covers reviews, decisions, budget incidents, and
//      orphaned runs with actor + authority attribution taken from the record
//      kind, and every row's action is a link into an existing panel.
// W153's lineage slice pins the schedule join: registry-id-sourced, ordered
// by the graph's insertion order, tombstoned for deleted schedules.

const runTask = (id: string, state: string, title = `run ${id}`): PostureRunTask => ({ id, title, state });

test("W150: the posture counts come from registry state — awaiting review, budget incidents, orphans, failed schedules", () => {
  const posture = operatorPosture({
    runTasks: [
      runTask("run:abc", "VERIFYING"),
      runTask("run:def", "VERIFYING"),
      runTask("run:ghi", "IN_PROGRESS"),
      runTask("schedule:nightly:1", "FAILED"),
      runTask("schedule:nightly:2", "FAILED"),
      runTask("schedule:sweep:3", "VERIFIED"),
      { id: "interactive", title: "the interactive session", state: "IN_PROGRESS" },
    ].map((task) => ({ id: task.id, title: task.title, state: task.state })),
    reviewOutcomes: new Map([["run:def", { verdict: "approved", summary: "fine" }]]),
    blockingReasons: new Map(),
    budgetIncidents: [{ sessionId: "s1", tier: "warn", mechanism: "capped" }, { sessionId: "s2", tier: "abort", reason: "2.1x the cap" }],
    orphans: [{ runId: "run:zzz", reason: "hub restarted mid-run" }],
    schedules: [{ id: "nightly", title: "Nightly sweep" }, { id: "sweep", title: "Sweep" }],
  });
  assert.deepEqual(posture.counts, {
    awaitingReview: 1, // run:abc only — run:def carries a recorded verdict
    budgetIncidents: 2,
    orphanedRuns: 1,
    failedSchedules: 1, // nightly's two failed runs group to ONE schedule
  });
  assert.deepEqual(posture.degraded, []);
  const kinds = new Set(posture.decisions.map((row) => row.kind));
  assert.deepEqual([...kinds].sort(), ["budget", "orphan", "review", "schedule"]);
});

test("W150: awaiting-review means VERIFYING with no recorded verdict — IN_PROGRESS and gated-then-verified runs are not awaiting", () => {
  const posture = operatorPosture({
    runTasks: [
      runTask("run:a", "VERIFYING"),
      runTask("run:b", "VERIFYING"),
      runTask("run:c", "IN_PROGRESS"),
      runTask("run:d", "VERIFIED"),
    ],
    reviewOutcomes: new Map([["run:b", { verdict: "approved", summary: "ok" }]]),
    blockingReasons: new Map(),
  });
  assert.equal(posture.counts.awaitingReview, 1);
  assert.ok(posture.decisions.every((row) => !row.summary.includes("run:c") && !row.summary.includes("run:d")));
});

test("W150: fail-closed degraded state — an absent registry is NAMED, never rendered as a fabricated zero", () => {
  const posture = operatorPosture({ runTasks: [runTask("run:a", "VERIFYING")] });
  assert.deepEqual([...posture.degraded].sort(), ["orphaned-run detection", "per-session budget state", "run-gate observability", "schedule registry"]);
  assert.deepEqual(posture.counts, { awaitingReview: 1, budgetIncidents: 0, orphanedRuns: 0, failedSchedules: 0 });
  // No decision rows for data the projection was never given.
  assert.equal(posture.decisions.some((row) => row.kind === "budget"), false);
  assert.equal(posture.decisions.some((row) => row.kind === "orphan"), false);
});

test("W150: the decision list carries actor + authority attribution from the record kind, and actions link into existing panels", () => {
  const posture = operatorPosture({
    runTasks: [runTask("run:abc", "VERIFYING", "the nightly candidate")],
    reviewOutcomes: new Map(),
    blockingReasons: new Map([["run:old", "changes_requested: the coverage line was missing"]]),
    budgetIncidents: [{ sessionId: "sess-1", title: "the loop", tier: "abort", mechanism: "capped", reason: "over cap" }],
    orphans: [{ runId: "run:zzz", reason: "hub restarted mid-run" }],
    schedules: [{ id: "nightly", title: "Nightly sweep" }],
  });
  const byKind = (kind: string) => posture.decisions.filter((row) => row.kind === kind);
  const review = byKind("review");
  assert.equal(review.length, 2); // the awaiting run + the recorded blocking reason
  const awaiting = review.find((row) => row.actor === "agent")!;
  assert.equal(awaiting.authority, "run review gate (requiresReview)");
  assert.ok(awaiting.summary.includes("the nightly candidate"));
  assert.deepEqual(awaiting.action, { label: "Open run", target: "#run:run:abc" });
  const blocked = review.find((row) => row.actor === "reviewer")!;
  assert.equal(blocked.authority, "recorded review decision");
  assert.ok(blocked.summary.includes("coverage line was missing"));
  const budget = byKind("budget")[0]!;
  assert.equal(budget.actor, "budget guard");
  assert.ok(budget.authority.includes("W045"));
  assert.ok(budget.authority.includes("capped"));
  assert.ok(budget.summary.includes("abort"));
  assert.deepEqual(budget.action, { label: "Open session", target: "#session:sess-1" });
  const orphan = byKind("orphan")[0]!;
  assert.equal(orphan.actor, "system");
  assert.equal(orphan.authority, "orphaned-run detection (recover-or-discard, fail-closed)");
  assert.deepEqual(orphan.action, { label: "Recover or discard", target: "#run:run:zzz" });
  assert.equal(byKind("schedule").length, 0); // no failed schedule runs in this input
});

test("W150: the projection is pure — the same input yields an equal result and the inputs are not mutated", () => {
  const runTasks = [runTask("run:a", "VERIFYING")];
  const blockingReasons = new Map([["run:a", "changes_requested: x"]]);
  const input = { runTasks, blockingReasons, schedules: [{ id: "s", title: "S" }] };
  const first = operatorPosture(input);
  const second = operatorPosture(input);
  assert.deepEqual(first, second);
  assert.equal(blockingReasons.size, 1);
  assert.equal(runTasks.length, 1);
  // The input objects are untouched by projection.
  assert.deepEqual([...input.blockingReasons.entries()], [["run:a", "changes_requested: x"]]);
});

test("W153: schedule lineage joins on the registry id prefix, takes the last outcome from the graph's insertion order, and tombstones deleted schedules", () => {
  const lineage = scheduleLineage({
    schedules: [{ id: "sweep", title: "Sweep" }], // "nightly" is ABSENT — deleted schedule
    runTasks: [
      runTask("schedule:nightly:1", "VERIFIED", "nightly run 1"),
      runTask("schedule:nightly:2", "FAILED", "nightly run 2"),
      runTask("schedule:sweep:3", "FAILED", "sweep run 3"),
      runTask("schedule:sweep:4", "VERIFYING", "sweep run 4"),
    ],
  });
  const nightly = lineage.find((entry) => entry.scheduleId === "nightly")!;
  assert.equal(nightly.causedRuns, 2);
  assert.equal(nightly.lastOutcome, "failed"); // the LAST nightly run in insertion order
  assert.equal(nightly.tombstoned, true, "the deleted schedule's runs stay attributed to a tombstoned origin");
  assert.equal(nightly.title, "nightly"); // the registry id, not a fabricated title
  const sweep = lineage.find((entry) => entry.scheduleId === "sweep")!;
  assert.equal(sweep.causedRuns, 2);
  assert.equal(sweep.lastOutcome, "in-progress");
  assert.equal(sweep.tombstoned, false);
  assert.equal(sweep.title, "Sweep");
});

test("W153: an unrun schedule reports unrun; a schedule-less run id prefix never crashes the join", () => {
  const lineage = scheduleLineage({
    schedules: [{ id: "fresh", title: "Fresh" }],
    runTasks: [runTask("schedule:nightly:1", "VERIFIED"), runTask("schedule:hub-reviewer-xyz", "FAILED", "a reviewer run — not a schedule origin")],
  });
  const fresh = lineage.find((entry) => entry.scheduleId === "fresh")!;
  assert.equal(fresh.lastOutcome, "unrun");
  assert.equal(fresh.causedRuns, 0);
  assert.equal(fresh.tombstoned, false);
  // The reviewer run's id shares the schedule: prefix but is NOT a schedule
  // origin — it must not appear as a tombstoned lineage row.
  assert.equal(lineage.some((entry) => entry.scheduleId.startsWith("hub-reviewer")), false);
});