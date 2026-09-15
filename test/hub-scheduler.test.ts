import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  budgetViolation,
  createBudgetGuard,
  createHubScheduler,
  cronMatches,
  loadSchedulesTable,
  saveSchedulesTable,
  type RunBudget,
  type ScheduleDefinition,
} from "../src/integrations/hub-scheduler.js";

/**
 * Plan Tasks C1/C2: the hub-native scheduler (cron table in the data dir,
 * contained ACP runs with requiresReview default, fail closed) and per-run
 * budget enforcement (token/cost caps from metering-proxy metrics; exceeding
 * a cap aborts the turn and fails the run with the budget as blocking reason).
 */

// ── Cron parser ─────────────────────────────────────────────────────────────

test("cronMatches supports wildcard, exact, step, list, and range fields", () => {
  const date = (minute: number, hour: number, day: number, month: number, _weekday: number) =>
    new Date(2026, month - 1, day, hour, minute, 0, 0);
  const friday = date(0, 9, 18, 9, 0);

  assert.equal(cronMatches("* * * * *", friday), true);
  assert.equal(cronMatches("0 9 18 9 *", friday), true);
  assert.equal(cronMatches("30 9 * * *", friday), false);
  assert.equal(cronMatches("*/15 * * * *", date(45, 9, 18, 9, 0)), true);
  assert.equal(cronMatches("*/15 * * * *", date(44, 9, 18, 9, 0)), false);
  assert.equal(cronMatches("0 9,18 * * *", friday), true);
  assert.equal(cronMatches("0 8-10 * * *", friday), true);
  assert.equal(cronMatches("0 9 * * 5", friday), true);
  assert.equal(cronMatches("0 9 * * 1", friday), false);
});

test("cronMatches fails closed on malformed expressions", () => {
  for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "a b c d e", "* * * * * *"]) {
    assert.throws(() => cronMatches(bad, new Date()), /invalid cron/, `expected rejection: '${bad}'`);
  }
});

// ── Budget enforcement (C2) ────────────────────────────────────────────────

test("budgetViolation reports the first exceeded cap or nothing", () => {
  const usage = { promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500, costUsd: 0.02 };
  assert.equal(budgetViolation(usage, {}), undefined);
  assert.equal(budgetViolation(usage, { maxTotalTokens: 2_000 }), undefined);
  assert.match(budgetViolation(usage, { maxTotalTokens: 1_000 })!, /total tokens/);
  assert.match(budgetViolation(usage, { maxInputTokens: 500 })!, /input tokens/);
  assert.match(budgetViolation(usage, { maxOutputTokens: 400 })!, /output tokens/);
  assert.match(budgetViolation(usage, { maxCostUsd: 0.01 })!, /cost/);
  const order: RunBudget = { maxCostUsd: 0.01, maxTotalTokens: 1 };
  assert.match(budgetViolation(usage, order)!, /total tokens/);
});

test("createBudgetGuard cancels the turn on the first violating event", () => {
  const cancellations: number[] = [];
  let subscribed = 0;
  let usage = { promptTokens: 100, completionTokens: 10, totalTokens: 110, costUsd: 0.001 };
  const guard = createBudgetGuard({
    budget: { maxTotalTokens: 500 },
    usageSnapshot: () => usage,
    cancel: async () => {
      cancellations.push(cancellations.length);
    },
    subscribe: (listener: (event: { type: string }) => void) => {
      subscribed += 1;
      void listener;
      return () => undefined;
    },
  });
  guard.attach();
  assert.equal(subscribed, 1);
  assert.equal(guard.violation(), undefined);

  usage = { promptTokens: 400, completionTokens: 200, totalTokens: 600, costUsd: 0.01 };
  guard.checkEvent({ type: "assistant" });
  assert.match(guard.violation()!, /total tokens/);
  assert.equal(cancellations.length, 1, "the violating turn must be cancelled");
  // Further events do not cancel repeatedly.
  guard.checkEvent({ type: "tool-proposal" });
  assert.equal(cancellations.length, 1);
});

// ── Scheduler (C1) ──────────────────────────────────────────────────────────

function stubController() {
  const calls: Array<{ kind: "begin" | "finish" | "reason"; runId: string; detail?: string }> = [];
  return {
    calls,
    controller: {
      async begin(input: { runId: string; title: string; workspace?: string; requiresReview?: boolean }) {
        calls.push({ kind: "begin", runId: input.runId, detail: input.requiresReview === undefined ? "unset" : String(input.requiresReview) });
      },
      async finish(input: { runId: string; outcome: "verified" | "failed" }) {
        calls.push({ kind: "finish", runId: input.runId, detail: input.outcome });
      },
      review: async () => ({ recorded: false }),
      hiddenSnapshotTaskIds: () => [] as const,
    },
  };
}

function schedulerHarness(t: TestContext, options: {
  schedule: Partial<ScheduleDefinition> & { id: string };
  turnError?: Error;
  finishError?: Error;
}) {
  const { calls, controller } = stubController();
  const turns: Array<{ runId: string; prompt: string; budget: RunBudget | undefined }> = [];
  const logs: string[] = [];
  const scheduler = createHubScheduler({
    controller: {
      ...controller,
      async finish(input: { runId: string; outcome: "verified" | "failed" }) {
        if (options.finishError !== undefined) throw options.finishError;
        return controller.finish(input);
      },
    },
    schedules: async () => [{ cron: "0 9 * * *", prompt: "nightly audit", workspace: "/ws", title: "Nightly audit", ...options.schedule } as ScheduleDefinition],
    runTurn: async (input) => {
      turns.push({ runId: input.runId, prompt: input.prompt, budget: input.budget });
      if (options.turnError !== undefined) throw options.turnError;
    },
    log: (message) => logs.push(message),
  });
  t.after(() => scheduler.stop());
  return { scheduler, calls, turns, logs };
}

test("a due schedule spawns a review-gated run and verifies it on turn success", async (t) => {
  const { scheduler, calls, turns } = schedulerHarness(t, { schedule: { id: "nightly" } });
  const at = new Date(2026, 8, 18, 9, 0, 0, 0);

  await scheduler.tick(at);

  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.prompt, "nightly audit");
  const begin = calls.find(({ kind }) => kind === "begin");
  const finish = calls.find(({ kind }) => kind === "finish");
  assert.ok(begin !== undefined);
  assert.match(begin.runId, /^schedule:nightly:/);
  assert.equal(begin.detail, "true", "requiresReview defaults to true");
  assert.ok(finish !== undefined);
  assert.equal(finish.detail, "verified");
  assert.ok(begin.runId === finish.runId, "begin and finish bind the same run");
  assert.equal(turns[0]!.runId, begin.runId);
});

test("a schedule does not fire twice within the same minute and not before it is due", async (t) => {
  const { scheduler, calls } = schedulerHarness(t, { schedule: { id: "once" } });
  const at = new Date(2026, 8, 18, 9, 0, 0, 0);

  await scheduler.tick(at);
  await scheduler.tick(at);
  assert.equal(calls.filter(({ kind }) => kind === "begin").length, 1);

  await scheduler.tick(new Date(2026, 8, 18, 9, 1, 0, 0));
  assert.equal(calls.filter(({ kind }) => kind === "begin").length, 1, "9:01 does not match 0 9 * * *");

  await scheduler.tick(new Date(2026, 8, 19, 9, 0, 0, 0));
  assert.equal(calls.filter(({ kind }) => kind === "begin").length, 2);
});

test("a crashed turn fails the run closed and never escapes the tick", async (t) => {
  const { scheduler, calls, logs } = schedulerHarness(t, {
    schedule: { id: "crashy" },
    turnError: new Error("agent crashed"),
  });

  await scheduler.tick(new Date(2026, 8, 18, 9, 0, 0, 0));

  const begin = calls.find(({ kind }) => kind === "begin");
  const finish = calls.find(({ kind }) => kind === "finish");
  assert.ok(begin !== undefined);
  assert.ok(finish !== undefined);
  assert.equal(finish.detail, "failed");
  assert.ok(logs.some((message) => /agent crashed/.test(message)));
});

test("a rejected finish gate (review/test evidence) is surfaced, not swallowed", async (t) => {
  const { scheduler, calls, logs } = schedulerHarness(t, {
    schedule: { id: "gated" },
    finishError: new Error("cannot verify run: reviewer did not approve the run"),
  });

  await scheduler.tick(new Date(2026, 8, 18, 9, 0, 0, 0));

  const finish = calls.find(({ kind }) => kind === "finish");
  assert.ok(finish === undefined || finish.detail === "failed", "no fabricated verified finish");
  assert.ok(logs.some((message) => /reviewer did not approve/.test(message)));
});

test("a runId is never reused across fires", async (t) => {
  const { scheduler, calls } = schedulerHarness(t, { schedule: { id: "dedupe" } });
  await scheduler.tick(new Date(2026, 8, 18, 9, 0, 0, 0));
  await scheduler.tick(new Date(2026, 8, 19, 9, 0, 0, 0));
  const ids = calls.filter(({ kind }) => kind === "begin").map(({ runId }) => runId);
  assert.equal(new Set(ids).size, ids.length);
});

// ── Persisted table ────────────────────────────────────────────────────────

test("the schedule table round-trips and fails closed on malformed or future versions", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-schedule-table-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "scheduler.json");

  const schedules: ScheduleDefinition[] = [{
    id: "nightly",
    title: "Nightly audit",
    cron: "0 9 * * *",
    prompt: "run the audit",
    workspace: "/ws",
    requiresReview: true,
    budget: { maxTotalTokens: 50_000, maxCostUsd: 0.5 },
  }];
  saveSchedulesTable(path, schedules);
  assert.deepEqual(loadSchedulesTable(path), schedules);

  writeFileSync(path, "{ not json", "utf8");
  assert.throws(() => loadSchedulesTable(path), /invalid schedule table/);

  writeFileSync(path, JSON.stringify({ version: 2, schedules: [] }), "utf8");
  assert.throws(() => loadSchedulesTable(path), /version/);

  const missing = join(dir, "absent.json");
  assert.deepEqual(loadSchedulesTable(missing), [], "a missing table means no schedules, not a crash");
});