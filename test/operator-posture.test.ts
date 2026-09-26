import assert from "node:assert/strict";
import { test } from "node:test";

import { operatorPosture, scheduleLineage, type PostureRunTask } from "../src/integrations/operator-posture.js";

// W150 — the operator posture strip + unified decision inbox's projection
// function, pinned per the borrowings spec's acceptance criteria:
//   1. counts computed ONLY from registry state; a fail-closed degraded state
//      when a registry is absent — the count is NULL and the strip renders
//      "state unavailable", never a fabricated zero;
//   2. the projection mutates nothing (pure over its inputs);
//   3. the decision list covers reviews, decisions, budget incidents, and
//      orphaned runs with actor + authority attribution taken from the record
//      kind, and every row's action is a link into an existing panel.
//
// ID CONTRACT (round-1 review's P1): the fixtures use RAW run ids — the same
// id space the run registry's gate-observability maps are keyed by. The
// kernel snapshot's `run:<raw>` ids are stripped at the hub-http boundary;
// a scheduled run's raw id is `schedule:<scheduleId>:<uuid>`.
// W153's lineage pins: registry-id-sourced joins, insertion-order last
// outcome, tombstones for deleted schedules, and the reviewer-run exclusion.

const runTask = (runId: string, state: string, title = `run ${runId}`): PostureRunTask => ({ runId, title, state });

test("W150: the posture counts come from registry state — awaiting review, budget incidents, orphans, failed schedules", () => {
  const posture = operatorPosture({
    runTasks: [
      runTask("author-1", "VERIFYING"),
      runTask("author-2", "VERIFYING"),
      runTask("author-3", "IN_PROGRESS"),
      runTask("schedule:nightly:1", "FAILED"),
      runTask("schedule:nightly:2", "FAILED"),
      runTask("schedule:sweep:3", "VERIFIED"),
      runTask("schedule:hub-reviewer-abc", "FAILED", "a reviewer run — two segments, not a schedule origin"),
    ],
    reviewOutcomes: new Map([["author-2", { verdict: "approved", summary: "fine" }]]),
    blockingReasons: new Map(),
    budgetIncidents: [{ sessionId: "s1", tier: "warn", mechanism: "capped" }, { sessionId: "s2", tier: "abort", reason: "2.1x the cap" }],
    orphans: [{ runId: "author-9", reason: "hub restarted mid-run" }],
    schedules: [{ id: "nightly", title: "Nightly sweep" }, { id: "sweep", title: "Sweep" }],
  });
  assert.deepEqual(posture.counts, {
    awaitingReview: 1, // author-1 only — author-2 carries a recorded verdict
    budgetIncidents: 2,
    orphanedRuns: 1,
    failedSchedules: 1, // nightly's two failed runs group to ONE schedule
  });
  assert.deepEqual(posture.degraded, []);
  const kinds = new Set(posture.decisions.map((row) => row.kind));
  assert.deepEqual([...kinds].sort(), ["budget", "orphan", "review", "schedule"]);
  // The reviewer run shares the schedule: prefix but is not a schedule
  // origin — it never produces a schedule decision row.
  assert.equal(posture.decisions.some((row) => row.summary.includes("hub-reviewer")), false);
});

test("W150: awaiting-review means VERIFYING with no recorded verdict — IN_PROGRESS and gated-then-verified runs are not awaiting", () => {
  const posture = operatorPosture({
    runTasks: [
      runTask("a", "VERIFYING"),
      runTask("b", "VERIFYING"),
      runTask("c", "IN_PROGRESS"),
      runTask("d", "VERIFIED"),
    ],
    reviewOutcomes: new Map([["b", { verdict: "approved", summary: "ok" }]]),
    blockingReasons: new Map(),
  });
  assert.equal(posture.counts.awaitingReview, 1);
  assert.ok(posture.decisions.every((row) => !row.summary.includes("run c") && !row.summary.includes("run d")));
});

test("W150: fail-closed degraded state — an absent registry NULLS its count and is NAMED, never a fabricated zero", () => {
  const posture = operatorPosture({ runTasks: [runTask("a", "VERIFYING")] });
  assert.deepEqual([...posture.degraded].sort(), ["orphaned-run detection", "per-session budget state", "run-gate observability", "schedule registry"]);
  assert.deepEqual(posture.counts, { awaitingReview: null, budgetIncidents: null, orphanedRuns: null, failedSchedules: 0 });
  // No decision rows for data the projection was never given.
  assert.equal(posture.decisions.some((row) => row.kind === "budget"), false);
  assert.equal(posture.decisions.some((row) => row.kind === "orphan"), false);
});

test("W150: failedSchedules stays a NUMBER even when the schedule registry is absent (it needs only the kernel graph)", () => {
  const posture = operatorPosture({
    runTasks: [runTask("schedule:nightly:1", "FAILED"), runTask("schedule:hub-reviewer-abc", "FAILED")],
  });
  assert.equal(posture.counts.failedSchedules, 1); // the reviewer run is not a schedule origin
  assert.deepEqual(posture.degraded, ["run-gate observability", "per-session budget state", "orphaned-run detection", "schedule registry"]);
  const scheduleRow = posture.decisions.find((row) => row.kind === "schedule")!;
  assert.ok(scheduleRow.summary.includes("nightly"), "the registry id names the schedule when the registry is absent");
});

test("W150: the decision list carries actor + authority attribution from the record kind, and actions link into existing panels", () => {
  const posture = operatorPosture({
    runTasks: [runTask("author-1", "VERIFYING", "the nightly candidate"), runTask("author-0", "VERIFYING", "the blocked candidate")],
    reviewOutcomes: new Map(),
    blockingReasons: new Map([["author-0", "changes_requested: the coverage line was missing"], ["author-5", "scheduler failure: the workspace was gone"]]),
    budgetIncidents: [{ sessionId: "sess-1", title: "the loop", tier: "abort", mechanism: "capped", reason: "over cap" }],
    orphans: [{ runId: "author-9", reason: "hub restarted mid-run" }],
    schedules: [{ id: "nightly", title: "Nightly sweep" }],
  });
  const byKind = (kind: string) => posture.decisions.filter((row) => row.kind === kind);
  const review = byKind("review");
  // FOUR review rows, and that is the honest wire shape: author-1 awaits a
  // verdict; author-0 carries BOTH the awaiting row (it is parked VERIFYING)
  // and the blocked row — the test-runner rejection lane records the gate's
  // output as a blocking reason while the run stays VERIFYING awaiting its
  // retry (run-registry.ts:424); author-5's blocking reason is keyed to an
  // unknown run and still renders by raw id.
  assert.equal(review.length, 4);
  const awaiting = review.find((row) => row.actor === "agent" && row.summary.includes("the nightly candidate"))!;
  assert.equal(awaiting.authority, "run review gate (requiresReview)");
  assert.deepEqual(awaiting.action, { label: "Open run", target: "#run:author-1" });
  const blockedRows = review.filter((row) => row.actor === "system");
  assert.equal(blockedRows.length, 2);
  for (const row of blockedRows) {
    assert.equal(row.authority, "recorded blocking reason (run registry)");
    assert.deepEqual(row.action, { label: "Inspect", target: `#run:${row.summary.startsWith("the blocked candidate") ? "author-0" : "author-5"}` });
  }
  assert.ok(blockedRows.some((row) => row.summary.includes("the blocked candidate")), "the title joins on the raw id");
  assert.ok(blockedRows.some((row) => row.summary.includes("author-5")), "an unknown runId falls back to the raw id");
  assert.ok(blockedRows.some((row) => row.summary.includes("scheduler failure")), "the blocking map's non-reviewer families render with their real reason");
  const budget = byKind("budget")[0]!;
  assert.equal(budget.actor, "budget guard");
  assert.ok(budget.authority.includes("W045"));
  assert.ok(budget.authority.includes("capped"));
  assert.ok(budget.summary.includes("abort"));
  assert.deepEqual(budget.action, { label: "Open session", target: "#session:sess-1" });
  const orphan = byKind("orphan")[0]!;
  assert.equal(orphan.actor, "system");
  assert.equal(orphan.authority, "orphaned-run detection (recover-or-discard, fail-closed)");
  assert.deepEqual(orphan.action, { label: "Recover or discard", target: "#run:author-9" });
  assert.equal(byKind("schedule").length, 0); // no failed schedule runs in this input
});

test("W150: the projection is pure — the same input yields an equal result and the inputs are not mutated", () => {
  const runTasks = [runTask("a", "VERIFYING")];
  const blockingReasons = new Map([["a", "changes_requested: x"]]);
  const input = { runTasks, blockingReasons, schedules: [{ id: "s", title: "S" }] };
  const first = operatorPosture(input);
  const second = operatorPosture(input);
  assert.deepEqual(first, second);
  assert.equal(blockingReasons.size, 1);
  assert.equal(runTasks.length, 1);
  assert.deepEqual([...input.blockingReasons.entries()], [["a", "changes_requested: x"]]);
});

test("W153: schedule lineage joins on the RAW run id's schedule-origin prefix, takes the last outcome from the graph's insertion order, and tombstones deleted schedules", () => {
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

test("W153: an unrun schedule reports unrun; a reviewer run is not a schedule origin", () => {
  const lineage = scheduleLineage({
    schedules: [{ id: "fresh", title: "Fresh" }],
    runTasks: [runTask("schedule:nightly:1", "VERIFIED"), runTask("schedule:hub-reviewer-xyz", "FAILED")],
  });
  const fresh = lineage.find((entry) => entry.scheduleId === "fresh")!;
  assert.equal(fresh.lastOutcome, "unrun");
  assert.equal(fresh.causedRuns, 0);
  assert.equal(fresh.tombstoned, false);
  assert.equal(lineage.some((entry) => entry.scheduleId.startsWith("hub-reviewer")), false);
});