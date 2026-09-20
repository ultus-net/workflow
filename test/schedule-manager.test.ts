import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createHubScheduler,
  loadSchedulesTable,
  nextCronMatch,
  type ScheduleDefinition,
} from "../src/integrations/hub-scheduler.js";
import { createScheduleRegistry } from "../src/integrations/schedule-registry.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import type { HubScheduler } from "../src/integrations/hub-scheduler.js";

/**
 * W074 scheduled-task manager: next-run preview, paused-schedule skip, explicit
 * run-now, the live registry over the persisted table, and the operator-token
 * hub routes.
 */

const schedule = (overrides: Partial<ScheduleDefinition> = {}): ScheduleDefinition => ({
  id: "nightly",
  title: "Nightly audit",
  cron: "0 9 * * *",
  prompt: "audit dependencies",
  ...overrides,
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

// ── next-run preview ───────────────────────────────────────────────────────

test("nextCronMatch returns the next matching minute strictly after `from`", () => {
  const next = nextCronMatch("0 9 * * *", new Date(2026, 0, 1, 8, 30, 42));
  assert.ok(next !== undefined);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  assert.ok(next.getTime() > new Date(2026, 0, 1, 8, 30, 42).getTime());

  const quarter = nextCronMatch("*/15 * * * *", new Date(2026, 0, 1, 8, 7));
  assert.equal(quarter?.getHours(), 8);
  assert.equal(quarter?.getMinutes(), 15);
});

test("nextCronMatch fails closed on a malformed expression", () => {
  assert.throws(() => nextCronMatch("not a cron", new Date(2026, 0, 1)), /invalid cron/);
});

// ── scheduler: paused skip + run-now ───────────────────────────────────────

function schedulerHarness(definitions: ScheduleDefinition[]): { scheduler: HubScheduler; fired: string[] } {
  const fired: string[] = [];
  const controller = {
    begin: async () => undefined,
    finish: async () => undefined,
    review: async () => ({ recorded: false }),
    hiddenSnapshotTaskIds: () => [],
  };
  const scheduler = createHubScheduler({
    controller: controller as never,
    schedules: () => definitions,
    runTurn: async ({ runId }) => {
      fired.push(runId);
    },
  });
  return { scheduler, fired };
}

test("a paused schedule is skipped by the clock but still fires on explicit run-now", async () => {
  const { scheduler, fired } = schedulerHarness([schedule({ enabled: false })]);
  await scheduler.tick(new Date(2026, 0, 1, 9, 0));
  assert.equal(fired.length, 0, "the tick skipped the paused schedule");
  assert.equal(await scheduler.trigger("nightly"), true);
  assert.equal(fired.length, 1, "run-now fired the paused schedule explicitly");
  assert.match(fired[0] ?? "", /^schedule:nightly:/);
});

test("trigger reports an unknown schedule without firing", async () => {
  const { scheduler, fired } = schedulerHarness([schedule()]);
  assert.equal(await scheduler.trigger("ghost"), false);
  assert.equal(fired.length, 0);
});

test("run-now and tick cannot double-fire or overlap the same schedule", async () => {
  const gate = deferred<void>();
  const fired: string[] = [];
  const controller = {
    begin: async () => undefined,
    finish: async () => undefined,
    review: async () => ({ recorded: false }),
    hiddenSnapshotTaskIds: () => [],
  };
  const scheduler = createHubScheduler({
    controller: controller as never,
    schedules: () => [schedule()],
    now: () => new Date(2026, 0, 1, 9, 0),
    runTurn: async ({ runId }) => {
      fired.push(runId);
      await gate.promise;
    },
  });

  const inFlight = scheduler.trigger("nightly");
  assert.equal(await scheduler.trigger("nightly"), true, "a run-now during an in-flight run is acknowledged but not fired twice");
  gate.resolve();
  await inFlight;
  assert.equal(fired.length, 1, "overlapping fires are collapsed");

  // Run-now consumed this minute: the cron-matching tick at the same minute
  // must not fire the schedule again.
  await scheduler.tick(new Date(2026, 0, 1, 9, 0));
  assert.equal(fired.length, 1);
});

// ── live schedule registry ─────────────────────────────────────────────────

test("the schedule registry persists CRUD changes through the versioned table", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-schedule-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "scheduler.json");
  const registry = createScheduleRegistry({ path });

  assert.deepEqual(registry.list(), []);
  registry.save(schedule());
  registry.save(schedule({ id: "hourly", title: "Hourly", cron: "0 * * * *", prompt: "check" }));
  assert.equal(registry.list().length, 2);
  assert.equal(registry.get("nightly")?.title, "Nightly audit");

  // Persistence is real: the on-disk table reflects the save.
  const reloaded = loadSchedulesTable(path);
  assert.equal(reloaded.length, 2);
  assert.match(readFileSync(path, "utf8"), /"version": 1/);

  // Update replaces in place; remove deletes.
  registry.save(schedule({ title: "Nightly audit v2" }));
  assert.equal(registry.get("nightly")?.title, "Nightly audit v2");
  assert.equal(registry.list().length, 2);
  registry.remove("hourly");
  assert.equal(registry.list().length, 1);
  assert.equal(loadSchedulesTable(path).length, 1);
});

test("an invalid schedule is rejected before it is admitted in memory", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-schedule-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = createScheduleRegistry({ path: join(dir, "scheduler.json") });
  assert.throws(() => registry.save(schedule({ cron: "garbage" })), /invalid cron/);
  assert.equal(registry.list().length, 0, "the bad entry never entered the table");
});

test("runNow is false until a runner is attached, then delegates", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-schedule-runnow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = createScheduleRegistry({ path: join(dir, "scheduler.json") });
  registry.save(schedule());
  assert.equal(await registry.runNow("nightly"), false, "no runner attached yet");
  const seen: string[] = [];
  registry.attachRunner(async (id) => {
    seen.push(id);
    return true;
  });
  assert.equal(await registry.runNow("nightly"), true);
  assert.deepEqual(seen, ["nightly"]);
});

// ── hub routes ─────────────────────────────────────────────────────────────

const tasks: WorkflowTask[] = [
  { id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] },
];

async function post(url: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("operator routes list, save, delete, and run-now schedules", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-schedule-"));
  const ws = mkdtempSync(join(tmpdir(), "wf-hub-schedule-ws-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    ws,
  );
  const registry = createScheduleRegistry({ path: join(dir, "scheduler.json") });
  const triggered: string[] = [];
  const hub = await createWorkflowHub(application, {
    discoveryDir: dir,
    graph,
    schedules: registry,
    schedulerFactory: () => ({
      tick: async () => undefined,
      trigger: async (id: string) => {
        triggered.push(id);
        return id === "nightly";
      },
      start: () => undefined,
      stop: () => undefined,
    }),
  });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8")) as { token: string };

  const saved = await post(hub.url, token, "/schedule/save", schedule({ workspace: ws }));
  assert.equal(saved.status, 200);
  assert.equal((saved.body.schedules as unknown[]).length, 1);

  const listed = await post(hub.url, token, "/schedule/list", {});
  assert.equal(listed.status, 200);
  assert.equal((listed.body.schedules as Array<{ id: string }>)[0]?.id, "nightly");

  const runNow = await post(hub.url, hub.verificationToken, "/schedule/run-now", { id: "nightly" });
  assert.equal(runNow.status, 200, "run-now is a consequential action: verifier credential only");
  assert.equal(runNow.body.fired, true);
  assert.deepEqual(triggered, ["nightly"]);
  assert.equal((await post(hub.url, token, "/schedule/run-now", { id: "nightly" })).status, 401, "the ordinary surface token cannot fire a schedule");

  const verifier = await post(hub.url, hub.verificationToken, "/schedule/list", {});
  assert.equal(verifier.status, 401, "the verifier token is not an operator token");

  const deleted = await post(hub.url, token, "/schedule/delete", { id: "nightly" });
  assert.equal(deleted.status, 200);
  assert.equal((deleted.body.schedules as unknown[]).length, 0);

  const invalid = await post(hub.url, token, "/schedule/save", { id: "x", title: "t", cron: "garbage", prompt: "p" });
  assert.equal(invalid.status, 400);
});

test("schedule routes 404 when no schedule registry is configured", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-schedule-none-"));
  const ws = mkdtempSync(join(tmpdir(), "wf-hub-schedule-none-ws-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation"]),
    ws,
  );
  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8")) as { token: string };
  assert.equal((await post(hub.url, token, "/schedule/list", {})).status, 404);
});