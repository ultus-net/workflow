import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readHubDiscovery, resolveWorkflowHub, terminateOwnedHub } from "../src/cli/hub-client.js";
import { resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";

/**
 * W044 resource hygiene: the launcher that auto-spawns a hub OWNS it. The
 * spawned-process count must return to baseline after session exit — no
 * orphaned ~300MB daemons accumulate per launch. Reuse of a probed hub must
 * never hand out a kill switch for someone else's daemon.
 */

function fixture(): string {
  return join(process.cwd(), "test", "fixtures", "autohub-fake-hub.mjs");
}

function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(predicate(), message);
}

test("an auto-spawned hub is owned: terminateOwnedHub reaps it and the process count returns to baseline", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-reap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const discoveryPath = resolveHubDiscoveryPath(dir);
  const original = process.env.FAKE_HUB_DISCOVERY_PATH;
  process.env.FAKE_HUB_DISCOVERY_PATH = discoveryPath;
  t.after(() => {
    if (original === undefined) delete process.env.FAKE_HUB_DISCOVERY_PATH;
    else process.env.FAKE_HUB_DISCOVERY_PATH = original;
  });

  let spawned: ChildProcess | undefined;
  const resolved = await resolveWorkflowHub({
    discoveryDir: dir,
    spawnFn: (cmd, args, options) => spawn(cmd, args, options),
    spawnCandidates: [{ cmd: process.execPath, args: [fixture()] }],
    onSpawned: (child) => { spawned = child; },
  });
  assert.equal(typeof resolved.url, "string");
  assert.ok(spawned !== undefined, "the spawn must hand the owned child to the launcher");
  const pid = spawned!.pid;
  assert.ok(pidAlive(pid), "the spawned hub daemon is running");

  // Session exit: the launcher terminates what it spawned.
  terminateOwnedHub(spawned);
  await waitFor(() => !pidAlive(pid), "the owned hub must exit after termination");
  assert.equal(spawned!.exitCode, 0, "the fixture hub exits cleanly on SIGTERM");
  // Baseline restored: no spawned process survives the session.
  assert.equal(pidAlive(pid), false, "spawned-process count is back to baseline");

  // Idempotence: terminating an already-exited child is a no-op.
  terminateOwnedHub(spawned);
  terminateOwnedHub(undefined);
});

test("reuse never owns: a probed hub is not handed out for termination", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-reuse-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const discoveryPath = resolveHubDiscoveryPath(dir);
  const original = process.env.FAKE_HUB_DISCOVERY_PATH;
  process.env.FAKE_HUB_DISCOVERY_PATH = discoveryPath;
  t.after(() => {
    if (original === undefined) delete process.env.FAKE_HUB_DISCOVERY_PATH;
    else process.env.FAKE_HUB_DISCOVERY_PATH = original;
  });

  // Surface A spawns and owns.
  let owned: ChildProcess | undefined;
  const first = await resolveWorkflowHub({
    discoveryDir: dir,
    spawnFn: (cmd, args, options) => spawn(cmd, args, options),
    spawnCandidates: [{ cmd: process.execPath, args: [fixture()] }],
    onSpawned: (child) => { owned = child; },
  });
  assert.ok(owned !== undefined);

  // Surface B reuses the live hub — it must NOT receive a kill handle.
  let reuseSpawned = false;
  const second = await resolveWorkflowHub({
    discoveryDir: dir,
    spawnFn: () => {
      reuseSpawned = true;
      throw new Error("reuse must never spawn");
    },
    onSpawned: () => { reuseSpawned = true; },
  });
  assert.equal(second.url, first.url);
  assert.equal(reuseSpawned, false, "a reused hub is not re-spawned and not handed out");
  const discovery = readHubDiscovery(discoveryPath);
  assert.equal(discovery?.hubId, "fake-hub");
  assert.ok(pidAlive(owned!.pid), "the reused hub keeps running until its owner exits");
  t.after(() => terminateOwnedHub(owned));
});
