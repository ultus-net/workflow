import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { distArtifact, ensureFresh, ensureToolboxGuardBuilt, repoRoot } from "./fixtures/compiled-dist.js";

// W133 — the compiled hub's ROUTE-level contract: the two-credential class
// matrix, the composed schedule/self-improvement routes' shapes on a fresh
// hub, and the honest refusal shapes (multi-process e2e). The sibling W128
// file already pins discovery + snapshot + teardown in depth — this is the
// DEEPER route contract and does not re-pin those; the spawn/discovery/
// teardown skeleton below is W128's, reused rather than reinvented.
// Pinned from src/integrations/hub-http.ts, observed live against the real
// multi-process seat (not invented):
//   - the token-class split (hub-http.ts:92-98): /run/review, /run/finish,
//     /rsi/start and /schedule/run-now require the VERIFIER credential from
//     verifier.json (P1-1 — the ordinary token's blast radius must not include
//     arming an autonomous mutation loop or firing a scheduled run); every
//     other route requires the operator token from discovery.json. BOTH
//     directions are pinned: a verifier credential on an operator route → 401,
//     an operator credential on a verifier-only route → 401 — and because
//     authorization precedes body parsing and dispatch (hub-http.ts:98 before
//     the readJson at hub-http.ts:100), those pins move no hub state;
//   - the schedule routes (hub-http.ts:195-227): on the compiled hub the W074
//     registry IS composed (src/cli/hub.ts:156-161), so /schedule/list|save|
//     delete are 200-shaped, never 404 — a hub composed without `schedules`
//     would 404 them fail-closed (workflow-hub.ts:84-86). The list→save→delete
//     lifecycle is pinned through the live registry (the single authority over
//     the persisted table, schedule-registry.ts:7-19), including both refusal
//     classes: the route-level 400 (hub-http.ts:202-204) and the
//     registry-level 400 surfaced through the route's client-error catch
//     (hub-http.ts:205-212) — a rejected save never partially admits;
//   - the self-improvement routes (hub-http.ts:178-194): composed even with
//     WORKFLOW_RSI_AGENT=0 (the Checkpoint F fail-closed stub arms only the
//     loop RUNNER, src/cli/hub.ts:249-264 — the registry still exists), so a
//     fresh hub reports zero loop records, an explicit null for an unknown id,
//     and a false cancel — never a 404;
//   - the trailing 404 for an unknown route (hub-http.ts:268), and the
//     observed 500 an EMPTY-body request earns from the catch-all
//     (hub-http.ts:269-271) — a client payload error (zero chunks, so
//     JSON.parse("") throws) classified as a server fault; recorded here
//     honestly as a finding, not fixed.
// Safety contract (LESS-0051): no agent or PTY spawns. /rsi/start is NEVER
// called with the verifier credential — the most consequential autonomous
// action — and /schedule/run-now likewise (it fires a real contained agent
// run); both are pinned with the WRONG token class only, which authorizes
// nothing. All hub state lands under a redirected HOME (discovery/lock/
// provenance/schedules isolated; the schedule lifecycle mutates only the
// probe's own WORKFLOW_HUB_SCHEDULES file), the bridge binds port 0
// (hub-http.ts:61), and the server is never spawnSync-timeout-killed: async
// spawn → both banners → route pins → process-group SIGTERM → pinned exit +
// unlink truth (W128 pins the guarded-shutdown contract in depth; here the
// teardown is re-observed because this probe owns its own hub process, plus
// one new teardown truth: the persisted schedule table is operator state that
// hub.close() deliberately does NOT unlink — workflow-hub.ts:175-181 removes
// only discovery.json, verifier.json, and the instance lock).

const sleep = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/** The route pins' wire shape: POST + Bearer (hub-http serves POST-only
 * routes — the non-POST refusal itself is W128's pin at hub-http.ts:85) with
 * a JSON body — every route except /health parses a JSON body after the auth
 * gate (readJson, hub-http.ts:100), so the helper always sends "{}" unless
 * the caller overrides; an EMPTY body is separately pinned below as the
 * observed 500 finding. */
async function postRoute(
  endpoint: string,
  path: string,
  token: string | undefined,
  body: unknown = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("W133: the compiled hub's routes enforce the operator/verifier token-class split and serve the composed schedule and self-improvement contracts on a fresh hub", async (context) => {
  ensureFresh(distArtifact("cli", "hub.js"));
  ensureToolboxGuardBuilt();

  const home = mkdtempSync(join(tmpdir(), "w133-hub-routes-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const provenancePath = join(home, "provenance.jsonl");
  const schedulesPath = join(home, "schedules.json");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    WORKFLOW_HUB_PROVENANCE: provenancePath,
    WORKFLOW_HUB_SCHEDULES: schedulesPath,
    // Checkpoint F (same as W128): the fail-closed stub keeps the loop out of
    // the probe — no agent turns; the RSI REGISTRY is still composed, which is
    // exactly what the /rsi pins below observe.
    WORKFLOW_RSI_AGENT: "0",
  };
  // Determinism (same as W128): these operator seams would change hub
  // behavior if inherited, so the probe strips them.
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
  // discovery path the hub's own banner names.
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

  // Both credentials, read from the redirected HOME (the full discovery.json
  // and verifier.json shapes — protocol 1, hubId, 0o600 modes, endpoint
  // equality — are W128's pins; here only the tokens are extracted, plus the
  // HOME-isolation pin this probe adds).
  assert.equal(
    discoveryPath,
    join(home, ".workflow", "hub", "discovery.json"),
    "the discovery file lands under the redirected HOME — the probe's isolation seam (workflow-hub.ts:89-90)",
  );
  assert.ok(existsSync(discoveryPath), `the hub's own banner names its discovery file, and it exists: ${discoveryPath}`);
  const discovery = JSON.parse(readFileSync(discoveryPath, "utf8")) as { token: string };
  const token = discovery.token;
  assert.equal(typeof token, "string", "discovery.json carries the operator token");
  assert.match(token, /^[0-9a-f]{64}$/);
  const verifierPath = join(dirname(discoveryPath), "verifier.json");
  assert.ok(existsSync(verifierPath), `the verifier discovery is published beside discovery.json: ${verifierPath}`);
  const verifier = JSON.parse(readFileSync(verifierPath, "utf8")) as { token: string };
  const verifierToken = verifier.token;
  assert.equal(typeof verifierToken, "string", "verifier.json carries the verifier token");
  assert.match(verifierToken, /^[0-9a-f]{64}$/);
  assert.notEqual(verifierToken, token, "the verifier token is a distinct credential (P1-1; full shape is W128's pin)");

  // ── The token-class matrix, BOTH directions ─────────────────────────────
  // A verifier credential on an OPERATOR route is refused 401 — the split is
  // not a privilege ladder; each credential opens exactly its own class
  // (hub-http.ts:92-98).
  const verifierOnHealth = await fetch(`${endpoint}/health`, {
    method: "POST",
    headers: { authorization: `Bearer ${verifierToken}` },
  });
  assert.equal(verifierOnHealth.status, 401, "/health is an operator route — the verifier credential must not serve it");
  assert.deepEqual(await verifierOnHealth.json(), { error: "unauthorized" });

  const verifierOnSnapshot = await postRoute(endpoint, "/snapshot", verifierToken);
  assert.equal(verifierOnSnapshot.status, 401);
  assert.deepEqual(verifierOnSnapshot.body, { error: "unauthorized" });

  const verifierOnScheduleList = await postRoute(endpoint, "/schedule/list", verifierToken);
  assert.equal(verifierOnScheduleList.status, 401);
  assert.deepEqual(verifierOnScheduleList.body, { error: "unauthorized" });

  // Observed truth (source-read first, then pinned live): /rsi/status is an
  // OPERATOR route — only /rsi/start is verifier-gated (hub-http.ts:92-97) —
  // so the VERIFIER credential is the one refused here.
  const verifierOnRsiStatus = await postRoute(endpoint, "/rsi/status", verifierToken);
  assert.equal(verifierOnRsiStatus.status, 401, "/rsi/status is an operator observation route — the verifier credential must not serve it");
  assert.deepEqual(verifierOnRsiStatus.body, { error: "unauthorized" });

  // The reverse direction: the OPERATOR token on the verifier-only routes —
  // the consequential autonomous actions (P1-1). Authorization precedes body
  // parsing and dispatch (hub-http.ts:98 → 100), so these pins move no state.
  const operatorOnRunReview = await postRoute(endpoint, "/run/review", token);
  assert.equal(operatorOnRunReview.status, 401, "/run/review requires the verifier credential");
  assert.deepEqual(operatorOnRunReview.body, { error: "unauthorized" });

  const operatorOnRunFinish = await postRoute(endpoint, "/run/finish", token);
  assert.equal(operatorOnRunFinish.status, 401, "/run/finish requires the verifier credential");
  assert.deepEqual(operatorOnRunFinish.body, { error: "unauthorized" });

  const operatorOnScheduleRunNow = await postRoute(endpoint, "/schedule/run-now", token);
  assert.equal(operatorOnScheduleRunNow.status, 401, "/schedule/run-now requires the verifier credential — it fires a real run");
  assert.deepEqual(operatorOnScheduleRunNow.body, { error: "unauthorized" });

  // /rsi/start — OUT OF BOUNDS to call with the verifier credential (the most
  // consequential autonomous action: it arms the loop). The auth gate is
  // pinned with the WRONG token class only, and with a MALFORMED body: still
  // 401 (never 500), proving the token gate precedes body parsing
  // (hub-http.ts:98 before the readJson at hub-http.ts:100).
  const operatorOnRsiStart = await fetch(`${endpoint}/rsi/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{malformed",
  });
  assert.equal(operatorOnRsiStart.status, 401, "/rsi/start refuses the operator token before even parsing its body");
  assert.deepEqual(await operatorOnRsiStart.json(), { error: "unauthorized" });

  // The verifier credential cannot BEGIN a run either — begin is the operator
  // side of the run lifecycle (hub-http.ts:97: /run/begin is not verifierOnly).
  const verifierOnRunBegin = await postRoute(endpoint, "/run/begin", verifierToken);
  assert.equal(verifierOnRunBegin.status, 401, "/run/begin requires the operator token — the verifier credential must not begin runs");
  assert.deepEqual(verifierOnRunBegin.body, { error: "unauthorized" });

  // ── /snapshot: re-observed, compact (the full envelope deep-equal is
  // W128's pin — not repeated here) ────────────────────────────────────────
  const snapshotResponse = await postRoute(endpoint, "/snapshot", token);
  assert.equal(
    snapshotResponse.status,
    200,
    `the operator snapshot is served — observed ${snapshotResponse.status}: ${JSON.stringify(snapshotResponse.body)}`,
  );
  const snapshotBody = snapshotResponse.body as {
    snapshot: Record<string, unknown>;
    gateObservability: Record<string, unknown>;
  };
  assert.equal(snapshotBody.snapshot.enforcementLevel, "enforced", "the hub composes authoritativePreMutation (src/cli/hub.ts:60)");
  assert.deepEqual(
    snapshotBody.snapshot.tasks,
    [],
    "a fresh hub serves an EMPTY tasks projection — the seeded placeholder is suppressed by hiddenSnapshotTaskIds (W128's pinned truth, re-observed live)",
  );
  assert.ok(
    snapshotBody.gateObservability !== undefined,
    "run-gate observability rides alongside the projection (W128's pin — presence re-observed)",
  );

  // ── The schedule routes on a fresh hub (registry composed — src/cli/hub.ts:
  // 156-161 — so these are 200-shaped; a hub without `schedules` would 404
  // them, workflow-hub.ts:84-86) ───────────────────────────────────────────
  const freshList = await postRoute(endpoint, "/schedule/list", token);
  assert.equal(freshList.status, 200);
  assert.deepEqual(
    freshList.body,
    { schedules: [] },
    "an absent schedule table means no schedules (hub-scheduler.ts:215-223) — observed on a fresh hub",
  );

  const definition = {
    id: "w133-probe-schedule",
    title: "W133 probe schedule",
    cron: "5 5 * * *",
    prompt: "never fired by this probe",
  };
  const saved = await postRoute(endpoint, "/schedule/save", token, definition);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { schedules: [definition] }, "the saved definition is echoed back through the registry");
  // The registry is the single live authority over the persisted table
  // (schedule-registry.ts:7-19): the save is visible to the very next list
  // AND persisted to the WORKFLOW_HUB_SCHEDULES file before admission.
  const listedAfterSave = await postRoute(endpoint, "/schedule/list", token);
  assert.deepEqual(listedAfterSave.body, { schedules: [definition] }, "the save is visible to the next list without a hub restart");
  assert.deepEqual(
    JSON.parse(readFileSync(schedulesPath, "utf8")),
    { version: 1, schedules: [definition] },
    "the registry persists the table (saveSchedulesTable, hub-scheduler.ts:239-244)",
  );

  // Route-level refusal: a missing required field is the route's 400
  // (hub-http.ts:202-204), not the registry's.
  const missingCron = await postRoute(endpoint, "/schedule/save", token, { id: "w133-no-cron", title: "no cron", prompt: "x" });
  assert.equal(missingCron.status, 400);
  assert.deepEqual(missingCron.body, { error: "invalid schedule save request" });

  // Registry-level refusal: a well-shaped body with an invalid cron reaches
  // the registry and comes back through the route's client-error catch
  // (hub-http.ts:205-212) — a 400, never a partially-admitted schedule.
  const badCron = await postRoute(endpoint, "/schedule/save", token, { id: "w133-bad-cron", title: "bad cron", cron: "not-a-cron", prompt: "x" });
  assert.equal(badCron.status, 400, "an invalid cron is a CLIENT error (hub-http.ts:208-211), never a server fault");
  assert.equal(
    badCron.body.error,
    "invalid cron expression (expected 5 fields): 'not-a-cron'",
    `the registry's validation message surfaces — observed: ${JSON.stringify(badCron.body)}`,
  );
  const afterBadCron = await postRoute(endpoint, "/schedule/list", token);
  assert.deepEqual(
    afterBadCron.body,
    { schedules: [definition] },
    "a rejected save leaves the table untouched (schedule-registry.ts:40-45 — persist before admit)",
  );

  const removed = await postRoute(endpoint, "/schedule/delete", token, { id: "w133-probe-schedule" });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { schedules: [] }, "the delete removes exactly the named schedule");
  const listedAfterDelete = await postRoute(endpoint, "/schedule/list", token);
  assert.deepEqual(listedAfterDelete.body, { schedules: [] });

  // ── The self-improvement routes on a fresh hub (registry composed even
  // with WORKFLOW_RSI_AGENT=0 — hub.ts:249-264 arms only the runner) ───────
  const rsiStatus = await postRoute(endpoint, "/rsi/status", token);
  assert.equal(rsiStatus.status, 200);
  assert.deepEqual(
    rsiStatus.body,
    { loops: [] },
    "a fresh hub has never run a loop — the fail-closed stub starts nothing, and status() is empty",
  );

  const rsiStatusUnknown = await postRoute(endpoint, "/rsi/status", token, { id: "rsi-loop:missing" });
  assert.equal(rsiStatusUnknown.status, 200);
  assert.deepEqual(
    rsiStatusUnknown.body,
    { loop: null },
    "an unknown loop id is an explicit null (hub-http.ts:181-183), not a 404 and not an error",
  );

  const rsiCancel = await postRoute(endpoint, "/rsi/cancel", token, {});
  assert.equal(rsiCancel.status, 200);
  assert.deepEqual(rsiCancel.body, { cancelled: false }, "an empty cancel on a fresh hub is an honest false (nothing to cancel)");

  // ── The trailing 404 and the malformed-body classification ──────────────
  const unknownRoute = await postRoute(endpoint, "/definitely-not-a-hub-route", token);
  assert.equal(unknownRoute.status, 404);
  assert.deepEqual(unknownRoute.body, { error: "not found" }, "an unknown route falls through to the honest 404 (hub-http.ts:268)");

  // An EMPTY-body request (no bytes at all): readJson's for-await sees zero
  // chunks and JSON.parse("") throws into the catch-all — OBSERVED 500, the
  // server-fault shape for what is arguably a client payload error
  // (hub-http.ts:269-271). Recorded as a finding, not fixed.
  const emptyBody = await fetch(`${endpoint}/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  assert.equal(emptyBody.status, 500, "OBSERVED: an empty-body request earns the 500 catch-all (hub-http.ts:269-271) — recorded as a finding, not fixed");
  assert.deepEqual(
    await emptyBody.json(),
    { error: "Unexpected end of JSON input" },
    "the client payload error surfaces verbatim through the server-fault shape",
  );

  // ── Teardown (the skeleton is W128's; the deep guarded-shutdown contract is
  // pinned there — here it is re-observed because this probe owns its hub) ─
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
  // New teardown truth for THIS contract: the persisted schedule table is
  // operator state — hub.close() unlinks only discovery.json, verifier.json,
  // and the lock dir (workflow-hub.ts:175-181), so the table survives.
  assert.ok(existsSync(schedulesPath), "the persisted schedule table is NOT unlinked by the teardown — operator state outlives the hub");
  assert.deepEqual(
    JSON.parse(readFileSync(schedulesPath, "utf8")),
    { version: 1, schedules: [] },
    "and the surviving table holds exactly the post-delete state",
  );
});