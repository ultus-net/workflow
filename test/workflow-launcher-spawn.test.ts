import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";

/**
 * Live lifecycle pin for the `workflow` launcher's spawned surfaces
 * (spawnSurface in src/cli/workflow.ts, exercised through the `hub` verb):
 * the launcher parent must stay alive for the child's lifetime (no
 * `Error: unreachable` crash trace) and must forward SIGTERM so the surface
 * never outlives its parent.
 */

test("the launcher parent stays alive and tears the hub down on SIGTERM", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "wf-launcher-spawn-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const parent = spawn(process.execPath, ["--import", "tsx", "src/cli/workflow.ts", "hub"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  parent.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  parent.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  t.after(() => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
  });

  // The hub child publishes discovery under the temp HOME once it is serving.
  const discoveryPath = resolveHubDiscoveryPath(join(home, ".workflow"));
  const deadline = Date.now() + 20_000;
  while (!existsSync(discoveryPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(discoveryPath), `hub never published discovery; captured output: ${output}`);

  // Regression pin: the launcher parent used to crash immediately with an
  // `Error: unreachable` stack trace after spawning the child.
  assert.ok(!output.includes("unreachable"), `launcher crash trace leaked: ${output}`);

  // Capture the endpoint before teardown: the hub unlinks its discovery file
  // on clean shutdown, so it must be read while the surface is still serving.
  const discovery = JSON.parse(readFileSync(discoveryPath, "utf8")) as { endpoint: string };

  // SIGTERM the PARENT: it must forward to the hub child and both must exit.
  // Exit code 0 pins "the parent tracked the child's clean exit"; the
  // process-group test below adds the stronger cleanup-completed observable.
  parent.kill("SIGTERM");
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    parent.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(outcome.code, 0, `launcher exit ${outcome.code}/${outcome.signal}; captured output: ${output}`);

  // No orphaned surface: the hub endpoint stops answering after the parent exits.
  await assert.rejects(() => fetch(`${discovery.endpoint}/snapshot`, { method: "POST" }));
});

test("a process-group SIGTERM lets the hub finish cleaning up (no teardown abort)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "wf-launcher-group-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const parent = spawn(process.execPath, ["--import", "tsx", "src/cli/workflow.ts", "hub"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group — signal the GROUP like a terminal/systemd would
  });
  let output = "";
  parent.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  parent.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  t.after(() => {
    if (parent.exitCode === null && parent.signalCode === null && parent.pid !== undefined) {
      try {
        process.kill(-parent.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  const discoveryPath = resolveHubDiscoveryPath(join(home, ".workflow"));
  const deadline = Date.now() + 20_000;
  while (!existsSync(discoveryPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(discoveryPath), `hub never published discovery; captured output: ${output}`);

  // Group delivery (the terminal Ctrl+C / systemd KillMode=control-group
  // shape): the launcher AND the hub child each receive the signal directly,
  // and the launcher forwards a second copy to the child. The hub's shutdown
  // must be idempotent enough that cleanup still runs to completion — the
  // observable is the discovery file being unlinked by hub.close().
  assert.ok(parent.pid !== undefined);
  process.kill(-parent.pid, "SIGTERM");
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    parent.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(outcome.code, 0, `launcher exit ${outcome.code}/${outcome.signal}; captured output: ${output}`);

  const cleanupDeadline = Date.now() + 5_000;
  while (existsSync(discoveryPath) && Date.now() < cleanupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(!existsSync(discoveryPath), `hub teardown aborted mid-close (discovery not unlinked); captured output: ${output}`);
});
