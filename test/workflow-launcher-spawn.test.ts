import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { opencodeServerDiscoveryPath, writeOpencodeServerDiscovery } from "../src/integrations/opencode-server-discovery.js";
import { resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";

/**
 * Live lifecycle pin for the `workflow` launcher's spawned surfaces
 * (spawnSurface in src/cli/workflow.ts, exercised through the `hub` verb):
 * the launcher parent must stay alive for the child's lifetime (no
 * `Error: unreachable` crash trace), must forward SIGTERM and SIGHUP so the
 * surface never outlives its parent, and the `tui` surface must tear its
 * detached client down on every lifecycle signal (the LESS-0002 SIGHUP
 * residual).
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

/**
 * SIGHUP regression pins for the `tui` surface (the LESS-0002 residual):
 * closing the terminal (or a supervisor signalling only the launcher)
 * previously killed the launcher and the attach child by default action,
 * leaving the detached `opencode attach` client orphaned in its own process
 * group. The stub client below behaves like the real client (no signal
 * handlers of its own, dies with its group on SIGTERM) and records its pid
 * so the orphan assertion is discriminating: only the attach surface's
 * teardown can kill it.
 */

async function stubGateway(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: "1.18.31" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** Executable stub standing in for the real `opencode attach` client: records its pid, then idles forever. */
function stubClientScript(home: string): string {
  const path = join(home, "stub-opencode.cjs");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid));",
      "setInterval(() => {}, 1 << 30);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

async function readPidFile(path: string, deadlineMs: number): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // the stub client has not written its pid yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`stub client never wrote its pid to ${path}`);
}

/** Fails while the pid can still be signalled — zombies are not "gone". */
async function assertGone(pid: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    if (Date.now() >= deadline) throw new Error(`stub client ${pid} is still alive after teardown (orphaned)`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface StubHarness {
  readonly parent: ReturnType<typeof spawn>;
  readonly stubPid: Promise<number>;
  output(): string;
  killStubGroup(): void;
  close(): Promise<void>;
}

/** Spawns `workflow tui --dir <ws>` against a pre-seeded discovery, a stub gateway, and a stub client. */
async function startStubHarness(home: string, options: { detached: boolean }): Promise<StubHarness> {
  const gateway = await stubGateway();
  const workspace = join(home, "ws");
  const stateHome = join(home, "state");
  writeOpencodeServerDiscovery(opencodeServerDiscoveryPath(stateHome, workspace), {
    protocol: 1,
    pid: 1,
    workspace,
    gatewayUrl: gateway.url,
    tuiUsername: "opencode",
    tuiPassword: "stub",
  });
  const pidFile = join(home, "stub.pid");
  const stub = stubClientScript(home);
  const parent = spawn(process.execPath, ["--import", "tsx", "src/cli/workflow.ts", "tui", "--dir", workspace], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WORKFLOW_OPENCODE_BIN: stub,
      WORKFLOW_OPENCODE_SERVER_HOME: stateHome,
      STUB_PID_FILE: pidFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.detached ? { detached: true } : {}),
  });
  let output = "";
  parent.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  parent.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  let stubPid = 0;
  return {
    parent,
    stubPid: readPidFile(pidFile, 20_000).then((pid) => {
      stubPid = pid;
      return pid;
    }),
    output: () => output,
    killStubGroup: () => {
      if (stubPid > 0) {
        try {
          process.kill(-stubPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    },
    close: () => gateway.close().catch(() => undefined),
  };
}

test("a parent-targeted SIGHUP is forwarded: the tui surface never outlives its parent and no client is orphaned", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "wf-launcher-hup-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const harness = await startStubHarness(home, { detached: false });
  const stubPid = await harness.stubPid;
  t.after(async () => {
    harness.killStubGroup();
    await harness.close();
  });

  // Sanity: the stub client is really running before the signal.
  process.kill(stubPid, 0);

  // Parent-targeted SIGHUP (a supervisor signalling only the launcher): the
  // launcher must forward it so the attach surface tears the detached client
  // group down instead of outliving the launcher (LESS-0002 residual).
  harness.parent.kill("SIGHUP");
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    harness.parent.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(outcome.code, 0, `launcher exit ${outcome.code}/${outcome.signal}; captured output: ${harness.output()}`);

  // No orphaned client: the stub group is gone after the teardown.
  await assertGone(stubPid, 5_000);
});

test("a process-group SIGHUP (terminal close) tears the tui surface down with no orphaned client", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "wf-launcher-group-hup-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const harness = await startStubHarness(home, { detached: true }); // own process group — signal the GROUP like a terminal would
  const stubPid = await harness.stubPid;
  t.after(async () => {
    harness.killStubGroup();
    await harness.close();
  });
  t.after(() => {
    if (harness.parent.exitCode === null && harness.parent.signalCode === null && harness.parent.pid !== undefined) {
      try {
        process.kill(-harness.parent.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  // Sanity: the stub client is really running before the signal.
  process.kill(stubPid, 0);

  // Group delivery (the terminal-close shape): the launcher AND the attach
  // child each receive SIGHUP directly, and the launcher forwards a second
  // copy. The attach surface's idempotent teardown must still kill the
  // detached client group — the discriminating observable is the stub dying.
  assert.ok(harness.parent.pid !== undefined);
  process.kill(-harness.parent.pid, "SIGHUP");
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    harness.parent.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(outcome.code, 0, `launcher exit ${outcome.code}/${outcome.signal}; captured output: ${harness.output()}`);

  // No orphaned client: the stub group is gone after the teardown.
  await assertGone(stubPid, 5_000);
});

test("a process-group SIGHUP lets the hub finish cleaning up (no teardown abort)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "wf-launcher-group-hub-hup-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const parent = spawn(process.execPath, ["--import", "tsx", "src/cli/workflow.ts", "hub"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group — signal the GROUP like a terminal would
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

  // Group delivery (the terminal-close shape): the launcher AND the hub child
  // each receive SIGHUP directly, and the launcher forwards a second copy.
  // The hub's guarded shutdown must run to completion — before the SIGHUP
  // registration the hub died by default action and left the discovery file
  // behind (the LESS-0005 iteration's live repro: stale discovery.json +
  // verifier.json + lock/ after a parent-targeted SIGHUP). The observable is
  // the discovery file being unlinked by hub.close().
  assert.ok(parent.pid !== undefined);
  process.kill(-parent.pid, "SIGHUP");
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
