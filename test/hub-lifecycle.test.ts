import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { spawn } from "node:child_process";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "task", state: "READY", dependencies: [], requiredEvidence: [] }];

function application() {
  return new WorkflowApplication(
    new TaskGraph(tasks.map((task) => ({ ...task }))),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    process.cwd(),
  );
}

function discovery(dir: string): { endpoint: string; token: string } {
  return JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));
}

test("hub answers POST /health for an authenticated probe", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());
  const { endpoint, token } = discovery(dir);

  const ok = await fetch(`${endpoint}/health`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: "ok" });

  const anonymous = await fetch(`${endpoint}/health`, { method: "POST" });
  assert.equal(anonymous.status, 401);
});

test("a second hub refuses to start while the first is alive", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => first.close());

  await assert.rejects(() => createWorkflowHub(application(), { discoveryDir: dir }), /already running/);
});

test("a hub can start again after the previous one closed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await createWorkflowHub(application(), { discoveryDir: dir });
  await first.close();

  const second = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => second.close());
  const { endpoint } = discovery(dir);
  assert.equal(endpoint, second.url);
});

test("a stale lock from a dead process is reclaimed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockDir = join(dir, "hub", "lock");
  mkdirSync(lockDir, { recursive: true });
  // pid 4194303 is above the default Linux pid_max and cannot be alive.
  writeFileSync(join(lockDir, "pid"), "4194303");

  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());
  assert.equal(hub.url, discovery(dir).endpoint);
});

test("a recycled pid whose lease identity does not match is reclaimed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Spawn a live, unrelated process and write a lock record naming its pid but
  // a foreign start time — the shape of a dead hub's recycled pid.
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => unrelated.kill("SIGKILL"));
  await new Promise<void>((resolve) => unrelated.once("spawn", () => resolve()));
  const livePid = unrelated.pid;
  assert.ok(livePid !== undefined && livePid > 0, "unrelated process has a pid");

  const lockDir = join(dir, "hub", "lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: livePid, startTime: "999999", host: hostname(), token: "recycled" }),
  );

  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());
  assert.equal(hub.url, discovery(dir).endpoint);
});

test("a lock whose owner is on another host is NOT reclaimed (fail closed)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A record naming a different host: liveness cannot be verified from here,
  // so the lock must be treated as live rather than deleted out from under a
  // hub on a shared mount (the multi-revision scenario). Our own pid keeps the
  // record otherwise well-formed.
  const lockDir = join(dir, "hub", "lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: process.pid, startTime: "1", host: "some-other-host", token: "foreign" }),
  );

  await assert.rejects(() => createWorkflowHub(application(), { discoveryDir: dir }), /already running/);
});

test("a legacy pid-file lock whose owner is alive on this host is honored", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The pre-lease format (bare `pid`) with a live same-host owner: honored, so
  // migration never steals a running hub's lock.
  const lockDir = join(dir, "hub", "lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "pid"), String(process.pid));

  await assert.rejects(() => createWorkflowHub(application(), { discoveryDir: dir }), /already running/);
});

test("closing the hub releases the instance lock", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(join(dir, "hub", "lock")));
  await hub.close();
  assert.equal(existsSync(join(dir, "hub", "lock")), false);
});
