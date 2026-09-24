import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { guardDistIsStale } from "../src/integrations/mcp-toolbox-guard.js";
import { distArtifact, ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

// W128 — the compiled hub's HTTP contract + discovery lifecycle (multi-process
// e2e). The compiled `workflow-hub` bin only ever proved START + teardown
// (test/compiled-bins-smoke.test.ts pins the banner + exit 0); this file proves
// the CONTRACT the daemon publishes, against the real multi-process seat:
//   - the discovery file's shape exactly as src/integrations/workflow-hub.ts
//     writes it (protocol 1, hubId, endpoint, token, written 0o600 at the path
//     the hub's own banner prints) plus the separate verifier.json credential
//     beside it (the verification token is a distinct credential — P1-1);
//   - the HTTP contract of src/integrations/hub-http.ts: the /health probe
//     (POST + Bearer — probeHub's wire shape, src/cli/hub-client.ts:44-55), the
//     authenticated POST /snapshot canonical projection (the hub's seeded
//     "interactive" READY task, src/cli/hub.ts:41-49), and the honest refusal
//     of both an unauthenticated request and a non-POST method (the 401
//     token/method gates in hub-http.ts:85,98 are the security seam);
//   - the clean teardown: SIGTERM to the child's whole process group → the
//     hub's own guarded shutdown (src/cli/hub.ts:362-382) exits 0 on its own
//     and hub.close() (workflow-hub.ts:175-181) unlinks discovery.json,
//     verifier.json, and the instance lock dir.
// Safety contract (LESS-0051): no agent or PTY spawns ever. The guard MCP
// child the hub composes at startup is the product's own fail-closed
// composition (src/cli/hub.ts:76-85) — allowed — which is exactly why the
// kill must reach it: the hub child is the detached group leader, and the
// guard grandchild is spawned WITHOUT detached (the MCP SDK's
// StdioClientTransport), so it shares the hub's group — the group SIGTERM
// reaps both. All
// hub state lands under a redirected HOME (discovery/lock/provenance/
// schedules live under resolve(homedir(), ".workflow") or the WORKFLOW_HUB_*
// overrides), the bridge binds port 0 (hub-http.ts:61), and the server is
// never spawnSync-timeout-killed: async spawn → banner → SIGTERM → pinned
// exit. The W120 vendored-gate remedy is replicated honestly in
// ensureToolboxGuardBuilt — the hub refuses to run without its guard, so a
// missing/stale guard dist is a precondition failure that names its remedy.

/** The vendored guard seat: the hub composes it fail-closed at startup, so
 * this probe needs it built and fresh (the W120 gate's remedy — which
 * requires `pnpm` on PATH and the toolbox's node_modules installed; the error
 * names the remedy instead of surfacing a raw ENOENT, with the cause
 * attached per the preserve-caught-error lint rule). */
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
      `the compiled hub composes the vendored workflow-guard-mcp seat fail-closed, and its self-healing build failed — run "npm run toolbox:install && npm run toolbox:build" once (pnpm required): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

test("W128: the compiled hub publishes the discovery contract, serves the authenticated HTTP contract, and unlinks discovery on its clean teardown", async (context) => {
  ensureFresh(distArtifact("cli", "hub.js"));
  ensureToolboxGuardBuilt();

  const home = mkdtempSync(join(tmpdir(), "w128-hub-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const provenancePath = join(home, "provenance.jsonl");
  const schedulesPath = join(home, "schedules.json");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    WORKFLOW_HUB_PROVENANCE: provenancePath,
    WORKFLOW_HUB_SCHEDULES: schedulesPath,
    // Checkpoint F: the fail-closed stub keeps the self-improvement loop out
    // of the probe (no agent turns; explicit opt-out per src/cli/hub.ts:161-176).
    WORKFLOW_RSI_AGENT: "0",
  };
  // Determinism: these operator seams would change hub behavior if inherited
  // (a request-log append path; a real team-verification command), so the
  // probe strips them instead of pinning the ambient machine's values.
  delete env.WORKFLOW_HUB_REQUEST_LOG;
  delete env.WORKFLOW_TEAM_TASK_VERIFY_COMMAND;

  let output = "";
  let exitInfo: { code: number | null; signal: string | null } | undefined;
  const child = spawn(process.execPath, [distArtifact("cli", "hub.js")], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  // The child leads its own process group (detached), so the kill reaches the
  // guard MCP grandchild it composes — the same kill-group pattern as the
  // W126 smoke's probeDaemon and src/cli/opencode-attach.ts's
  // terminateProcessGroup. If an assertion fails mid-probe, the after-hook
  // still hard-kills the group so no hub or guard survives the test.
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

  // Startup: wait for BOTH banners — the listening line and the discovery
  // line the hub prints back to back (src/cli/hub.ts:359-360). An early exit
  // is the honest failure, surfaced with whatever the hub printed.
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
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/, "the hub binds the loopback bridge to an ephemeral port (hub-http.ts:61)");

  // Discovery shape (pinned from src/integrations/workflow-hub.ts:150-160 —
  // not invented): protocol 1, an 8-byte hex hubId, the bridge endpoint, and
  // the surface token, written 0o600 (the token file must not be
  // world-readable — same security seam as the HTTP token gate).
  assert.ok(existsSync(discoveryPath), `the hub's own banner names its discovery file, and it exists: ${discoveryPath}`);
  assert.equal(statSync(discoveryPath).mode & 0o777, 0o600, "the discovery file is written 0o600");
  const discovery = JSON.parse(readFileSync(discoveryPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(discovery).sort(),
    ["endpoint", "hubId", "protocol", "token"],
    `discovery.json's exact field set — observed: ${JSON.stringify(Object.keys(discovery).sort())}`,
  );
  assert.equal(discovery.protocol, 1);
  assert.match(discovery.hubId as string, /^[0-9a-f]{16}$/);
  assert.equal(discovery.endpoint, endpoint, "the discovery endpoint is the banner's listening URL");
  assert.match(discovery.token as string, /^[0-9a-f]{64}$/);
  const token = discovery.token as string;

  // The verifier credential beside it (workflow-hub.ts:162-167): the same
  // protocol/endpoint, its OWN token — a separate credential from the surface
  // token (P1-1), never the same value.
  const verifierPath = join(dirname(discoveryPath), "verifier.json");
  assert.ok(existsSync(verifierPath), `the verifier discovery is published beside discovery.json: ${verifierPath}`);
  const verifier = JSON.parse(readFileSync(verifierPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(verifier).sort(), ["endpoint", "protocol", "token"]);
  assert.equal(verifier.protocol, 1);
  assert.equal(verifier.endpoint, endpoint);
  assert.match(verifier.token as string, /^[0-9a-f]{64}$/);
  assert.notEqual(verifier.token, token, "the verifier token is distributed separately from the surface token");

  // /health — probeHub's contract (src/cli/hub-client.ts:44-55): POST with
  // the Bearer token, 200 { status: "ok" }. Note the pinned truth: hub-http
  // refuses EVERY non-POST method with 401 before route dispatch
  // (hub-http.ts:85), so GET /health is NOT the probe's wire shape.
  const health = await fetch(`${endpoint}/health`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  // The token gate is the security seam: the same /health without the Bearer
  // token is refused 401 (hub-http.ts:98).
  const unauthenticatedHealth = await fetch(`${endpoint}/health`, { method: "POST" });
  assert.equal(unauthenticatedHealth.status, 401);
  assert.deepEqual(await unauthenticatedHealth.json(), { error: "unauthorized" });

  // ...and so is a non-POST method, even authenticated (hub-http.ts:85):
  // the hub serves POST-only routes; pin that honestly.
  const getHealth = await fetch(`${endpoint}/health`, { method: "GET" });
  assert.equal(getHealth.status, 401);

  // /snapshot — the authenticated canonical route (hub-http.ts:228-254, POST
  // with a JSON body): the hub's canonical task state carries the seeded
  // "interactive" READY task from src/cli/hub.ts:41-49, projected through the
  // full WorkflowSnapshot shape (src/application/workflow.ts:30-37).
  const snapshotResponse = await fetch(`${endpoint}/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(snapshotResponse.status, 200);
  const snapshotBody = await snapshotResponse.json() as {
    snapshot: Record<string, unknown>;
    gateObservability: Record<string, unknown>;
  };
  // Pinned from the LIVE hub, not invented: a fresh hub's canonical
  // projection is EMPTY of tasks — the hub's seeded "interactive" placeholder
  // (src/cli/hub.ts:41-49) is deliberately SUPPRESSED from the served
  // projection by the run registry's hiddenSnapshotTaskIds
  // (src/integrations/run-registry.ts:251-257), which hides exactly that seed
  // (matched by title) plus finished run tasks, so hub-attached surfaces never
  // render the hub's own placeholder. The WorkflowSnapshot envelope itself is
  // full shape (src/application/workflow.ts:30-37), enforcement enforced (the
  // hub composes authoritativePreMutation, src/cli/hub.ts:52).
  assert.deepEqual(
    snapshotBody.snapshot,
    {
      enforcementLevel: "enforced",
      transport: "native",
      mutationEpoch: 0,
      tasks: [],
      evidence: [],
      history: [],
    },
    `the canonical projection is the full WorkflowSnapshot envelope with the seed task suppressed — observed: ${JSON.stringify(snapshotBody.snapshot)}`,
  );
  // Run-gate observability rides alongside the projection (observability-only;
  // pinned from the live no-runs hub — Plan Task A3 + Iteration 21 + W044).
  assert.deepEqual(
    snapshotBody.gateObservability,
    {
      reviewOutcomes: {},
      blockingReasons: {},
      completionClaims: {},
      reasoningClaims: {},
      reasoningClaimMetrics: { monitoredRuns: 0, flaggedRuns: 0, findings: 0, recall: "unmeasured", timeToResponseMs: "unmeasured" },
      usage: {},
    },
    `gate observability is empty-but-present on a fresh hub — observed: ${JSON.stringify(snapshotBody.gateObservability)}`,
  );

  // The unauthenticated snapshot is refused honestly — 401, the same token
  // gate as /health (hub-http.ts:98; the auth check precedes body parsing).
  const unauthenticatedSnapshot = await fetch(`${endpoint}/snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthenticatedSnapshot.status, 401);
  assert.deepEqual(await unauthenticatedSnapshot.json(), { error: "unauthorized" });

  // Teardown: SIGTERM the child's PROCESS GROUP, await the exit, and pin the
  // surface's own honest teardown (src/cli/hub.ts:362-382): exit 0 by its own
  // handler (never a signal kill), and hub.close()'s unlink of discovery.json,
  // verifier.json, and the instance lock (workflow-hub.ts:175-181) — the
  // discovery lifecycle ends the way it began, atomically owned by the hub.
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