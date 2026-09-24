import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { distArtifact, ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

// W137 — the SHIPPED postinstall target's EXECUTION (W128's npm-12-gated residual,
// driven directly). package.json wires `postinstall: node scripts/prepare-tool.mjs`
// (the postinstall field) and — since W128's packaged-seat sweep found the file
// shipped NOWHERE — files[] ships scripts/prepare-tool.mjs, with the tarball-shape
// pin in test/e2e-packaged-seat.test.ts enforcing its presence. What was never
// tested is what the hook DOES: npm 12's install-scripts gate skips the package's
// own postinstall during a plain tarball install (the W128 file's honesty claim
// (4)), so this file drives the shipped script DIRECTLY in the packaged shape —
// npm pack, extract to a mkdtemp, then
// `node <extracted>/package/scripts/prepare-tool.mjs` — and pins what it actually
// does, observed first (2026-09-25, node v22.22.3, pnpm 11.5.2 =
// mcp-toolbox/package.json's packageManager pin).
//
// Observed truth (the script is 17 lines): it resolves `root` from its own
// location, spawns exactly one child — `pnpm --dir <root>/mcp-toolbox run build`,
// cwd = root, stdio inherit (mcp-toolbox/package.json's build is
// `pnpm -r --if-present run build`, recursive over the vendored workspace) — and
// swallows EVERY outcome: success logs `prepare: toolbox ok` to stdout; ANY failure
// (nonzero child exit, missing pnpm) logs `prepare: toolbox skipped (<message>)` to
// stderr and the process STILL exits 0. The script itself writes nothing (its
// `existsSync` import is dead). In the packaged seat the extracted mcp-toolbox
// ships pnpm-workspace.yaml + pnpm-lock.yaml + every app manifest but NO
// node_modules (npm pack excludes it), so the step performs a FULL pnpm install +
// build of the vendored toolbox INSIDE the installed tree (observed: ~11 s against
// a cold redirected-HOME pnpm store, ending with the guard seat's
// apps/workflow-guard-mcp/dist/server.js built); `npm_config_verify_deps_before_run=false`
// did NOT suppress that install in the observed runs (pnpm's missing-node_modules
// `run` path installs regardless of that setting), so the packaged lane is
// network/store-dependent and an environment without registry reach lands in the
// `skipped` class instead — BOTH classes exit 0 and BOTH are pinned, never faked.
//
// Honesty claims: (1) exit 0 is the hook's UNCONDITIONAL contract — a failing
// toolbox build can never fail an install; pinned, not blessed (finding (a)
// below). (2) The built/skipped split is environment-dependent and the pin
// accepts exactly one class per run, recording which occurred. (3) The npm-12
// residual stands: this file exercises the hook directly, never through a real
// install's lifecycle (the W128 install-scripts gate). (4) Idempotency is
// OBSERVED (the hook is stateless; a rerun repeats the outcome class and the
// stub seat records two identical invocations), not claimed by the script.
//
// Product findings recorded here, NOT fixed (report-only mandate): (a) the
// postinstall is a heavyweight, network-dependent lifecycle step — a consumer
// who approves install scripts unknowingly installs the toolbox's whole
// dependency tree during `npm install <tarball>`; a gate env (e.g.
// WORKFLOW_PREPARE_TOOL=1) or an honest README note is the polish queue's shape.
// (b) The child pnpm resolves workspaces by walking UP from its cwd: when the
// script's `--dir` target is NOT itself a workspace root (the shipped tree
// always is), pnpm can resolve an ANCESTOR workspace and mutate ITS
// node_modules — observed 2026-09-25: a research run from a repo-adjacent
// scratch tree pruned 135 stale entries from the operator's $HOME-level pnpm
// workspace node_modules (reconciled to that workspace's own lockfile). The
// packaged seat is immune in practice — the extracted mcp-toolbox IS a
// workspace, so pnpm confines itself there (pinned by the built-artifacts land
// inside the extracted tree) — but the escape class is real and recorded.
// (c) scripts/prepare-tool.mjs imports existsSync and never uses it (a dead
// import in a shipped file).
//
// SAFETY CONTRACT (LESS-0051): no agent or PTY spawns; every spawned process is
// a short-lived node/tar/npm/pnpm invocation (or the one-shot stub pnpm below)
// with a generous spawnSync timeout — the script exits by itself even on
// failure, so the timeout-kill is only blind to clean teardown, and there is
// none to observe (residual: a hung pnpm child could survive a parent
// timeout-kill — never observed across the research runs). All scratch state
// lives in mkdtemp trees under os.tmpdir(); the script's run HOME is a
// redirected mkdtemp so pnpm's cache/store/state writes land there, never in
// the operator's ~/.cache or ~/.local; and the script's REPO seat is
// deliberately never run (its child would build into the operator's
// mcp-toolbox) — the repo's toolbox node_modules mtime is snapshot-pinned
// before/after the live packaged runs to prove the escape class stayed closed.

/** Scratch roots to remove when the file's tests are done. */
const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** The live packaged run's outcome class — exactly one is ever observable. */
type PreparedOutcome = { readonly kind: "built" } | { readonly kind: "skipped" };

interface PreparedRun {
  readonly run: SpawnSyncReturns<string>;
  readonly outcome: PreparedOutcome;
}

let tarballCache: string | undefined;

/** Pack the real tarball once (the build freshness gate runs before it). */
function packOnce(): string {
  if (tarballCache !== undefined) return tarballCache;
  // Nothing ships before the compiled tree is fresh — the shared W125 gate
  // runs `npm run build` when dist is missing or older than its input graph.
  ensureFresh(distArtifact("cli", "workflow.js"));
  const dir = mkdtempSync(join(tmpdir(), "w135-pack-"));
  tempRoots.push(dir);
  const packed = spawnSync("npm", ["pack", "--pack-destination", dir], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
  });
  assert.equal(
    packed.status,
    0,
    `npm pack must succeed from the repo root (status ${packed.status}, stderr: ${packed.stderr})`,
  );
  const tarballs = readdirSync(dir).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, `npm pack produced exactly one tarball (${tarballs.join(", ")})`);
  tarballCache = join(dir, tarballs[0]!);
  return tarballCache;
}

/** Extract the packed tarball into a fresh mkdtemp tree (the installed shape). */
function extractOnce(label: string, tarball: string): string {
  const dir = mkdtempSync(join(tmpdir(), `w135-${label}-`));
  tempRoots.push(dir);
  const unpacked = spawnSync("tar", ["-xzf", tarball, "-C", dir], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(unpacked.status, 0, `tar extraction must succeed (stderr: ${unpacked.stderr})`);
  const root = join(dir, "package");
  // Preconditions for the packaged seat — NOT a re-pin of W128's shape test
  // (which owns the tarball listing): these are the facts the packaged run
  // DEPENDS on, asserted where they are consumed.
  assert.ok(
    existsSync(join(root, "scripts", "prepare-tool.mjs")),
    "the extracted tree carries the postinstall target (package.json files[] ships it — the W128 sweep's finding, fixed)",
  );
  assert.ok(
    existsSync(join(root, "mcp-toolbox", "pnpm-workspace.yaml")),
    "the extracted tree carries the toolbox workspace manifest (what makes the packaged seat's pnpm child confine itself to the installed tree)",
  );
  assert.ok(
    !existsSync(join(root, "mcp-toolbox", "node_modules")),
    "npm pack ships no toolbox node_modules (the precondition that turns the postinstall step into a full install in the packaged seat)",
  );
  return root;
}

/** The repo-side markers snapshotted before a live run, asserted after. */
function repoMarkers(): number | null {
  const path = join(repoRoot, "mcp-toolbox", "node_modules");
  return existsSync(path) ? statSync(path).mtimeMs : null;
}

/** The script's run env: operator env otherwise, HOME redirected, PATH as given. */
function preparedEnv(home: string, path?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  if (path !== undefined) env.PATH = path;
  return env;
}

function runPrepared(root: string, env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(root, "scripts", "prepare-tool.mjs")], {
    encoding: "utf8",
    timeout: 300_000,
    cwd: root,
    env,
  });
}

/** Classify a run against the observed contract, asserting the invariants. */
function classifyPrepared(run: SpawnSyncReturns<string>): PreparedRun {
  assert.equal(
    run.error,
    undefined,
    `the shipped script spawned cleanly (${run.error?.message ?? "no spawn error"})`,
  );
  assert.equal(
    run.signal,
    null,
    `the shipped script exited by itself (signal ${run.signal}) — even a failing child must not hang the hook`,
  );
  assert.equal(
    run.status,
    0,
    `the postinstall target ALWAYS exits 0 — a failing toolbox build degrades to a warn and can never fail an install (status ${run.status}, stdout tail: ${run.stdout.slice(-500)}, stderr: ${run.stderr.slice(-500)})`,
  );
  const built = run.stdout.includes("prepare: toolbox ok");
  const skipped = run.stderr.includes("prepare: toolbox skipped (");
  assert.ok(
    built !== skipped,
    `exactly one outcome class is observable (built=${built}, skipped=${skipped}; stdout tail: ${run.stdout.slice(-300)}, stderr: ${run.stderr.slice(-300)})`,
  );
  return {
    run,
    outcome: built ? { kind: "built" } : { kind: "skipped" },
  };
}

interface LiveRun extends PreparedRun {
  /** The extracted tree the run executed in (the rerun test reuses it). */
  readonly root: string;
}

let firstLiveRunCache: LiveRun | undefined;

/** The packaged seat's first live run, in ITS extracted tree (cached so the
 * rerun test re-uses the same tree — the npm-repair scenario is a rerun in
 * the SAME installed tree, not a fresh extraction). */
function firstLiveRun(): LiveRun {
  if (firstLiveRunCache !== undefined) return firstLiveRunCache;
  const root = extractOnce("live", packOnce());
  const home = mkdtempSync(join(tmpdir(), "w135-home-"));
  tempRoots.push(home);
  const markers = repoMarkers();
  const classified = classifyPrepared(runPrepared(root, preparedEnv(home)));
  if (classified.outcome.kind === "built") {
    // The observed built lane: the step installed the toolbox's dependency tree
    // INSIDE the installed tree and built the vendored guard seat there — the
    // positive half of the escape-class pin.
    assert.ok(
      existsSync(join(root, "mcp-toolbox", "node_modules")),
      "the built lane installed the toolbox dependency tree inside the INSTALLED tree (npm pack shipped none; pnpm resolved the extracted workspace, not an ancestor)",
    );
    assert.ok(
      existsSync(join(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "dist", "server.js")),
      "the built lane produced the vendored guard seat inside the installed tree (apps/workflow-guard-mcp/dist/server.js — the artifact the hub composes fail-closed)",
    );
  } else {
    // The honest skip lane: record the environment limit in the failure message
    // if the shape ever drifts — never fabricate a build.
    assert.ok(
      classified.run.stdout.trim() === "",
      `the skipped lane logs nothing to stdout (observed: ${classified.run.stdout.slice(-300)})`,
    );
  }
  assert.equal(repoMarkers(), markers, "the packaged run must not touch the repo's toolbox tree (the operator's mcp-toolbox/node_modules mtime unchanged — the escape class from the header's finding (b) stayed closed)");
  firstLiveRunCache = { root, ...classified };
  return firstLiveRunCache;
}

/** A stub pnpm that records the exact argv + cwd it was handed, then exits per env. */
function stubPnpmBin(label: string, exitCode: number): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), `w135-stub-${label}-`));
  tempRoots.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "stub.log");
  const script = join(bin, "pnpm");
  writeFileSync(
    script,
    [
      "#!/bin/bash",
      `# The W137 stub pnpm: record the exact argv + cwd, then exit ${exitCode}.`,
      'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$STUB_LOG"; done',
      'printf \'cwd=%s\\n\' "$PWD" >> "$STUB_LOG"',
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return { bin, log };
}

/** Parse the stub log into its invocation records (argv lines, then a cwd line). */
function stubInvocations(log: string): readonly { args: readonly string[]; cwd: string }[] {
  const lines = readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
  const records: { args: readonly string[]; cwd: string }[] = [];
  const args: string[] = [];
  for (const line of lines) {
    if (line.startsWith("cwd=")) {
      records.push({ args: [...args], cwd: line.slice("cwd=".length) });
      args.length = 0;
      continue;
    }
    args.push(line);
  }
  assert.ok(
    args.length === 0,
    `every stub record ends with its cwd line (trailing argv lines: ${args.join(", ")})`,
  );
  assert.ok(records.length > 0, `the stub log must carry at least one invocation record (${lines.length} lines)`);
  return records;
}

test("W137: the shipped postinstall target, run in the extracted tarball's shape, always exits 0 — building the vendored toolbox when the store allows it, skipping honestly otherwise", () => {
  const classified = firstLiveRun();
  if (classified.outcome.kind === "built") {
    // The observed class in this environment: a full pnpm install + build of the
    // shipped toolbox inside the extracted tree, ending in the ok marker.
    assert.ok(
      classified.run.stdout.includes("prepare: toolbox ok"),
      "the built lane ends with the prepare: toolbox ok marker (the step's success log)",
    );
  } else {
    // The offline/store-less class: the hook degrades to the warn and still
    // exits 0 — the honest failure shape, recorded with its message.
    assert.ok(
      classified.run.stderr.includes("prepare: toolbox skipped ("),
      `the skipped lane carries the prepare: toolbox skipped warn (stderr: ${classified.run.stderr.slice(-500)})`,
    );
  }
});

test("W137: rerunning the shipped postinstall target repeats its outcome class and still exits 0 (the stateless hook is rerun-safe in the SAME installed tree — the npm-repair scenario)", () => {
  const first = firstLiveRun();
  const home = mkdtempSync(join(tmpdir(), "w135-home2-"));
  tempRoots.push(home);
  const markers = repoMarkers();
  const second = classifyPrepared(runPrepared(first.root, preparedEnv(home)));
  assert.equal(
    second.outcome.kind,
    first.outcome.kind,
    `the rerun repeats the first run's outcome class (${first.outcome.kind} -> ${second.outcome.kind}; stdout tail: ${second.run.stdout.slice(-300)}, stderr: ${second.run.stderr.slice(-300)})`,
  );
  assert.equal(repoMarkers(), markers, "the rerun must not touch the repo's toolbox tree either");
});

test("W137: the stub seat pins the exact child contract — one pnpm invocation, `--dir <root>/mcp-toolbox run build`, cwd = the package root, and the ok marker — twice, statelessly", () => {
  const root = extractOnce("stub-ok", packOnce());
  const { bin, log } = stubPnpmBin("ok", 0);
  const home = mkdtempSync(join(tmpdir(), "w135-stubhome-"));
  tempRoots.push(home);
  const env = preparedEnv(home, bin);
  env.STUB_LOG = log;
  env.STUB_EXIT = "0";
  const first = runPrepared(root, env);
  assert.equal(first.error, undefined, "the stub seat spawns cleanly");
  assert.equal(first.signal, null, "the stub success lane exits by itself");
  assert.equal(first.status, 0, "the stub success lane exits 0");
  assert.equal(
    first.stdout,
    "prepare: toolbox ok\n",
    "the success lane's stdout is exactly the ok marker (the script logs one line, the stub is silent)",
  );
  assert.equal(first.stderr, "", "the success lane logs nothing to stderr");
  const invocation = stubInvocations(log)[0]!;
  assert.deepEqual(
    invocation.args,
    ["--dir", join(root, "mcp-toolbox"), "run", "build"],
    "the hook's entire behavior is this one child invocation (scripts/prepare-tool.mjs's single step)",
  );
  assert.equal(invocation.cwd, root, "the child runs with cwd = the package root (step()'s cwd option)");
  assert.ok(
    !existsSync(join(root, "mcp-toolbox", "node_modules")),
    "the script itself writes NOTHING — the stub seat's extracted tree gained no node_modules (every write belongs to a real pnpm child)",
  );
  // Idempotency at the invocation level: a second run re-records an identical
  // invocation and prints the identical marker.
  const second = runPrepared(root, env);
  assert.equal(second.status, 0, "the second run exits 0");
  assert.equal(second.stdout, "prepare: toolbox ok\n", "the second run prints the identical ok marker");
  const records = stubInvocations(log);
  assert.equal(records.length, 2, "two runs = two recorded invocations");
  assert.deepEqual(records[1]!.args, invocation.args, "the second invocation is byte-identical (stateless hook)");
  assert.equal(records[1]!.cwd, invocation.cwd, "the second invocation runs in the same cwd");
});

test("W137: a failing toolbox build can never fail the install — exit 0 with the honest skipped warn carrying the failing command", () => {
  const root = extractOnce("stub-fail", packOnce());
  const { bin, log } = stubPnpmBin("fail", 1);
  const home = mkdtempSync(join(tmpdir(), "w135-failhome-"));
  tempRoots.push(home);
  const env = preparedEnv(home, bin);
  env.STUB_LOG = log;
  env.STUB_EXIT = "1";
  const run = runPrepared(root, env);
  assert.equal(run.error, undefined, "the stub seat spawns cleanly");
  assert.equal(run.signal, null, "the failing-child lane exits by itself");
  assert.equal(
    run.status,
    0,
    `THE always-exit-0 pin: the child failed (exit 1) and the hook still exits 0 — step()'s catch never rethrows (status ${run.status})`,
  );
  assert.equal(run.stdout, "", "the failing lane logs nothing to stdout (the ok marker never prints)");
  assert.equal(
    run.stderr,
    `prepare: toolbox skipped (Command failed: pnpm --dir ${join(root, "mcp-toolbox")} run build)\n`,
    "the skip warn names the exact failing command (execFileSync's message; stdio inherit means the child's output already streamed through)",
  );
  const invocation = stubInvocations(log)[0]!;
  assert.deepEqual(
    invocation.args,
    ["--dir", join(root, "mcp-toolbox"), "run", "build"],
    "the failing child received the same contract argv",
  );
});

test("W137: a missing pnpm degrades to the same honest skip — exit 0, empty stdout, the spawnSync ENOENT warn (node 22's phrasing)", () => {
  const root = extractOnce("stub-absent", packOnce());
  const emptyBin = mkdtempSync(join(tmpdir(), "w135-nopnpm-"));
  tempRoots.push(emptyBin);
  const home = mkdtempSync(join(tmpdir(), "w135-absenthome-"));
  tempRoots.push(home);
  const run = runPrepared(root, preparedEnv(home, emptyBin));
  assert.equal(run.error, undefined, "the script itself spawns cleanly");
  assert.equal(run.signal, null, "the missing-tool lane exits by itself");
  assert.equal(run.status, 0, "the missing-tool lane still exits 0 — the install proceeds without the toolbox");
  assert.equal(run.stdout, "", "the missing-tool lane logs nothing to stdout");
  assert.equal(
    run.stderr,
    "prepare: toolbox skipped (spawnSync pnpm ENOENT)\n",
    "the skip warn carries node 22's spawnSync ENOENT phrasing verbatim (a node-major bump may reword it — re-pin then)",
  );
});