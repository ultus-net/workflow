import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { guardDistIsStale } from "../src/integrations/mcp-toolbox-guard.js";
import { ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

// W126 — the per-bin compiled smoke: W125 gave the suite its first compiled
// executions (the `workflow` dispatcher + doctor, and the real dist webapp
// bundle); the OTHER NINE bins still had zero compiled execution — the
// operator's manual runs were the only runners. This file executes each
// compiled bin end-to-end through a per-bin SAFE probe:
//   - no agent or daemon outlives the probe: the long-running surfaces
//     (web, hub, admin, monitor) are started, their startup banner is
//     observed, then they are SIGTERM'd and the TEARDOWN is pinned (the
//     honest exit each surface's own handler produces — an async spawn
//     with a controlled kill, not spawnSync's timeout kill, whose
//     ETIMEDOUT reporting cannot see a clean teardown);
//   - every homedir write lands under a redirected HOME (a fresh tmp dir
//     per bin) — no operator state is touched;
//   - no browser opens (web runs with --no-browser and the stock-tab probe
//     suppressed), no PTY is ever allocated, and no agent process is ever
//     spawned: the TUI probe fails at the driver-name seam BEFORE any
//     driver composition, the server probe fails at argument parsing
//     BEFORE the guard or the OpenCode runtime, and the attach probe fails
//     at discovery resolution (--no-autostart) BEFORE any client spawn;
//   - the monitor never auto-spawns a hub (WORKFLOW_AUTOHUB=0; a spawn
//     would orphan the hub when the parent is killed) and its metering
//     proxy's upstream key is satisfied by a dummy env value (the seam is
//     presence-checked only — upstream-key.ts — no provider call happens
//     without a session, which the probe never starts).
// Every honest outcome is pinned from the source (exit codes and output
// markers named per bin), not generic "it ran" claims. The `workflow`
// dispatcher + doctor is W125's smoke and is not re-covered here.

/** The compiled entry per bin (package.json's bin map). */
const ENTRIES: Readonly<Record<string, string>> = {
  "workflow-web": "dist/cli/web-launch.js",
  "workflow-tui": "dist/cli/universal-tui.js",
  "workflow-hub": "dist/cli/hub.js",
  "workflow-admin": "dist/cli/admin.js",
  "workflow-monitor": "dist/cli/ink-tui.js",
  "workflow-shell": "dist/cli/contained-shell.js",
  "workflow-opencode": "dist/cli/opencode-attach.js",
  "workflow-opencode-server": "dist/cli/opencode-server.js",
  "workflow-rsi": "dist/cli/rsi.js",
};

interface ShortProbe {
  readonly kind: "short";
  readonly bin: string;
  readonly title: string;
  readonly argv: readonly string[];
  /** Env additions on top of the inherited environment ("<home>" expands to
   * the probe's redirected HOME). */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stdoutIncludes?: readonly string[];
  readonly stderrIncludes?: readonly string[];
  readonly exitStatuses: readonly number[];
}

interface DaemonProbe {
  readonly kind: "daemon";
  readonly bin: string;
  readonly title: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** stdout marker whose appearance proves the surface started; the SIGTERM
   * kill follows it. */
  readonly banner?: string;
  readonly extraBanners?: readonly string[];
  readonly bannerTimeoutMs: number;
  /** The exit the surface's own SIGTERM handler produces. */
  readonly expectedExit: number;
}

const SHORT_PROBES: readonly ShortProbe[] = [
  {
    kind: "short",
    bin: "workflow-monitor",
    title: "boots through its standalone composition and fails honestly at ink's raw-mode boundary in a non-TTY seat",
    // The monitor's compiled sweep found a REAL defect first: the standalone
    // fallback crashed on first render with "no active workflow task
    // selected" (the mode bar installs its gate on mount; the standalone
    // seed was never activated) — fixed in this loop. What REMAINS in a
    // non-TTY seat is ink's own honest limit (its use-input hook requires
    // raw mode), which is the environment truth this pin names — a TUI
    // surface cannot render headless, and exiting with the ink error is the
    // honest terminal state, not a compiled-tree crash.
    argv: [],
    env: { HOME: "<home>", WORKFLOW_AUTOHUB: "0", WORKFLOW_UPSTREAM_KEY: "w126-smoke-dummy" },
    timeoutMs: 20_000,
    stdoutIncludes: ["Raw mode is not supported"],
    exitStatuses: [1],
  },
  {
    kind: "short",
    bin: "workflow-tui",
    title: "refuses an unknown driver at the composition seam (before any driver spawn)",
    argv: ["--driver", "bogus"],
    timeoutMs: 15_000,
    stderrIncludes: ["unknown driver 'bogus'"],
    exitStatuses: [1],
  },
  {
    kind: "short",
    bin: "workflow-shell",
    title: "boots the contained-shell banner and exits cleanly on stdin EOF",
    argv: [],
    env: { HOME: "<home>" },
    timeoutMs: 20_000,
    stdoutIncludes: ["Writable workspace:", "Network: isolated | Credentials: cleared"],
    exitStatuses: [0],
  },
  {
    kind: "short",
    bin: "workflow-opencode",
    title: "fails closed with the actionable remedy when no server discovery exists (--no-autostart)",
    argv: ["--no-autostart"],
    env: { WORKFLOW_OPENCODE_SERVER_HOME: "<home>/opencode-server" },
    timeoutMs: 15_000,
    stderrIncludes: ["Workflow OpenCode server is unavailable"],
    exitStatuses: [1],
  },
  {
    kind: "short",
    bin: "workflow-opencode-server",
    title: "rejects unknown arguments before any guard or OpenCode runtime composition",
    argv: ["--bogus"],
    timeoutMs: 15_000,
    stderrIncludes: ["unknown argument: --bogus"],
    exitStatuses: [1],
  },
  {
    kind: "short",
    bin: "workflow-rsi",
    title: "prints its usage for the help verb",
    argv: ["help"],
    timeoutMs: 15_000,
    stdoutIncludes: ["usage: workflow-rsi"],
    exitStatuses: [0],
  },
];

const DAEMON_PROBES: readonly DaemonProbe[] = [
  {
    kind: "daemon",
    bin: "workflow-web",
    title: "starts the browser operator UI headlessly and tears it down on SIGTERM",
    argv: ["--no-browser", "--port", "0"],
    env: {
      HOME: "<home>",
      WORKFLOW_HUB_DIR: "<home>",
      WORKFLOW_OPENCODE_SERVER_HOME: "<home>/opencode-server",
      WORKFLOW_OPENCODE_STOCK_TAB: "0",
    },
    banner: "Workflow browser UI:",
    extraBanners: ["Browser open suppressed"],
    bannerTimeoutMs: 20_000,
    expectedExit: 0,
  },
  {
    kind: "daemon",
    bin: "workflow-hub",
    title: "starts the authority daemon (listening banner + discovery file) and tears it down on SIGTERM",
    argv: [],
    env: {
      HOME: "<home>",
      WORKFLOW_HUB_PROVENANCE: "<home>/provenance.jsonl",
      WORKFLOW_HUB_SCHEDULES: "<home>/schedules.json",
      WORKFLOW_RSI_AGENT: "0",
    },
    banner: "Workflow hub listening at",
    extraBanners: ["Discovery file:"],
    bannerTimeoutMs: 30_000,
    expectedExit: 0,
  },
  {
    kind: "daemon",
    bin: "workflow-admin",
    title: "starts the credential control plane on an ephemeral port and tears it down on SIGTERM",
    argv: [],
    env: { HOME: "<home>", WORKFLOW_ADMIN_PORT: "0" },
    banner: "Workflow admin listening at http://127.0.0.1:",
    extraBanners: ["Admin capability: "],
    bannerTimeoutMs: 20_000,
    expectedExit: 0,
  },
];

/** The vendored guard seat: the hub composes it fail-closed at startup, so
 * the hub probe needs it built and fresh (the W120 gate's own remedy). */
function ensureToolboxGuardBuilt(): void {
  const serverPath = resolve(repoRoot, "mcp-toolbox", "apps", "workflow-guard-mcp", "dist", "server.js");
  if (existsSync(serverPath) && !guardDistIsStale(repoRoot)) return;
  execFileSync("pnpm", ["--dir", "mcp-toolbox", "--filter", "workflow-guard-mcp", "run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

interface DaemonRun {
  readonly output: string;
  readonly bannerSeen: boolean;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
}

/** Starts the compiled bin, waits for its startup banner (or an early exit —
 * which is the honest failure), then SIGTERMs it and pins the teardown exit. */
async function probeDaemon(
  entry: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  banner: string | undefined,
  bannerTimeoutMs: number,
): Promise<DaemonRun> {
  let output = "";
  let exitInfo: { code: number | null; signal: string | null } | undefined;
  const child = spawn(process.execPath, [entry, ...argv], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.once("exit", (code, signal) => { exitInfo = { code, signal }; });
  const deadline = Date.now() + bannerTimeoutMs;
  while (
    exitInfo === undefined &&
    (banner === undefined || !output.includes(banner)) &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  }
  const bannerSeen = banner === undefined || output.includes(banner);
  if (exitInfo === undefined) {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
    exitInfo = await new Promise((resolveExit) => {
      const hardKill = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }, 15_000);
      child.once("exit", (code, signal) => {
        clearTimeout(hardKill);
        resolveExit({ code, signal });
      });
    });
  }
  return { output, bannerSeen, exitCode: exitInfo?.code ?? null, exitSignal: exitInfo?.signal ?? null };
}

function assertShortHonest(
  probe: ShortProbe,
  result: SpawnSyncReturns<string>,
): void {
  assert.equal(
    result.error,
    undefined,
    `${probe.bin} spawned cleanly (${result.error?.message ?? "no spawn error"})`,
  );
  assert.equal(
    result.signal,
    null,
    `${probe.bin}: killed by ${result.signal} — a bounded probe must exit, not be killed`,
  );
  assert.ok(
    result.status !== null && probe.exitStatuses.includes(result.status),
    `${probe.bin}: exit ${result.status} — the pin's honest exits are ${JSON.stringify(probe.exitStatuses)}; anything else is a compiled-runtime crash. stdout: ${result.stdout.slice(0, 400)} stderr: ${result.stderr.slice(0, 400)}`,
  );
  for (const marker of probe.stdoutIncludes ?? []) {
    assert.ok(result.stdout.includes(marker), `${probe.bin}: stdout carries "${marker}" — stdout: ${result.stdout.slice(0, 400)}`);
  }
  for (const marker of probe.stderrIncludes ?? []) {
    assert.ok(result.stderr.includes(marker), `${probe.bin}: stderr carries "${marker}" — stderr: ${result.stderr.slice(0, 400)}`);
  }
}

for (const probe of SHORT_PROBES) {
  test(`W126: the compiled ${probe.bin} bin runs end-to-end — ${probe.title}`, (context) => {
    const entry = ENTRIES[probe.bin];
    assert.ok(entry !== undefined, `no compiled entry recorded for ${probe.bin}`);
    ensureFresh(resolve(repoRoot, entry));
    const home = redirectedHome(context);
    const env = expandedEnv(probe.env, home);
    const result = spawnSync(process.execPath, [entry, ...probe.argv], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: probe.timeoutMs,
      env: { ...process.env, ...env },
    });
    assertShortHonest(probe, result);
  });
}

for (const probe of DAEMON_PROBES) {
  test(`W126: the compiled ${probe.bin} bin runs end-to-end — ${probe.title}`, async (context) => {
    const entry = ENTRIES[probe.bin];
    assert.ok(entry !== undefined, `no compiled entry recorded for ${probe.bin}`);
    ensureFresh(resolve(repoRoot, entry));
    if (probe.bin === "workflow-hub") ensureToolboxGuardBuilt();
    const home = redirectedHome(context);
    const env = expandedEnv(probe.env, home);
    const run = await probeDaemon(entry, probe.argv, env, probe.banner, probe.bannerTimeoutMs);
    assert.ok(
      run.bannerSeen,
      `${probe.bin}: the startup banner never appeared within ${probe.bannerTimeoutMs}ms — output: ${run.output.slice(0, 600)}`,
    );
    for (const marker of probe.extraBanners ?? []) {
      assert.ok(run.output.includes(marker), `${probe.bin}: output carries "${marker}" — output: ${run.output.slice(0, 600)}`);
    }
    assert.equal(
      run.exitSignal,
      null,
      `${probe.bin}: died by ${run.exitSignal} instead of its own SIGTERM teardown — output: ${run.output.slice(0, 600)}`,
    );
    assert.equal(
      run.exitCode,
      probe.expectedExit,
      `${probe.bin}: after SIGTERM the teardown handler should exit ${probe.expectedExit} — output: ${run.output.slice(0, 600)}`,
    );
  });
}

function redirectedHome(context: test.TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "w126-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function expandedEnv(
  additions: Readonly<Record<string, string>> | undefined,
  home: string,
): Record<string, string> {
  const env: Record<string, string> = { HOME: home };
  for (const [key, value] of Object.entries(additions ?? {})) {
    env[key] = value === "<home>" ? home : value.replaceAll("<home>", home);
  }
  return env;
}