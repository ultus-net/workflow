import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { distArtifact, ensureFresh, ensureToolboxGuardBuilt, repoRoot } from "./fixtures/compiled-dist.js";

// W136 — the `workflow-rsi` CLI's CLIENT-side flow against a live compiled hub
// (multi-process e2e). The W126/W129 sweep pinned only the help contract
// (usage on stdout, exit 0, no hub) and W133 pinned the hub's ROUTE-level
// /rsi contract via direct fetches — but the CLI's own discovery →
// authentication → request flow, the multi-process hop an operator actually
// runs (`workflow-rsi status` against a live daemon), had never been driven.
// Pinned from src/cli/rsi.ts, src/cli/hub-client.ts, and
// src/integrations/hub-http.ts, observed live against the real multi-process
// seat (LESS-0054: run first, pin observed truth — nothing here is invented):
//   - the token-class split, proven through the CLIENT's own resolution
//     (rsi.ts:115-119 vs 121-137; the hub's gate at hub-http.ts:92-97):
//     `status`/`cancel` authenticate with the OPERATOR token from
//     discovery.json — the same request succeeds with it and is refused 401
//     when a crafted discovery seat carries the VERIFIER token instead —
//     while `start` resolves the verifier credential client-side and refuses
//     closed (exit 1, "no Workflow hub verifier discovery at … (is the hub
//     running?)") when verifier.json is absent — BEFORE any request is made;
//   - the honest success shapes on a fresh hub (exit 0; the hub's JSON body
//     pretty-printed as the CLI's ENTIRE stdout, nothing else):
//     { loops: [] } for status, { loop: null } for an unknown id,
//     { cancelled: false } for a cancel of a non-existent id or workspace —
//     the W133 route bodies re-projected through the CLI's stdout contract
//     (rsi.ts:166-171), not re-pinned at route level;
//   - the honest refusal shapes (exit 1, the message on stderr, stdout
//     empty): a missing discovery seat; a MALFORMED discovery file — honestly
//     INDISTINGUISHABLE from missing, because readHubDiscovery
//     (hub-client.ts:26-42) returns undefined for either; a well-formed
//     discovery pointing at a dead endpoint ("fetch failed" — the discovery
//     file alone is not authority); and the parse refusals, which fire BEFORE
//     any hub resolution or request (rsi.ts:154 precedes :159): cancel
//     without --id/--workspace, an unknown command, a non-flag argument, and
//     start missing its required flags;
//   - the discovery-dir seam and its precedence (rsi.ts:59-61):
//     --discovery-dir beats WORKFLOW_HUB_DIR beats ~/.workflow, each named
//     verbatim in the failure message.
// Safety contract (LESS-0051): no agent or PTY spawns ever. /rsi/start is
// NEVER called — the closest this probe comes is the client-side
// verifier-missing refusal, which throws before any request (and a follow-up
// status proves the hub still holds zero loop records: nothing was armed).
// The only verifier-token request is a REFUSED /rsi/status (an operator
// read) with the wrong token class, which authorizes nothing — W133's
// matrix re-proven end to end. All state lands under a redirected HOME
// (discovery/verifier/lock/provenance/schedules), the hub binds port 0
// (hub-http.ts:61), and the server is never spawnSync-timeout-killed: async
// spawn → both banners → CLI spawnSyncs → process-group SIGTERM → pinned
// exit + unlink truth (W128 pins the guarded-shutdown contract in depth; the
// teardown here is re-observed because this probe owns its hub). The CLI
// processes are one-shot clients that exit by themselves — spawnSync is safe
// for them (never for a server). The W120 vendored-gate remedy lives in the
// shared fixture (ensureToolboxGuardBuilt) — the hub refuses to run without
// its guard.

const sleep = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** SpawnSync the compiled one-shot CLI (it exits by itself — never a server)
 * under the redirected HOME. Common honesty asserts live here: a clean spawn
 * and a self-exit (never timeout-killed). `additions` ride ON TOP of the
 * redirected HOME, after the ambient WORKFLOW_HUB_DIR is stripped (an
 * inherited operator seam would redirect discovery resolution and make the
 * probe machine-dependent). */
function runRsi(home: string, argv: readonly string[], additions: Readonly<Record<string, string>> = {}): CliRun {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.WORKFLOW_HUB_DIR;
  for (const [key, value] of Object.entries(additions)) env[key] = value;
  const result = spawnSync(process.execPath, [distArtifact("cli", "rsi.js"), ...argv], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  const label = `workflow-rsi [${argv.join(" ")}]`;
  assert.equal(result.error, undefined, `${label}: spawned cleanly (${result.error?.message ?? "no spawn error"})`);
  assert.equal(result.signal, null, `${label}: exits by itself, not killed by ${result.signal}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("W136: the compiled workflow-rsi CLI fails closed before any request without a usable discovery seat", async (context) => {
  ensureFresh(distArtifact("cli", "rsi.js"));
  // No hub is spawned in this test at all — every pin here is client-side:
  // what the CLI does when the discovery seat it resolves is missing,
  // malformed, or pointing at a dead endpoint, and which parse refusals fire
  // before discovery is even consulted.
  const home = mkdtempSync(join(tmpdir(), "w136-rsi-cli-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));

  // Missing discovery (fresh HOME, no .workflow): the fail-closed message
  // names the resolved seat verbatim (rsi.ts:117), exit 1, stdout empty.
  const missing = runRsi(home, ["status"]);
  assert.equal(missing.status, 1, `status without any hub discovery exits 1 — stderr: ${missing.stderr.slice(0, 300)}`);
  assert.equal(missing.stdout, "", "the failure writes nothing to stdout — the message is stderr's alone");
  assert.equal(missing.stderr, `no Workflow hub discovery found under ${join(home, ".workflow")}\n`);

  // The WORKFLOW_HUB_DIR seam (rsi.ts:59-61): the env var resolves BEFORE
  // ~/.workflow, and the message names the env-resolved seat.
  const envSeat = join(home, "env-seat");
  const viaEnv = runRsi(home, ["status"], { WORKFLOW_HUB_DIR: envSeat });
  assert.equal(viaEnv.status, 1);
  assert.equal(viaEnv.stderr, `no Workflow hub discovery found under ${envSeat}\n`,
    "WORKFLOW_HUB_DIR resolves before ~/.workflow and is named verbatim in the failure");

  // Precedence: --discovery-dir beats WORKFLOW_HUB_DIR (rsi.ts:59-61 — the
  // flag branch is checked first).
  const flagSeat = join(home, "flag-seat");
  const viaFlag = runRsi(home, ["status", "--discovery-dir", flagSeat], { WORKFLOW_HUB_DIR: envSeat });
  assert.equal(viaFlag.status, 1);
  assert.equal(viaFlag.stderr, `no Workflow hub discovery found under ${flagSeat}\n`,
    "--discovery-dir beats WORKFLOW_HUB_DIR — the message names the flag-resolved seat");

  // A MALFORMED discovery file is honestly indistinguishable from a missing
  // one: readHubDiscovery (hub-client.ts:26-42) JSON-parses and returns
  // undefined on failure, so the CLI reports the same missing-seat message.
  mkdirSync(join(home, ".workflow", "hub"), { recursive: true });
  const discoveryPath = join(home, ".workflow", "hub", "discovery.json");
  writeFileSync(discoveryPath, "{malformed", { mode: 0o600 });
  const malformed = runRsi(home, ["status"]);
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stderr, `no Workflow hub discovery found under ${join(home, ".workflow")}\n`,
    "OBSERVED: a malformed discovery.json earns the identical missing-seat message — the CLI cannot tell the two apart (hub-client.ts:29-41)");

  // A well-formed discovery pointing at a DEAD endpoint: the discovery file
  // alone is not authority — resolveHub (rsi.ts:115-119) trusts it without a
  // probe, and the failure surfaces at the wire. Observed message: "fetch
  // failed" (undici's message; its cause carries the ECONNREFUSED the CLI
  // never prints). The port is grabbed and released so the endpoint is dead
  // but deterministically so; if another process bound it in the race
  // window, this pin would fail loudly instead of passing vacuously.
  const deadServer = createServer(() => undefined);
  const deadPort = await new Promise<number>((resolvePort) => {
    deadServer.listen(0, "127.0.0.1", () => resolvePort((deadServer.address() as { port: number }).port));
  });
  await new Promise<void>((resolveClose) => deadServer.close(() => resolveClose()));
  writeFileSync(
    discoveryPath,
    JSON.stringify({ protocol: 1, hubId: "a".repeat(16), endpoint: `http://127.0.0.1:${deadPort}`, token: "b".repeat(64) }),
    { mode: 0o600 },
  );
  const dead = runRsi(home, ["status"]);
  assert.equal(dead.status, 1, `status against a dead endpoint exits 1 — stderr: ${dead.stderr.slice(0, 300)}`);
  assert.equal(dead.stdout, "");
  assert.equal(dead.stderr, "fetch failed\n",
    "OBSERVED: the dead-endpoint refusal is undici's bare message — the discovery file alone is not authority");

  // The parse refusals fire BEFORE any hub resolution (parseRsiArgs at
  // rsi.ts:154 precedes resolveHub at :159) — this HOME has a (dead-endpoint)
  // discovery file, yet the cancel/argv refusals never reach it.
  const cancelParse = runRsi(home, ["cancel"]);
  assert.equal(cancelParse.status, 1);
  assert.equal(cancelParse.stdout, "");
  assert.equal(cancelParse.stderr, "cancel requires --id or --workspace\n",
    "cancel without --id/--workspace is a PARSE refusal — it fires before hub resolution, dead discovery notwithstanding");

  const unknownCommand = runRsi(home, ["frobnicate"]);
  assert.equal(unknownCommand.status, 1);
  assert.equal(unknownCommand.stdout, "");
  assert.equal(unknownCommand.stderr, "unknown command: frobnicate\n");

  const unexpectedArgument = runRsi(home, ["status", "extra"]);
  assert.equal(unexpectedArgument.status, 1);
  assert.equal(unexpectedArgument.stdout, "");
  assert.equal(unexpectedArgument.stderr, "unexpected argument: extra\n");

  const startParse = runRsi(home, ["start"]);
  assert.equal(startParse.status, 1);
  assert.equal(startParse.stdout, "");
  assert.equal(startParse.stderr, "start requires --workspace, --objective, and --max-iterations\n");
});

test("W136: the compiled workflow-rsi CLI drives the live hub — operator-token reads, the verifier credential's client-side gate, and nothing armed", async (context) => {
  ensureFresh(distArtifact("cli", "hub.js"));
  ensureFresh(distArtifact("cli", "rsi.js"));
  ensureToolboxGuardBuilt();

  const home = mkdtempSync(join(tmpdir(), "w136-rsi-cli-live-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const provenancePath = join(home, "provenance.jsonl");
  const schedulesPath = join(home, "schedules.json");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    WORKFLOW_HUB_PROVENANCE: provenancePath,
    WORKFLOW_HUB_SCHEDULES: schedulesPath,
    // Checkpoint F (same as W128/W133): the fail-closed stub keeps the loop
    // out of the probe — no agent turns; the RSI REGISTRY is still composed,
    // which is exactly what the CLI's /rsi pins below observe.
    WORKFLOW_RSI_AGENT: "0",
  };
  // Determinism (same as W128/W133): these operator seams would change hub
  // behavior if inherited, so the probe strips them.
  delete env.WORKFLOW_HUB_REQUEST_LOG;
  delete env.WORKFLOW_TEAM_TASK_VERIFY_COMMAND;
  delete env.WORKFLOW_HUB_DIR;

  let output = "";
  let exitInfo: { code: number | null; signal: string | null } | undefined;
  const child = spawn(process.execPath, [distArtifact("cli", "hub.js")], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  // The child leads its own process group (detached), so the kill reaches the
  // guard MCP grandchild it composes — W128's kill-group pattern. The
  // after-hook hard-kills the group if an assertion fails mid-probe.
  const killGroup = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* already exited */
    }
  };
  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      resolveExit({ code, signal });
    });
  });
  context.after(() => {
    if (exitInfo === undefined) killGroup("SIGKILL");
  });
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  // Startup: wait for BOTH banners (src/cli/hub.ts:367-368) and parse the
  // discovery path the hub's own banner names (the W128/W133 skeleton,
  // reused rather than reinvented).
  const deadline = Date.now() + 30_000;
  while (
    exitInfo === undefined &&
    (!output.includes("Workflow hub listening at") || !output.includes("Discovery file: ")) &&
    Date.now() < deadline
  ) {
    await sleep(100);
  }
  const listeningMatch = output.match(/Workflow hub listening at (\S+)/);
  const discoveryMatch = output.match(/Discovery file: (.+)/);
  assert.ok(exitInfo === undefined, `the hub exited before serving — output: ${output.slice(0, 600)}`);
  assert.ok(listeningMatch !== null, `the listening banner never appeared — output: ${output.slice(0, 600)}`);
  assert.ok(discoveryMatch !== null, `the discovery banner never appeared — output: ${output.slice(0, 600)}`);
  const endpoint = listeningMatch![1]!;
  const discoveryPath = discoveryMatch![1]!.trim();
  assert.equal(
    discoveryPath,
    join(home, ".workflow", "hub", "discovery.json"),
    "the discovery file lands under the redirected HOME — the seat the CLI's DEFAULT resolution must find (workflow-hub.ts:89-90)",
  );
  const discovery = JSON.parse(readFileSync(discoveryPath, "utf8")) as { endpoint: string; hubId: string; token: string };
  const token = discovery.token;
  assert.equal(discovery.endpoint, endpoint, "the discovery endpoint is the banner's listening URL (full shape is W128's pin)");
  const verifierPath = join(dirname(discoveryPath), "verifier.json");
  const verifier = JSON.parse(readFileSync(verifierPath, "utf8")) as { token: string };
  const verifierToken = verifier.token;
  assert.notEqual(verifierToken, token, "the verifier token is a distinct credential (P1-1; full shape is W128's pin)");

  // ── The operator-token reads against the LIVE hub ────────────────────────
  // `status` on a fresh hub: exit 0, and the hub's { loops: [] } body is the
  // CLI's entire stdout, pretty-printed exactly (rsi.ts:166) — the W133
  // route body re-projected through the CLI's own stdout contract.
  const status = runRsi(home, ["status"]);
  assert.equal(status.status, 0, `status on a fresh hub exits 0 — stderr: ${status.stderr.slice(0, 300)}`);
  assert.equal(status.stderr, "", "the success writes nothing to stderr");
  assert.equal(status.stdout, `${JSON.stringify({ loops: [] }, null, 2)}\n`,
    "the fresh hub's empty loop registry is the CLI's entire stdout — exact pretty-printed JSON (rsi.ts:166)");

  // An unknown loop id: the hub's explicit null (W133's route pin) as the
  // CLI projects it — exit 0, { loop: null }, never an error.
  const statusUnknown = runRsi(home, ["status", "--id", "rsi-loop:missing"]);
  assert.equal(statusUnknown.status, 0);
  assert.equal(statusUnknown.stdout, `${JSON.stringify({ loop: null }, null, 2)}\n`);

  // Cancel of a NON-EXISTENT id is a safe refusal to pin (nothing to cancel;
  // the loop registry is untouched): exit 0, the hub's honest false.
  const cancelUnknown = runRsi(home, ["cancel", "--id", "rsi-loop:missing"]);
  assert.equal(cancelUnknown.status, 0);
  assert.equal(cancelUnknown.stdout, `${JSON.stringify({ cancelled: false }, null, 2)}\n`);

  // ...and by workspace — same honest false for a workspace that never had a
  // loop (the registry's cancel is a filter miss, not an error).
  const cancelWorkspace = runRsi(home, ["cancel", "--workspace", join(home, "no-such-workspace")]);
  assert.equal(cancelWorkspace.status, 0);
  assert.equal(cancelWorkspace.stdout, `${JSON.stringify({ cancelled: false }, null, 2)}\n`);

  // ── `start`: the client-side verifier gate — NEVER a /rsi/start request ──
  // start is the most consequential autonomous action; this probe never
  // sends it. The pin is the CLIENT's own consequential-action gate
  // (rsi.ts:160-164 → 121-137): with verifier.json absent, the CLI refuses
  // closed BEFORE any request — exit 1, the message naming the verifier seat
  // it needed. (W133 pinned the route-level token gate with the WRONG token
  // class; this is the missing-credential side of the same trust model.)
  const verifierHold = `${verifierPath}.w136-hold`;
  renameSync(verifierPath, verifierHold);
  let refusedStart: CliRun;
  try {
    refusedStart = runRsi(home, [
      "start", "--workspace", join(home, "never-workspace"), "--objective", "never runs", "--max-iterations", "1",
    ]);
  } finally {
    renameSync(verifierHold, verifierPath);
  }
  assert.equal(refusedStart.status, 1, `start without the verifier credential exits 1 — stderr: ${refusedStart.stderr.slice(0, 300)}`);
  assert.equal(refusedStart.stdout, "", "the refused start printed nothing to stdout — no loop body was ever served");
  assert.equal(
    refusedStart.stderr,
    `no Workflow hub verifier discovery at ${verifierPath} (is the hub running?)\n`,
    "the start refusal names the VERIFIER seat (rsi.ts:125) — the ordinary discovery token was not enough, client-side",
  );

  // And the refused start armed NOTHING: the registry is still empty — the
  // client gate threw before any request could reach the hub.
  const statusAfterRefusedStart = runRsi(home, ["status"]);
  assert.equal(statusAfterRefusedStart.status, 0);
  assert.equal(statusAfterRefusedStart.stdout, `${JSON.stringify({ loops: [] }, null, 2)}\n`,
    "the refused start left the loop registry untouched — nothing was armed");

  // ── The token class, proven from the CLIENT side ─────────────────────────
  // A crafted discovery seat carrying the VERIFIER token (same shape, same
  // endpoint): `status` with it is refused — the hub's operator/verifier
  // split (hub-http.ts:92-97) holds against the CLI's own auth resolution.
  // Read this pin together with the successful `status` above: the SAME
  // command over the SAME seat shape succeeds with the discovery token and
  // fails 401 with the verifier token — so the CLI's status/cancel
  // authenticate with exactly the OPERATOR credential from discovery.json
  // (rsi.ts:115-119), never the verifier one.
  const swapSeat = join(home, "verifier-seat");
  mkdirSync(join(swapSeat, "hub"), { recursive: true });
  writeFileSync(
    join(swapSeat, "hub", "discovery.json"),
    JSON.stringify({ protocol: 1, hubId: discovery.hubId, endpoint, token: verifierToken }),
    { mode: 0o600 },
  );
  const verifierOnStatus = runRsi(home, ["status", "--discovery-dir", swapSeat]);
  assert.equal(verifierOnStatus.status, 1, `a verifier credential on the operator route is refused — stderr: ${verifierOnStatus.stderr.slice(0, 300)}`);
  assert.equal(verifierOnStatus.stdout, "");
  assert.equal(verifierOnStatus.stderr, "hub /rsi/status failed: unauthorized\n",
    "the hub's 401 surfaces through the CLI's call-error shape (rsi.ts:146-149) — the token-class split holds end to end");

  // ── Teardown (W128's guarded-shutdown contract re-observed compactly —
  // this probe owns its hub): process-group SIGTERM → the hub's own exit 0 →
  // the unlink truth (discovery.json, verifier.json, the instance lock). ──
  killGroup("SIGTERM");
  const hardKill = setTimeout(() => killGroup("SIGKILL"), 15_000);
  const finalExit = await exitPromise;
  clearTimeout(hardKill);
  assert.equal(finalExit.signal, null, `the hub died by ${finalExit.signal} instead of its own SIGTERM teardown — output: ${output.slice(0, 600)}`);
  assert.equal(finalExit.code, 0, `the hub's guarded shutdown exits 0 — output: ${output.slice(0, 600)}`);
  const unlinkDeadline = Date.now() + 10_000;
  while (Date.now() < unlinkDeadline && (existsSync(discoveryPath) || existsSync(verifierPath))) {
    await sleep(100);
  }
  assert.ok(!existsSync(discoveryPath), `discovery.json is unlinked after the clean teardown (still present at ${discoveryPath})`);
  assert.ok(!existsSync(verifierPath), `verifier.json is unlinked after the clean teardown (still present at ${verifierPath})`);
  const lockDir = join(home, ".workflow", "hub", "lock");
  assert.ok(!existsSync(lockDir), `the single-instance lock dir is released after the clean teardown (still present at ${lockDir})`);
});