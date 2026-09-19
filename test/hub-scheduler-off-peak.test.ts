import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { createHubScheduler, type ScheduleDefinition } from "../src/integrations/hub-scheduler.js";

/**
 * W070a: off-peak scheduler hook. Deferral uses UTC windows, so the tests pin
 * UTC instants and a wildcard cron to stay independent of the host timezone.
 */

function harness(t: TestContext, schedule: Partial<ScheduleDefinition> & { id: string }, env: NodeJS.ProcessEnv = {}) {
  const turns: string[] = [];
  const logs: string[] = [];
  const controller = {
    async begin() {},
    async finish() {},
    review: async () => ({ recorded: false }),
    hiddenSnapshotTaskIds: () => [] as const,
  };
  const scheduler = createHubScheduler({
    controller,
    schedules: () => [{ cron: "* * * * *", prompt: "batch job", title: "Batch", ...schedule } as ScheduleDefinition],
    runTurn: async (input) => {
      turns.push(input.runId);
    },
    log: (message) => logs.push(message),
    env,
  });
  t.after(() => scheduler.stop());
  return { scheduler, turns, logs };
}

const utc = (y: number, m: number, d: number, h: number, min = 0): Date => new Date(Date.UTC(y, m - 1, d, h, min, 0, 0));

test("a required off-peak schedule defers during peak and fires when the window opens", async (t) => {
  const { scheduler, turns, logs } = harness(t, { id: "batch", offPeak: "glm" });

  // Friday 09:00 UTC is GLM peak (Mon-Fri 06:00-10:00 UTC).
  await scheduler.tick(utc(2026, 9, 18, 9, 0));
  assert.equal(turns.length, 0, "nothing fires during peak");
  assert.ok(logs.some((line) => /deferred until the glm off-peak window/.test(line)), "the deferral is logged");

  await scheduler.tick(utc(2026, 9, 18, 10, 0));
  assert.equal(turns.length, 1, "the deferred run fires once the window opens");

  await scheduler.tick(utc(2026, 9, 18, 10, 0));
  assert.equal(turns.length, 1, "the deferred run does not double-fire in the same minute");
});

test("an unknown off-peak window fails open and records the gap", async (t) => {
  const { scheduler, turns, logs } = harness(t, { id: "batch", offPeak: "deepseek" }, {});

  await scheduler.tick(utc(2026, 9, 18, 12, 0));
  assert.equal(turns.length, 1, "an unknown window must not defer forever");
  assert.ok(logs.some((line) => /off-peak window for deepseek is unknown/.test(line)));
});

test("offPeakRequired=false runs at peak time and does not defer", async (t) => {
  const { scheduler, turns, logs } = harness(t, { id: "batch", offPeak: "glm", offPeakRequired: false });

  await scheduler.tick(utc(2026, 9, 18, 9, 0));
  assert.equal(turns.length, 1);
  assert.equal(logs.some((line) => /deferred/.test(line)), false);
});

test("schedules without an off-peak declaration are unaffected", async (t) => {
  const { scheduler, turns } = harness(t, { id: "always" });
  await scheduler.tick(utc(2026, 9, 18, 9, 0));
  assert.equal(turns.length, 1);
});
