import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDurableTimerTable, loadTimersTable, saveTimersTable } from "../src/integrations/durable-timers.js";
import { createHubScheduler, type ScheduleDefinition } from "../src/integrations/hub-scheduler.js";

/**
 * W199 / durability plan acceptance checks D2 and D3.
 *
 * D2: persist a timer with `wakeAt` in the past, restart the process, call
 * `tick(now)`; it fires exactly once, `firedAt` is set, a second tick does not
 * re-fire.
 *
 * D3: register a timer for `now + 3h`, kill the process, advance the injected
 * clock past `wakeAt`, tick fires it once (the "did not fire because the machine
 * rebooted" case from Q73).
 */

const noSchedules = (): readonly ScheduleDefinition[] => [];

function schedulerWithTimers(options: {
  readonly timerPath: string;
  readonly resume: (id: string) => void;
  readonly now: Date;
}) {
  const timers = createDurableTimerTable({ path: options.timerPath });
  return {
    timers,
    scheduler: createHubScheduler({
      controller: { begin: async () => undefined, finish: async () => undefined } as never,
      schedules: noSchedules,
      runTurn: async () => undefined,
      timers,
      resumeTimer: async (timer) => {
        options.resume(timer.id);
      },
      now: () => options.now,
      log: () => undefined,
    }),
  };
}

test("D2: a persisted past-due timer fires once across a restart, then never again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-timer-"));
  const path = join(dir, "timers.json");
  try {
    saveTimersTable(path, [
      { id: "wake-1", runId: "run-1", wakeAt: "2026-10-14T00:00:00.000Z", payload: { reminderId: "r1" } },
    ]);

    // "Restart": a fresh table loaded from the same path.
    const fired: string[] = [];
    const now = new Date("2026-10-15T00:00:00.000Z");
    const { scheduler } = schedulerWithTimers({ timerPath: path, resume: (id) => fired.push(id), now });

    await scheduler.tick(now);
    assert.deepEqual(fired, ["wake-1"], "the due timer fired once");
    const persisted = loadTimersTable(path);
    assert.equal(persisted[0]!.firedAt, now.toISOString(), "firedAt was recorded");

    await scheduler.tick(now);
    assert.deepEqual(fired, ["wake-1"], "a second tick does not re-fire");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D3: a future timer (now + 3h) survives a restart and fires once the clock passes wakeAt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-timer-care-"));
  const path = join(dir, "timers.json");
  const t0 = new Date("2026-10-15T00:00:00.000Z");
  const wakeAt = new Date(t0.getTime() + 3 * 60 * 60 * 1000);
  try {
    saveTimersTable(path, [{ id: "reminder-1", runId: "care-run-1", wakeAt: wakeAt.toISOString(), payload: { reminderId: "r1" } }]);

    const fired: string[] = [];
    // Restart before the wake instant: nothing fires.
    const before = schedulerWithTimers({ timerPath: path, resume: (id: string) => { fired.push(id); }, now: t0 });
    await before.scheduler.tick(t0);
    assert.deepEqual<string[]>(fired, [], "a future timer does not fire early");

    // Restart after the wake instant: it fires exactly once.
    const after = schedulerWithTimers({
      timerPath: path,
      resume: (id: string) => { fired.push(id); },
      now: new Date(wakeAt.getTime() + 1),
    });
    await after.scheduler.tick(new Date(wakeAt.getTime() + 1));
    assert.deepEqual(fired, ["reminder-1"], "the reminder delivered after the reboot");

    await after.scheduler.tick(new Date(wakeAt.getTime() + 60_000));
    assert.deepEqual(fired, ["reminder-1"], "no double delivery");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D3: a resume that throws leaves the timer unfired so the next tick retries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-timer-retry-"));
  const path = join(dir, "timers.json");
  const now = new Date("2026-10-15T00:00:00.000Z");
  try {
    saveTimersTable(path, [{ id: "flaky", runId: "run-1", wakeAt: "2026-10-14T00:00:00.000Z", payload: null }]);
    let attempts = 0;
    const timers = createDurableTimerTable({ path });
    const scheduler = createHubScheduler({
      controller: { begin: async () => undefined, finish: async () => undefined } as never,
      schedules: noSchedules,
      runTurn: async () => undefined,
      timers,
      resumeTimer: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
      },
      now: () => now,
      log: () => undefined,
    });
    await scheduler.tick(now);
    assert.equal(attempts, 1);
    assert.equal(loadTimersTable(path)[0]!.firedAt, undefined, "a failed resume does not mark fired");
    await scheduler.tick(now);
    assert.equal(attempts, 2, "the retry ran");
    assert.equal(loadTimersTable(path)[0]!.firedAt, now.toISOString(), "the retry succeeded and marked fired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D2: a duplicate timer id in a persisted table is rejected (fail closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-timer-dup-"));
  const path = join(dir, "timers.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        timers: [
          { id: "dup", runId: "a", wakeAt: "2026-10-14T00:00:00.000Z", payload: null },
          { id: "dup", runId: "b", wakeAt: "2026-10-14T00:00:00.000Z", payload: null },
        ],
      }),
      "utf8",
    );
    assert.throws(() => createDurableTimerTable({ path }), /duplicate timer id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D2: due() is ordered oldest-first and ignores fired timers", () => {
  const table = createDurableTimerTable();
  table.add({ id: "late", runId: "r", wakeAt: "2026-10-15T05:00:00.000Z", payload: null });
  table.add({ id: "early", runId: "r", wakeAt: "2026-10-15T01:00:00.000Z", payload: null });
  table.add({ id: "future", runId: "r", wakeAt: "2026-10-16T00:00:00.000Z", payload: null });
  const due = table.due(new Date("2026-10-15T06:00:00.000Z"));
  assert.deepEqual(due.map((t) => t.id), ["early", "late"]);
  table.markFired("early", new Date("2026-10-15T06:00:00.000Z"));
  assert.deepEqual(table.due(new Date("2026-10-15T06:00:00.000Z")).map((t) => t.id), ["late"]);
});
