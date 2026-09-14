import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import { probeHub, readHubDiscovery, resolveWorkflowHub, resolveHubSpawnCandidates } from "../src/cli/hub-client.js";
import packageJson from "../package.json" with { type: "json" };

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "task", state: "READY", dependencies: [], requiredEvidence: [] }];
function application() {
  return new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    process.cwd(),
  );
}

test("source checkout exposes the Workflow hub daemon", () => {
  assert.equal(packageJson.scripts.hub, "tsx src/cli/hub.ts");
});

test("readHubDiscovery returns undefined when the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  try {
    assert.equal(readHubDiscovery(resolveHubDiscoveryPath(dir)), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHubDiscovery parses a discovery file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());

  const discovery = readHubDiscovery(resolveHubDiscoveryPath(dir));
  assert.ok(discovery);
  assert.equal(discovery.endpoint, hub.url);
  assert.equal(typeof discovery.hubId, "string");
  assert.equal(discovery.token.length, 64);
});

test("probeHub is true for a live hub and false for a stale token or dead endpoint", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());

  assert.equal(await probeHub({ hubId: "x", endpoint: hub.url, token: readHubDiscovery(hub.discoveryPath)!.token }), true);
  assert.equal(await probeHub({ hubId: "x", endpoint: hub.url, token: "0".repeat(64) }), false);
  assert.equal(await probeHub({ hubId: "x", endpoint: "http://127.0.0.1:1", token: "0".repeat(64) }), false);
});

test("resolveWorkflowHub returns the live hub authority", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());

  const resolved = await resolveWorkflowHub({ discoveryDir: dir });
  assert.equal(resolved.url, hub.url);
  assert.equal(resolved.token, readHubDiscovery(hub.discoveryPath)!.token);
});

test("resolveWorkflowHub fails closed when the hub is not running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  try {
    await assert.rejects(() => resolveWorkflowHub({ discoveryDir: dir, autohub: false }), /npm run hub.*workflow-hub/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorkflowHub removes an obsolete discovery file and fails closed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const discoveryPath = resolveHubDiscoveryPath(dir);
  mkdirSync(dirname(discoveryPath), { recursive: true });
  writeFileSync(discoveryPath, JSON.stringify({ hubId: "stale", endpoint: "http://127.0.0.1:1", token: "0".repeat(64) }));

  await assert.rejects(() => resolveWorkflowHub({ discoveryDir: dir, autohub: false }), /npm run hub.*workflow-hub/);
  assert.equal(existsSync(discoveryPath), false);
});

test("resolveHubSpawnCandidates prefers workflow-hub on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  try {
    const file = join(dir, "workflow-hub");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
    const candidates = resolveHubSpawnCandidates({ PATH: dir });
    assert.equal(candidates[0]!.cmd, file);
    assert.deepEqual(candidates[0]!.args, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHubSpawnCandidates falls back to pkgRoot dist hub", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  try {
    mkdirSync(join(dir, "dist", "cli"), { recursive: true });
    writeFileSync(join(dir, "dist", "cli", "hub.js"), "");
    const candidates = resolveHubSpawnCandidates({ PATH: "" }, dir);
    assert.ok(candidates.some((c) => c.cmd === process.execPath && c.args[0] === join(dir, "dist", "cli", "hub.js")));
    assert.equal(candidates.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function restoreEnv(t: import("node:test").TestContext, key: string, original: string | undefined) {
  t.after(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  });
}

test("resolveWorkflowHub auto-spawns a detached hub and returns it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "test", "fixtures", "autohub-fake-hub.mjs");
  const children: ChildProcess[] = [];
  const original = process.env.FAKE_HUB_DISCOVERY_PATH;
  process.env.FAKE_HUB_DISCOVERY_PATH = resolveHubDiscoveryPath(dir);
  t.after(() => {
    for (const child of children) child.kill("SIGTERM");
  });
  restoreEnv(t, "FAKE_HUB_DISCOVERY_PATH", original);

  const resolved = await resolveWorkflowHub({
    discoveryDir: dir,
    spawnFn: (cmd, args, options) => {
      const child = spawn(cmd, args, options);
      children.push(child);
      return child;
    },
    spawnCandidates: [{ cmd: process.execPath, args: [fixture] }],
  });
  assert.equal(typeof resolved.url, "string");
  const discovery = readHubDiscovery(resolveHubDiscoveryPath(dir));
  assert.equal(discovery?.hubId, "fake-hub");
});

test("resolveWorkflowHub waits for another surface's spawn instead of double-spawning", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "test", "fixtures", "autohub-fake-hub.mjs");
  const discoveryPath = resolveHubDiscoveryPath(dir);
  mkdirSync(dirname(discoveryPath), { recursive: true });
  writeFileSync(`${discoveryPath}.spawn.lock`, "locked");
  const originalDiscovery = process.env.FAKE_HUB_DISCOVERY_PATH;
  const originalDelay = process.env.FAKE_HUB_DELAY_MS;
  process.env.FAKE_HUB_DISCOVERY_PATH = discoveryPath;
  process.env.FAKE_HUB_DELAY_MS = "800";
  const otherSurface = spawn(process.execPath, [fixture], { detached: true, stdio: "ignore" });
  t.after(() => {
    otherSurface.kill("SIGTERM");
    rmSync(`${discoveryPath}.spawn.lock`, { force: true });
  });
  restoreEnv(t, "FAKE_HUB_DISCOVERY_PATH", originalDiscovery);
  restoreEnv(t, "FAKE_HUB_DELAY_MS", originalDelay);

  const resolved = await resolveWorkflowHub({
    discoveryDir: dir,
    spawnFn: () => { throw new Error("must not spawn"); },
    spawnCandidates: [{ cmd: "x", args: [] }],
    timeoutMs: 10_000,
  });
  assert.equal(typeof resolved.url, "string");
});

test("resolveWorkflowHub fails closed when spawn candidates are empty", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => resolveWorkflowHub({ discoveryDir: dir, spawnCandidates: [] }),
    /npm run hub.*workflow-hub/,
  );
});

test("resolveWorkflowHub removes its spawn lock after a failed spawn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = `${resolveHubDiscoveryPath(dir)}.spawn.lock`;

  await assert.rejects(
    () => resolveWorkflowHub({ discoveryDir: dir, spawnCandidates: [{ cmd: "nonexistent-cmd-xyz", args: [] }], timeoutMs: 2_000 }),
  );
  assert.equal(existsSync(lockPath), false);
});

test("resolveWorkflowHub steals a stale spawn lock and retries once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "test", "fixtures", "autohub-fake-hub.mjs");
  const discoveryPath = resolveHubDiscoveryPath(dir);
  const lockPath = `${discoveryPath}.spawn.lock`;
  mkdirSync(dirname(discoveryPath), { recursive: true });
  writeFileSync(lockPath, "stale");
  const old = new Date(Date.now() - 20_000);
  utimesSync(lockPath, old, old);
  const original = process.env.FAKE_HUB_DISCOVERY_PATH;
  process.env.FAKE_HUB_DISCOVERY_PATH = discoveryPath;
  const children: ChildProcess[] = [];
  t.after(() => {
    for (const child of children) child.kill("SIGTERM");
    if (original === undefined) delete process.env.FAKE_HUB_DISCOVERY_PATH;
    else process.env.FAKE_HUB_DISCOVERY_PATH = original;
  });

  const resolved = await resolveWorkflowHub({
    discoveryDir: dir,
    spawnFn: (cmd, args, options) => {
      const child = spawn(cmd, args, options);
      children.push(child);
      return child;
    },
    spawnCandidates: [{ cmd: process.execPath, args: [fixture] }],
    timeoutMs: 10_000,
  });
  assert.equal(typeof resolved.url, "string");
});

test("WORKFLOW_AUTOHUB=0 restores strict fail-fast without spawning", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = process.env.WORKFLOW_AUTOHUB;
  process.env.WORKFLOW_AUTOHUB = "0";
  restoreEnv(t, "WORKFLOW_AUTOHUB", original);

  await assert.rejects(
    () => resolveWorkflowHub({
      discoveryDir: dir,
      spawnFn: () => { throw new Error("must not spawn"); },
      spawnCandidates: [{ cmd: "x", args: [] }],
    }),
    /npm run hub.*workflow-hub/,
  );
});
