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
//
// W129 adds the help contract (the sweep's own discovered-and-queued
// defect, closed as a class): every bin resolves --help/-h to usage + exit 0
// BEFORE any composition. The pre-fix behavior this names: opencode-server
// started its guard + runtime, opencode-attach's autostart path could start
// the daemon, universal-tui composed the AGENT driver, the module-level
// daemons (hub/admin) started on any argv (admin --help even printed a
// freshly generated token), and the web service started serving. The
// reference pattern is acp-remote.ts's (parse -> help -> print -> return).
// The IN-PROCESS dispatcher verbs are the subtle case (the round-1 review's
// P1): an in-process call BYPASSES a script-entry guard, so web's guard lives
// inside runWebLaunch (shared by both entries) and settings/doctor/install
// guard in their dispatch branches.

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
 * the hub probe needs it built and fresh (the W120 gate's own remedy — which
 * requires `pnpm` on PATH and the toolbox's node_modules installed, the same
 * precondition the W120 guard test carries; documented here so a bare
 * checkout's failure names the remedy instead of a raw ENOENT). */
function ensureToolboxGuardBuilt(): void {
  const serverPath = resolve(repoRoot, "mcp-toolbox", "apps", "workflow-guard-mcp", "dist", "server.js");
  if (existsSync(serverPath) && !guardDistIsStale(repoRoot)) return;
  try {
    execFileSync("pnpm", ["--dir", "mcp-toolbox", "--filter", "workflow-guard-mcp", "run", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch (error) {
    throw new Error(
      `the hub probe composes the vendored workflow-guard-mcp seat fail-closed, and its self-healing build failed — run "npm run toolbox:install && npm run toolbox:build" once (pnpm required): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
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
    detached: true,
  });
  // The child leads its own process group (detached), so the kill reaches
  // every grandchild it spawned — the hub composes a guard MCP child, and a
  // broken-teardown scenario (the exact failure this probe exists to catch)
  // must not orphan it (the round-3 review's P3; the kill-group pattern is
  // src/cli/opencode-attach.ts's terminateProcessGroup).
  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* already exited */
    }
  };
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
    killTree("SIGTERM");
    exitInfo = await new Promise((resolveExit) => {
      const hardKill = setTimeout(() => {
        killTree("SIGKILL");
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

// W129 — the help contract per bin: --help/-h prints usage and exits 0 BEFORE
// any composition (see the header's W129 note for the pre-fix class). Every
// row runs BOTH flags; rows also cover the dispatcher's IN-PROCESS verb paths
// (web/settings/doctor/install — the round-1 review's P1/P2: an in-process
// call BYPASSES a script-entry guard, so web's guard lives inside
// runWebLaunch and the other in-process verbs guard in their branches) and
// rsi's non-leading --help (`status --help` must resolve, not fall through to
// hub resolution). Help exits by itself and touches neither state nor the
// network, so spawnSync is safe here without a redirected HOME.
interface HelpProbe {
  readonly bin: string;
  readonly entry: string;
  /** Defaults to ["--help"]; rows may pin verb-level paths. */
  readonly argv?: readonly string[];
  readonly stdoutIncludes: readonly string[];
}

const HELP_PROBES: readonly HelpProbe[] = [
  { bin: "workflow (dispatcher, leading)", entry: "dist/cli/workflow.js", stdoutIncludes: ["workflow — one hub"] },
  { bin: "workflow web (dispatcher verb, in-process)", entry: "dist/cli/workflow.js", argv: ["web", "--help"], stdoutIncludes: ["workflow-web — the browser operator UI"] },
  { bin: "workflow settings (dispatcher verb, in-process)", entry: "dist/cli/workflow.js", argv: ["settings", "--help"], stdoutIncludes: ["workflow settings — the settings panel only"] },
  { bin: "workflow doctor (dispatcher verb, in-process)", entry: "dist/cli/workflow.js", argv: ["doctor", "--help"], stdoutIncludes: ["workflow doctor — state the local setup honestly"] },
  { bin: "workflow install (dispatcher verb, in-process)", entry: "dist/cli/workflow.js", argv: ["install", "--help"], stdoutIncludes: ["workflow install fleet —"] },
  { bin: "workflow-web", entry: "dist/cli/web-launch.js", stdoutIncludes: ["workflow-web — the browser operator UI"] },
  { bin: "workflow-tui", entry: "dist/cli/universal-tui.js", stdoutIncludes: ["workflow-tui — the Workflow TUI"] },
  { bin: "workflow-hub", entry: "dist/cli/hub.js", stdoutIncludes: ["workflow-hub — the Workflow authority daemon"] },
  { bin: "workflow-admin", entry: "dist/cli/admin.js", stdoutIncludes: ["workflow-admin — the credential custody control plane"] },
  { bin: "workflow-monitor", entry: "dist/cli/ink-tui.js", stdoutIncludes: ["workflow-monitor — the Workflow monitoring TUI"] },
  { bin: "workflow-shell", entry: "dist/cli/contained-shell.js", stdoutIncludes: ["workflow-shell — the interactive contained-shell smoke"] },
  { bin: "workflow-opencode", entry: "dist/cli/opencode-attach.js", stdoutIncludes: ["workflow-opencode — attach the stock OpenCode client"] },
  { bin: "workflow-opencode-server", entry: "dist/cli/opencode-server.js", stdoutIncludes: ["workflow-opencode-server — the Workflow-owned OpenCode server daemon"] },
  { bin: "workflow-rsi", entry: "dist/cli/rsi.js", stdoutIncludes: ["usage: workflow-rsi"] },
  { bin: "workflow-rsi (help anywhere)", entry: "dist/cli/rsi.js", argv: ["status", "--help"], stdoutIncludes: ["usage: workflow-rsi"] },
];

for (const probe of HELP_PROBES) {
  test(`W129: the compiled ${probe.bin} resolves --help/-h to usage and exits 0 before any composition`, () => {
    ensureFresh(resolve(repoRoot, probe.entry));
    const baseArgv = probe.argv ?? ["--help"];
    for (const flag of ["--help", "-h"] as const) {
      const argv = baseArgv.map((argument) => (argument === "--help" ? flag : argument));
      const result = spawnSync(process.execPath, [probe.entry, ...argv], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 15_000,
      });
      const label = `${probe.bin} [${argv.join(" ")}]`;
      assert.equal(result.error, undefined, `${label}: spawned cleanly (${result.error?.message ?? "no spawn error"})`);
      assert.equal(result.signal, null, `${label}: exits by itself, not killed by ${result.signal}`);
      assert.equal(result.status, 0, `${label}: exits 0 — stdout: ${result.stdout.slice(0, 300)} stderr: ${result.stderr.slice(0, 300)}`);
      for (const marker of probe.stdoutIncludes) {
        assert.ok(result.stdout.includes(marker), `${label}: stdout carries "${marker}" — stdout: ${result.stdout.slice(0, 300)}`);
      }
      assert.equal(result.stderr.trim(), "", `${label}: writes no error output — stderr: ${result.stderr.slice(0, 300)}`);
    }
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