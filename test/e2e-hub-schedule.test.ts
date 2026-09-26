import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { distArtifact, ensureFresh, ensureToolboxGuardBuilt, repoRoot } from "./fixtures/compiled-dist.js";

// W139 — the hub's schedule WRITE lifecycle e2e (multi-process). W133 pinned
// the route-LEVEL contract on a fresh hub (the token matrix, one save/list/
// delete round trip, both refusal classes); this file goes deeper on the
// write lifecycle and its persistence, per the wave conventions of
// TASKS.md's W133/W134/W136/W137 entries. Pinned from
// src/integrations/hub-http.ts, src/integrations/schedule-registry.ts,
// src/integrations/hub-scheduler.ts, src/cli/hub.ts, and
// src/integrations/run-registry.ts, observed live against the real
// multi-process seat — LESS-0054's rule: run first, pin the OBSERVED truth,
// never the shape the source suggested:
//   - the save → list → delete round trip through the live W074 registry
//     (schedule-registry.ts:54-65 upserts by id and filters on remove; both
//     persist BEFORE admitting — persist, schedule-registry.ts:40-45), with
//     the registry's persisted-file contract deep-equal after every write
//     ({ version: 1, schedules: [...] }, saveSchedulesTable
//     hub-scheduler.ts:239-244, atomic 0o600);
//   - /schedule/run-now against a LIVE hub with the VERIFIER credential
//     (hub-http.ts:92-97: run-now is the only verifier-gated schedule route;
//     /schedule/save|list|delete are operator routes — both directions
//     pinned). An ABSENT id answers the honest 200 { fired: false }
//     (hub-scheduler.ts:449-458: the id must resolve). A PRESENT id is fired
//     WITHOUT ever letting it reach agent work: the definition's workspace
//     declaration cannot canonicalize (run-registry.ts:88-94 throws for a
//     non-existent directory), so the scheduler's fireOnce refuses at
//     controller.begin — BEFORE the runTurn seam that composes the ACP
//     runtime (hub-scheduler.ts:351-375: the begin-failure catch logs and
//     returns; no run task is ever created, /snapshot proves it). The route
//     still answers 200 { fired: true } — "fired" means the id RESOLVED
//     (hub-scheduler.ts:294-301), not that a run began. Belt-and-braces
//     against any clock fire while a minute-timer hub is live: the cron
//     "0 0 31 2 *" can never match a real date (Feb 31 does not exist) and
//     the run-now target is saved enabled: false (tick skips paused
//     schedules, hub-scheduler.ts:424) — while run-now deliberately bypasses
//     BOTH (the W074 pause rule, hub-scheduler.ts:294-297). The clock path
//     itself is NEVER exercised in this file.
//   - the refusal classes, observed first: the route-level 400 for a missing
//     required string field or a non-record body (hub-http.ts:202-204 with
//     isRecord at hub-http.ts:309-311) and the registry-level 400s surfaced
//     through the route's client-error catch (hub-http.ts:205-212): the
//     per-field cron bounds ("invalid cron minute value: '61'", "invalid
//     cron day-of-month value: '32'"), a whitespace-only title, an empty id
//     (which the save route's shape check ADMITS — its sibling delete/run-now
//     routes carry a length check, hub-http.ts:216/223, save does not — and
//     the registry refuses), a mistyped optional field, a bad taskClass. A
//     rejected save never partially admits (list pinned unchanged).
//   - the W134 body contract on a WRITE route (the polish landed
//     2026-09-25): an EMPTY body and a malformed body answer 400 with the
//     named requirement ("a JSON request body is required (send {} for read
//     routes)", hub-http.ts:278-307) and an oversized body (>1 MiB) answers
//     400 "Workflow hub request is too large" (hub-http.ts:295) — all
//     client-class through the catch-all's 400/500 split (hub-http.ts:269-275),
//     never the pre-W134 500.
//   - persistence: WITH WORKFLOW_HUB_SCHEDULES the table lands at the
//     explicit seat (src/cli/hub.ts:156-161); WITHOUT the env the default is
//     <HOME>/.workflow/scheduler.json (hub.ts:160 — scheduler.json beside
//     the hub/ tree, not inside it) — both observed. A saved schedule
//     survives a hub STOP (the guarded teardown exits 0, unlinks
//     discovery.json + verifier.json + the lock — workflow-hub.ts:175-181 —
//     and deliberately does NOT unlink the schedule table) and is served by
//     a RESTARTED hub in the same redirected HOME with freshly re-issued
//     credentials. W133 pinned the surviving FILE; this file pins the
//     surviving CONTRACT (the restart).
// Findings recorded here, NOT fixed (report-only mandate):
//   (a) save persists UNKNOWN definition fields verbatim — requireSchedule
//       validates only the known keys and returns the entry as-is
//       (hub-scheduler.ts:246-286), so any extra field round-trips into the
//       table and every later list. No schema rejection. Recorded, not
//       blessed.
//   (b) a run-now fire that fails at begin is indistinguishable from a
//       successful fire at the route level — 200 { fired: true } either way;
//       the only signal is the hub's own stdout log line. An observability
//       gap, recorded.
//   (c) delete of an UNKNOWN id is a silent 200 no-op (remove filters a
//       table the id is not in, schedule-registry.ts:62-65) — idempotent,
//       but an operator id typo is never surfaced. Recorded.
// Safety contract (LESS-0051, non-negotiable): no agent or PTY spawns ever —
// every child is the compiled hub itself (the guard MCP grandchild it
// composes at startup is the product's own fail-closed composition). The one
// run-now fire is landed on a begin-refusing definition, so the turn seam is
// unreachable; /rsi/start is never called at all. All hub state under
// redirected mkdtemp HOMEs (discovery/verifier/lock/provenance/schedules);
// port 0 (hub-http.ts:61); async spawn → both banners → pins → process-group
// SIGTERM → pinned exit 0 + unlink truth — the hub is never
// spawnSync-timeout-killed. Focused-file runs only (no npm test full suite).
// The W120 vendored-gate remedy lives in the shared fixture
// (ensureToolboxGuardBuilt) — the hub refuses to run without its guard.

const sleep = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

interface HubExit {
  readonly code: number | null;
  readonly signal: string | null;
}

interface HubSeat {
  readonly endpoint: string;
  readonly discoveryPath: string;
  readonly verifierPath: string;
  readonly token: string;
  readonly verifierToken: string;
  output(): string;
  killGroup(signal: NodeJS.Signals): void;
  readonly exit: Promise<HubExit>;
}

/** Spawn the compiled hub under a redirected HOME (the W128/W133 skeleton,
 * reused rather than reinvented): async spawn leading its own process group,
 * wait for BOTH banners, read both credentials from the discovery seat, and
 * arm the after-hook hard-kill so a mid-probe assertion failure leaves no
 * hub or guard behind. `schedulesPath` given → the WORKFLOW_HUB_SCHEDULES
 * override; undefined → the ambient override is STRIPPED so the hub composes
 * its default seat. The Checkpoint F stub (WORKFLOW_RSI_AGENT=0) keeps every
 * loop lane fail-closed, as in W128/W133. */
async function spawnHub(context: TestContext, home: string, schedulesPath?: string): Promise<HubSeat> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    WORKFLOW_RSI_AGENT: "0",
    WORKFLOW_HUB_PROVENANCE: join(home, "provenance.jsonl"),
  };
  if (schedulesPath === undefined) delete env.WORKFLOW_HUB_SCHEDULES;
  else env.WORKFLOW_HUB_SCHEDULES = schedulesPath;
  // Determinism (W128/W133): these operator seams would change hub behavior
  // if inherited, so the probe strips them instead of pinning the ambient
  // machine's values.
  delete env.WORKFLOW_HUB_REQUEST_LOG;
  delete env.WORKFLOW_TEAM_TASK_VERIFY_COMMAND;

  let output = "";
  let exitInfo: HubExit | undefined;
  const child = spawn(process.execPath, [distArtifact("cli", "hub.js")], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const killGroup = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* already exited */
    }
  };
  const exitPromise = new Promise<HubExit>((resolveExit) => {
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
  assert.equal(
    discoveryPath,
    join(home, ".workflow", "hub", "discovery.json"),
    "the discovery file lands under the redirected HOME — the probe's isolation seam",
  );
  assert.ok(existsSync(discoveryPath), `the hub's own banner names its discovery file, and it exists: ${discoveryPath}`);
  const discovery = JSON.parse(readFileSync(discoveryPath, "utf8")) as { token: string };
  const token = discovery.token;
  assert.match(token, /^[0-9a-f]{64}$/);
  const verifierPath = join(dirname(discoveryPath), "verifier.json");
  assert.ok(existsSync(verifierPath), `the verifier discovery is published beside discovery.json: ${verifierPath}`);
  const verifier = JSON.parse(readFileSync(verifierPath, "utf8")) as { token: string };
  const verifierToken = verifier.token;
  assert.match(verifierToken, /^[0-9a-f]{64}$/);
  assert.notEqual(verifierToken, token, "the verifier token is a distinct credential");

  return {
    endpoint,
    discoveryPath,
    verifierPath,
    token,
    verifierToken,
    output: () => output,
    killGroup,
    exit: exitPromise,
  };
}

/** The schedule routes' wire shape: POST + Bearer with a JSON body — every
 * route except /health parses a JSON body after the auth gate (readJson,
 * hub-http.ts:100), so the helper always sends "{}" unless the caller
 * overrides (LESS-0054's protocol). */
async function postRoute(
  endpoint: string,
  path: string,
  token: string,
  body: unknown = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Wait until the hub's captured output carries the marker (the scheduler's
 * log lines go through console.log, whose pipe writes are asynchronous —
 * poll, never assume ordering). */
async function waitForLog(output: () => string, marker: string, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !output().includes(marker)) await sleep(100);
  assert.ok(output().includes(marker), `${description} — hub output tail: ${output().slice(-1200)}`);
}

/** SIGTERM the process group, await the guarded shutdown, and pin the exit
 * truth (the hub must die by its own teardown handler, exit 0, never by a
 * signal). The discovery/verifier unlink wait is included; each test pins
 * its own additional teardown truth (lock, surviving schedule table). */
async function cleanTeardown(seat: HubSeat): Promise<void> {
  seat.killGroup("SIGTERM");
  const hardKill = setTimeout(() => seat.killGroup("SIGKILL"), 15_000);
  const finalExit = await seat.exit;
  clearTimeout(hardKill);
  assert.equal(finalExit.signal, null, `the hub died by ${finalExit.signal} instead of its own SIGTERM teardown — output: ${seat.output().slice(0, 600)}`);
  assert.equal(finalExit.code, 0, `the hub's guarded shutdown exits 0 — output: ${seat.output().slice(0, 600)}`);
  const unlinkDeadline = Date.now() + 10_000;
  while (Date.now() < unlinkDeadline && (existsSync(seat.discoveryPath) || existsSync(seat.verifierPath))) {
    await sleep(100);
  }
  assert.ok(!existsSync(seat.discoveryPath), `discovery.json is unlinked after the clean teardown (still present at ${seat.discoveryPath})`);
  assert.ok(!existsSync(seat.verifierPath), `verifier.json is unlinked after the clean teardown (still present at ${seat.verifierPath})`);
}

test("W139: the schedule write lifecycle — save echo, list deep-equal, both refusal classes, the W134 body contract, and a verifier-gated run-now that refuses before any agent work", async (context) => {
  ensureFresh(distArtifact("cli", "hub.js"));
  ensureToolboxGuardBuilt();

  const home = mkdtempSync(join(tmpdir(), "w139-hub-schedule-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const schedulesPath = join(home, "schedules.json");
  const seat = await spawnHub(context, home, schedulesPath);

  // ── Fresh table ──────────────────────────────────────────────────────────
  const freshList = await postRoute(seat.endpoint, "/schedule/list", seat.token);
  assert.equal(freshList.status, 200);
  assert.deepEqual(freshList.body, { schedules: [], recentRuns: [] }, "an absent schedule table means no schedules (hub-scheduler.ts:215-223); W153's recent-runs block rides the same response");

  // ── The schedule family's token-class matrix, both directions ────────────
  // hub-http.ts:92-97: /schedule/run-now is verifier-only (P1-1 — the
  // ordinary token's blast radius must not include firing a scheduled run);
  // save/list/delete are operator routes. A verifier credential on an
  // operator route is refused 401 — the split is not a privilege ladder.
  const verifierOnSave = await postRoute(seat.endpoint, "/schedule/save", seat.verifierToken, {
    id: "w139-verifier-save", title: "refused", cron: "5 5 * * *", prompt: "never admitted",
  });
  assert.equal(verifierOnSave.status, 401, "/schedule/save is an operator route — the verifier credential must not serve it");
  assert.deepEqual(verifierOnSave.body, { error: "unauthorized" });

  const verifierOnList = await postRoute(seat.endpoint, "/schedule/list", seat.verifierToken);
  assert.equal(verifierOnList.status, 401);
  assert.deepEqual(verifierOnList.body, { error: "unauthorized" });

  const verifierOnDelete = await postRoute(seat.endpoint, "/schedule/delete", seat.verifierToken, { id: "w139-verifier-delete" });
  assert.equal(verifierOnDelete.status, 401);
  assert.deepEqual(verifierOnDelete.body, { error: "unauthorized" });

  // The reverse direction: the operator token on the verifier-only route,
  // with a MALFORMED body — still 401, proving the token gate precedes body
  // parsing (hub-http.ts:98 before the readJson at hub-http.ts:100), so this
  // pin moves no hub state and dispatches nothing.
  const operatorOnRunNow = await fetch(`${seat.endpoint}/schedule/run-now`, {
    method: "POST",
    headers: { authorization: `Bearer ${seat.token}`, "content-type": "application/json" },
    body: "{malformed",
  });
  assert.equal(operatorOnRunNow.status, 401, "/schedule/run-now refuses the operator token before even parsing its body");
  assert.deepEqual(await operatorOnRunNow.json(), { error: "unauthorized" });

  const untouchedAfterMatrix = await postRoute(seat.endpoint, "/schedule/list", seat.token);
  assert.deepEqual(untouchedAfterMatrix.body, { schedules: [], recentRuns: [] }, "the 401 matrix moved no state");

  // ── Save → list → persisted file ─────────────────────────────────────────
  const definition = {
    id: "w139-probe-schedule",
    title: "W139 probe schedule",
    cron: "0 0 31 2 *",
    prompt: "never fired by this probe",
  };
  const saved = await postRoute(seat.endpoint, "/schedule/save", seat.token, definition);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { schedules: [definition] }, "the saved definition is echoed back through the registry");
  const listedAfterSave = await postRoute(seat.endpoint, "/schedule/list", seat.token);
  assert.deepEqual(listedAfterSave.body, {
    schedules: [{ ...definition, lineage: { scheduleId: definition.id, title: definition.title, causedRuns: 0, lastOutcome: "unrun", tombstoned: false } }],
    recentRuns: [],
  }, "the save is visible to the very next list; W153's lineage rides per entry (registry-sourced: never fired, never a fabricated outcome)");
  assert.deepEqual(
    JSON.parse(readFileSync(schedulesPath, "utf8")),
    { version: 1, schedules: [definition] },
    "the registry persists the table to the WORKFLOW_HUB_SCHEDULES seat before admitting (saveSchedulesTable, hub-scheduler.ts:239-244)",
  );

  // Finding (a), observed live: an UNKNOWN field rides through save into the
  // persisted table — requireSchedule validates only the known keys and
  // returns the entry as-is (hub-scheduler.ts:246-286). Recorded, not fixed.
  const extraDefinition = {
    id: "w139-extra-field",
    title: "extra field carrier",
    cron: "0 0 31 2 *",
    prompt: "carries a field the schema does not know",
    unknownField: "not-in-the-schema",
  };
  const savedExtra = await postRoute(seat.endpoint, "/schedule/save", seat.token, extraDefinition);
  assert.equal(savedExtra.status, 200, "OBSERVED: an unknown definition field is admitted verbatim (finding (a))");
  assert.deepEqual(savedExtra.body, { schedules: [definition, extraDefinition] });
  assert.deepEqual(
    JSON.parse(readFileSync(schedulesPath, "utf8")),
    { version: 1, schedules: [definition, extraDefinition] },
    "and the unknown field persists verbatim into the table file",
  );

  // ── Refusals: route-level then registry-level ────────────────────────────
  // Route-level 400: a missing required field never reaches the registry
  // (hub-http.ts:202-204).
  const missingCron = await postRoute(seat.endpoint, "/schedule/save", seat.token, { id: "w139-no-cron", title: "no cron", prompt: "x" });
  assert.equal(missingCron.status, 400);
  assert.deepEqual(missingCron.body, { error: "invalid schedule save request" });

  // Route-level 400: a non-record body (an array) — isRecord refuses it
  // (hub-http.ts:309-311).
  const arrayBody = await postRoute(seat.endpoint, "/schedule/save", seat.token, ["not-a-record"]);
  assert.equal(arrayBody.status, 400);
  assert.deepEqual(arrayBody.body, { error: "invalid schedule save request" });

  // Registry-level 400s through the route's client-error catch
  // (hub-http.ts:205-212): well-shaped bodies that the registry's
  // requireSchedule rejects (hub-scheduler.ts:246-286). Per-field cron
  // bounds first — two distinct field classes.
  const badMinute = await postRoute(seat.endpoint, "/schedule/save", seat.token, { id: "w139-bad-minute", title: "x", cron: "61 * * * *", prompt: "x" });
  assert.equal(badMinute.status, 400, "an out-of-bounds cron minute is a CLIENT error, never a server fault");
  assert.equal(badMinute.body.error, "invalid cron minute value: '61'", `the registry's per-field message surfaces — observed: ${JSON.stringify(badMinute.body)}`);

  const badDayOfMonth = await postRoute(seat.endpoint, "/schedule/save", seat.token, { id: "w139-bad-dom", title: "x", cron: "0 0 32 1 *", prompt: "x" });
  assert.equal(badDayOfMonth.status, 400);
  assert.equal(badDayOfMonth.body.error, "invalid cron day-of-month value: '32'", `observed: ${JSON.stringify(badDayOfMonth.body)}`);

  // A whitespace-only title passes the ROUTE's string check and is refused
  // by the REGISTRY's non-empty check (hub-scheduler.ts:249-253).
  const whitespaceTitle = await postRoute(seat.endpoint, "/schedule/save", seat.token, { id: "w139-blank-title", title: "   ", cron: "0 0 31 2 *", prompt: "x" });
  assert.equal(whitespaceTitle.status, 400);
  assert.equal(whitespaceTitle.body.error, "invalid schedule table: title must be a non-empty string");

  // An EMPTY id is the route/registry split observed: the save route's shape
  // check admits it (hub-http.ts:202 checks typeof only), the registry
  // refuses — the mirror image of delete/run-now, whose route-level checks
  // DO carry the length rule (hub-http.ts:216, 223).
  const emptyId = await postRoute(seat.endpoint, "/schedule/save", seat.token, { id: "", title: "x", cron: "0 0 31 2 *", prompt: "x" });
  assert.equal(emptyId.status, 400);
  assert.equal(emptyId.body.error, "invalid schedule table: id must be a non-empty string");

  // A mistyped optional field and a bad taskClass: registry-level.
  const mistypedWorkspace = await postRoute(seat.endpoint, "/schedule/save", seat.token, { id: "w139-bad-workspace", title: "x", cron: "0 0 31 2 *", prompt: "x", workspace: 42 });
  assert.equal(mistypedWorkspace.status, 400);
  assert.equal(mistypedWorkspace.body.error, "invalid schedule table: workspace must be a string");

  const badTaskClass = await postRoute(seat.endpoint, "/schedule/save", seat.token, { id: "w139-bad-task-class", title: "x", cron: "0 0 31 2 *", prompt: "x", taskClass: "nonsense" });
  assert.equal(badTaskClass.status, 400);
  assert.equal(badTaskClass.body.error, "invalid schedule table: taskClass must be coding, general, or batch");

  const afterRefusals = await postRoute(seat.endpoint, "/schedule/list", seat.token);
  assert.deepEqual(
    afterRefusals.body,
    {
      schedules: [definition, extraDefinition].map((entry) => ({
        ...entry,
        lineage: { scheduleId: entry.id, title: entry.title, causedRuns: 0, lastOutcome: "unrun", tombstoned: false },
      })),
      recentRuns: [],
    },
    "every rejected save left the table untouched (persist before admit, schedule-registry.ts:40-45)",
  );

  // ── The W134 body contract on a WRITE route (polish landed 2026-09-25) ───
  const emptyBody = await fetch(`${seat.endpoint}/schedule/save`, {
    method: "POST",
    headers: { authorization: `Bearer ${seat.token}`, "content-type": "application/json" },
  });
  assert.equal(emptyBody.status, 400, "an empty body on a write route is the same client-class 400 (W134)");
  assert.deepEqual(
    await emptyBody.json(),
    { error: "a JSON request body is required (send {} for read routes)" },
    "the body requirement is named, not surfaced as a parse error",
  );

  const malformedBody = await fetch(`${seat.endpoint}/schedule/save`, {
    method: "POST",
    headers: { authorization: `Bearer ${seat.token}`, "content-type": "application/json" },
    body: "{malformed",
  });
  assert.equal(malformedBody.status, 400);
  assert.deepEqual(await malformedBody.json(), { error: "a JSON request body is required (send {} for read routes)" });

  // An oversized body (>1 MiB) throws before JSON.parse (hub-http.ts:295) —
  // still the client class, still 400, with the oversize requirement named.
  const oversizedBody = await fetch(`${seat.endpoint}/schedule/save`, {
    method: "POST",
    headers: { authorization: `Bearer ${seat.token}`, "content-type": "application/json" },
    body: "x".repeat(1024 * 1024 + 1),
  });
  assert.equal(oversizedBody.status, 400, "an oversized body is a client fault (hub-http.ts:295), never the pre-W134 500");
  assert.deepEqual(await oversizedBody.json(), { error: "Workflow hub request is too large" });

  // ── /schedule/run-now ────────────────────────────────────────────────────
  // ABSENT id with the verifier credential: the honest false — the id must
  // resolve (hub-scheduler.ts:449-458); observed 200, not an error.
  const absentRunNow = await postRoute(seat.endpoint, "/schedule/run-now", seat.verifierToken, { id: "w139-absent-schedule" });
  assert.equal(absentRunNow.status, 200);
  assert.deepEqual(absentRunNow.body, { fired: false }, "an unknown id is an honest fired:false, not an error");

  // Route-level refusal: a body without a string id is 400 before the
  // registry (hub-http.ts:223-225).
  const runNowNoId = await postRoute(seat.endpoint, "/schedule/run-now", seat.verifierToken, {});
  assert.equal(runNowNoId.status, 400);
  assert.deepEqual(runNowNoId.body, { error: "invalid schedule run-now request" });

  // PRESENT id, landlocked so the fire can never reach agent work: the
  // workspace declaration cannot canonicalize (run-registry.ts:88-94), the
  // cron can never match a real date, and the definition is paused —
  // run-now bypasses both pause and cron (that IS the W074 rule), but the
  // fire still refuses at controller.begin, before the runTurn seam that
  // would compose an ACP runtime (hub-scheduler.ts:351-375). Nothing spawns.
  const absentWorkspace = join(home, "workspace-that-does-not-exist");
  const runNowTarget = {
    id: "w139-run-now-target",
    title: "run-now refusal probe",
    cron: "0 0 31 2 *",
    prompt: "never reaches an agent",
    workspace: absentWorkspace,
    enabled: false,
  };
  const savedTarget = await postRoute(seat.endpoint, "/schedule/save", seat.token, runNowTarget);
  assert.equal(savedTarget.status, 200);
  assert.deepEqual(savedTarget.body, { schedules: [definition, extraDefinition, runNowTarget] });

  const fired = await postRoute(seat.endpoint, "/schedule/run-now", seat.verifierToken, { id: runNowTarget.id });
  assert.equal(fired.status, 200);
  assert.deepEqual(
    fired.body,
    { fired: true },
    "OBSERVED: fired:true means the id RESOLVED — run-now bypasses the paused flag and the never-matching cron (finding (b): a begin-failure is indistinguishable at the route)",
  );
  await waitForLog(
    seat.output,
    `scheduler '${runNowTarget.id}': could not begin run: declared workspace is not an existing directory: ${absentWorkspace}`,
    "the fire refused at controller.begin, BEFORE the turn seam — no agent runtime was ever composed (hub-scheduler.ts:371-375)",
  );

  // The refused fire left no run state: no run task in the projection, and
  // no blocking reason recorded (the begin-failure path returns before
  // recordBlockingReason is ever reached).
  const snapshotAfterFire = await postRoute(seat.endpoint, "/snapshot", seat.token);
  assert.equal(snapshotAfterFire.status, 200);
  const snapshotBody = snapshotAfterFire.body as {
    snapshot: { tasks: unknown[] };
    gateObservability: Record<string, unknown> | undefined;
  };
  assert.ok(snapshotBody.gateObservability !== undefined, "run-gate observability rides alongside the projection");
  assert.deepEqual(snapshotBody.snapshot.tasks, [], "the refused fire created no run task");
  assert.deepEqual(
    snapshotBody.gateObservability.blockingReasons,
    {},
    "and recorded no blocking reason — the refusal happened before the run existed",
  );

  // ── Deletes ──────────────────────────────────────────────────────────────
  const deleteNoId = await postRoute(seat.endpoint, "/schedule/delete", seat.token, {});
  assert.equal(deleteNoId.status, 400);
  assert.deepEqual(deleteNoId.body, { error: "invalid schedule delete request" });

  const deleteEmptyId = await postRoute(seat.endpoint, "/schedule/delete", seat.token, { id: "" });
  assert.equal(deleteEmptyId.status, 400);
  assert.deepEqual(deleteEmptyId.body, { error: "invalid schedule delete request" }, "the delete route DOES carry the non-empty id rule (hub-http.ts:216) — save does not");

  // Finding (c), observed live: deleting an UNKNOWN id is a silent 200 no-op.
  const deleteUnknown = await postRoute(seat.endpoint, "/schedule/delete", seat.token, { id: "w139-never-saved" });
  assert.equal(deleteUnknown.status, 200, "OBSERVED: an unknown-id delete is a silent 200 no-op (finding (c))");
  assert.deepEqual(deleteUnknown.body, { schedules: [definition, extraDefinition, runNowTarget] }, "and the table is returned unchanged");

  const removedExtra = await postRoute(seat.endpoint, "/schedule/delete", seat.token, { id: extraDefinition.id });
  assert.equal(removedExtra.status, 200);
  assert.deepEqual(removedExtra.body, { schedules: [definition, runNowTarget] }, "the delete removes exactly the named schedule");

  const removedTarget = await postRoute(seat.endpoint, "/schedule/delete", seat.token, { id: runNowTarget.id });
  assert.deepEqual(removedTarget.body, { schedules: [definition] });

  const removedDefinition = await postRoute(seat.endpoint, "/schedule/delete", seat.token, { id: definition.id });
  assert.deepEqual(removedDefinition.body, { schedules: [] });

  const listedAfterDelete = await postRoute(seat.endpoint, "/schedule/list", seat.token);
  assert.deepEqual(listedAfterDelete.body, { schedules: [], recentRuns: [] }, "the lifecycle ends with a clean list");
  assert.deepEqual(
    JSON.parse(readFileSync(schedulesPath, "utf8")),
    { version: 1, schedules: [] },
    "and the persisted table holds exactly the post-delete state",
  );

  // ── Teardown: the schedule table is operator state that survives ─────────
  await cleanTeardown(seat);
  const lockDir = join(home, ".workflow", "hub", "lock");
  assert.ok(!existsSync(lockDir), `the single-instance lock dir is released after the clean teardown (still present at ${lockDir})`);
  assert.ok(existsSync(schedulesPath), "the persisted schedule table is NOT unlinked by the teardown — operator state outlives the hub (workflow-hub.ts:175-181)");
  assert.deepEqual(JSON.parse(readFileSync(schedulesPath, "utf8")), { version: 1, schedules: [] });
});

test("W139: the schedule table's default seat and its persistence across a hub stop + restart in the same redirected HOME", async (context) => {
  ensureFresh(distArtifact("cli", "hub.js"));
  ensureToolboxGuardBuilt();

  const home = mkdtempSync(join(tmpdir(), "w139-hub-schedule-restart-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));

  // NO WORKFLOW_HUB_SCHEDULES: the hub composes the DEFAULT seat (the
  // ambient override is stripped by the spawner — observed, not assumed).
  const first = await spawnHub(context, home);

  // Landlocked from birth: even if a minute-tick ever evaluated this
  // schedule (it cannot — Feb 31 never matches), the fire would refuse at
  // controller.begin before any turn seam.
  const definition = {
    id: "w139-persistent",
    title: "W139 persistent schedule",
    cron: "0 0 31 2 *",
    prompt: "survives a hub restart",
    workspace: join(home, "workspace-that-does-not-exist"),
  };

  const freshList = await postRoute(first.endpoint, "/schedule/list", first.token);
  assert.equal(freshList.status, 200);
  assert.deepEqual(freshList.body, { schedules: [], recentRuns: [] }, "the default seat is empty at composition (an absent table means no schedules)");

  const saved = await postRoute(first.endpoint, "/schedule/save", first.token, definition);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { schedules: [definition] });

  // OBSERVED default seat: <HOME>/.workflow/scheduler.json (src/cli/hub.ts:160)
  // — beside the hub/ tree, not inside it, and NOT the
  // WORKFLOW_HUB_SCHEDULES override this test deliberately left unset.
  const defaultSeat = join(home, ".workflow", "scheduler.json");
  assert.ok(existsSync(defaultSeat), `without WORKFLOW_HUB_SCHEDULES the table persists at the default seat: ${defaultSeat}`);
  assert.deepEqual(
    JSON.parse(readFileSync(defaultSeat, "utf8")),
    { version: 1, schedules: [definition] },
    "the default seat carries exactly the saved definition",
  );

  const firstToken = first.token;
  const firstVerifierToken = first.verifierToken;
  await cleanTeardown(first);
  const lockDir = join(home, ".workflow", "hub", "lock");
  assert.ok(!existsSync(lockDir), "the lock is released on the stop");
  assert.ok(existsSync(defaultSeat), "the default-seat table survives the clean teardown (hub.close() unlinks only discovery/verifier/lock)");
  assert.deepEqual(JSON.parse(readFileSync(defaultSeat, "utf8")), { version: 1, schedules: [definition] });

  // ── RESTART in the SAME redirected HOME ──────────────────────────────────
  const second = await spawnHub(context, home);
  assert.notEqual(second.token, firstToken, "the restarted hub re-issues the operator credential");
  assert.notEqual(second.verifierToken, firstVerifierToken, "and the verifier credential — the schedule table is the only state carried over");

  const restartedList = await postRoute(second.endpoint, "/schedule/list", second.token);
  assert.equal(restartedList.status, 200);
  assert.deepEqual(
    restartedList.body,
    {
      schedules: [{ ...definition, lineage: { scheduleId: definition.id, title: definition.title, causedRuns: 0, lastOutcome: "unrun", tombstoned: false } }],
      recentRuns: [],
    },
    "OBSERVED: the saved schedule survives the hub stop + restart — the restarted registry reloads the same table",
  );

  const removed = await postRoute(second.endpoint, "/schedule/delete", second.token, { id: definition.id });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { schedules: [] });
  assert.deepEqual(JSON.parse(readFileSync(defaultSeat, "utf8")), { version: 1, schedules: [] });

  await cleanTeardown(second);
  assert.ok(!existsSync(join(home, ".workflow", "hub", "lock")), "the restarted hub's lock is released on its own teardown");
  assert.ok(existsSync(defaultSeat), "the default seat still exists after the second teardown — operator state to the end");
  assert.deepEqual(JSON.parse(readFileSync(defaultSeat, "utf8")), { version: 1, schedules: [] });
});