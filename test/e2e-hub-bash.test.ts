import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { distArtifact, ensureFresh, ensureToolboxGuardBuilt, repoRoot } from "./fixtures/compiled-dist.js";

// W142 — the /bash and /run/begin lanes against the LIVE COMPILED hub (the
// e2e-coverage wave's add; W133's spawn/discovery/teardown skeleton reused, not
// reinvented). The mandate premise refined by observation (LESS-0054):
// /bash has IN-PROCESS coverage — test/hub-protocol.test.ts:60-89 pins the
// no/wrong-token 401s and the empty-body 400 on a hand-composed hub, and
// test/hub-guard-interception.test.ts:38-68 pins one guard deny and one
// allow in-process — and W133 pinned /run/begin's verifier-401 direction
// (test/e2e-hub-routes.test.ts:237-239). What nothing covered is the lane on
// the compiled multi-process seat: the real verifier.json credential split
// against BOTH routes, the contained-shell happy contract ({output}, cwd
// semantics, the seat's environment), every refusal class, and the run-record
// lifecycle beyond a 401. Pinned from src/integrations/hub-http.ts, observed
// live against the real seat (not invented):
//   - the route (hub-http.ts:255-267): POST-only + Bearer (hub-http.ts:85,98),
//     a JSON body {cwd, command}, and the response is EXACTLY
//     {output: string} on 200 — the executor concatenates stdout+stderr with
//     no separator and no exit-code field (contained-shell-executor.ts:62).
//     /bash and /run/begin are OPERATOR-token routes (hub-http.ts:92-97);
//     the verifier credential serves neither — BOTH refusal directions are
//     pinned below. The genuinely verifier-gated lane of the run lifecycle is
//     /run/finish (hub-http.ts:97,140-147), pinned both directions;
//   - the contained-shell call chain (hub-http.ts:265-266 →
//     run-controller.ts:59-75 → contained-shell-executor.ts:36-70 →
//     workflow-process.ts:13-43): the hub's guard MCP child (src/cli/hub.ts:89,
//     the product's own fail-closed composition — W128's allowance) denies any
//     non-allow decision BEFORE execution (workflow-process.ts:14-19), then
//     the workspace-bound application authorizes the mutating process
//     proposal with subjects [cwd, cwd] (workflow-process.ts:27-41), and only
//     then the containment seat runs /bin/bash -c <command> with
//     writablePaths [cwd] (contained-shell-executor.ts:72-83);
//   - the seat's environment contract, OBSERVED (linux-bwrap.ts:136-140):
//     --clearenv plus a synthesized default PATH (dirname(process.execPath) +
//     /usr/local/bin:/usr/bin:/bin; homedir() is the hub's REDIRECTED HOME, so
//     ~/.local/bin is absent) and NO other variable — no HOME, none of the
//     hub's ambient environment. A policy-only passthrough would inherit the
//     hub's whole environment instead (platform.ts:46-51), so the minimal
//     environment below is the behavioral signature of the enforced bwrap
//     boundary on this Linux seat (bwrap present at /usr/bin/bwrap, and every
//     /bash execute passes its runtime probe first, linux-bwrap.ts:159-165).
//     Honest limitation, recorded not fixed: the seat's enforcement marker
//     (ContainedProcessResult.enforcement) is never surfaced on the /bash
//     response — a hub client cannot observe enforced vs policy-only directly.
// Safety contract (LESS-0051, this file's own spawn budget): the ONLY
// processes spawned are the compiled hub itself (+ the guard MCP child it
// composes at startup — the product's own composition, allowed per W128) and
// innocuous captured one-liners through /bash: echo/pwd/printf builtins and
// two read-only /usr/bin probes (/usr/bin/env for the seat-environment
// contract, /usr/bin/true in the structured form for the direct-exec branch).
// No agents, no PTYs, no network calls. /run/begin never composes a runtime —
// begin creates a run TASK record only (run-registry.ts:280-324 contains no
// host call), and no schedule is ever saved, so no scheduled trigger can arm
// the run; the record is finished (outcome "failed", run-registry.ts:453-471 —
// the failure branch records evidence and transitions, never launching the
// reviewer/tester) immediately after observation. All hub state lands under a
// redirected mkdtemp HOME, the bridge binds port 0 (hub-http.ts:61), and the
// hub is never spawnSync-timeout-killed: async spawn → both banners → pins →
// process-group SIGTERM → pinned exit 0 + the discovery/verifier unlink truth.
//
// Product findings recorded here (each with its exact reproducing request);
// (a) and (b) were FIXED by W145 on 2026-09-25 (the pins flipped
// deliberately — the dated notes at each), the rest stand as recorded:
//   (a) a command's NONZERO EXIT is represented only as HTTP 500 with the
//       combined stdout+stderr as {error}; the numeric exit code never rides
//       the wire (the in-process Error carries it — run-controller.ts:71 —
//       but hub-http.ts:269-275 serializes only the message), and a
//       client-relevant command failure is classified as a server fault
//       (the same 400/500 class as W133's empty-body finding). Repro:
//       {cwd, command: "echo boom >&2; exit 3"} → 500 {"error":"boom\n"};
//       {cwd, command: "exit 7"} → 500 {"error":""}.
//       FIXED by W145 (2026-09-25): a nonzero exit answers 422
//       {error, exitCode} — the command's result is data, never a server
//       fault; the pins below were flipped deliberately.
//   (b) an EMPTY command string passes the route's shape check
//       (hub-http.ts:256 accepts any string) and dies inside the executor
//       (containedRequest's TypeError, contained-shell-executor.ts:75) as a
//       500 — another client fault as a server fault. Repro:
//       {cwd, command: ""} → 500 {"error":"invalid contained shell command"}.
//       FIXED by W145 (2026-09-25): the route's command validation rejects
//       empty string commands (and empty/invalid structured commands) with
//       400; the pin below was flipped deliberately.
//   (c) THE /bash LANE HAS NO TIMEOUT: no timer exists in hub-http.ts,
//       contained-shell-executor.ts, or linux-bwrap.ts (grep-verified), so a
//       hung command (e.g. {cwd, command: "sleep 100000"}) would hold the
//       request and the executor open indefinitely. NOT EXERCISED — the
//       LESS-0051 budget forbids unbounded hangs and there is no timeout to
//       bound them; this header IS the finding's record.
//   (d) output asymmetry: requests are capped at 1 MB (readJson,
//       hub-http.ts:295) but the {output} response has NO cap — a 200,000-char
//       printf came back verbatim, untruncated (pinned below as observed).
//   (e) /run/begin's client-shaped faults are 500s: the route validates only
//       field TYPES (hub-http.ts:114), so empty runId/title (registry
//       TypeError, run-registry.ts:281-283), a duplicate runId
//       (run-registry.ts:284), and a non-canonical workspace
//       (canonicalWorkspace's TypeError, run-registry.ts:88-94) all land in
//       the 500 catch-all. Repros below, each observed exactly.
//   (f) the cleanup/removal path for a begun run is /run/finish with outcome
//       "failed": it does NOT delete the task — the record transitions to
//       FAILED with one failed environment evidence left on the graph
//       (run-registry.ts:453-471) and the task is only HIDDEN from /snapshot
//       via finishedRunTaskIds (run-registry.ts:251-257). Observed and pinned;
//       no other removal path exists on the hub surface.

const sleep = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/** The wire shape under test: POST + Bearer + JSON body (hub-http.ts:85-100). */
async function postRoute(
  endpoint: string,
  path: string,
  token: string | undefined,
  body?: unknown,
  rawBody?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    body: rawBody ?? JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface SnapshotProjection {
  readonly enforcementLevel: string;
  readonly tasks: readonly { readonly id: string; readonly title: string; readonly state: string; readonly blockers: readonly string[] }[];
  readonly evidence: readonly { readonly authority: string; readonly subject: string; readonly result: string; readonly freshness: string }[];
}

test("the compiled hub's /bash and /run/begin lanes: auth directions, the contained-shell contract, the refusal shapes, and the run-record lifecycle", async (context) => {
  ensureFresh(distArtifact("cli", "hub.js"));
  ensureToolboxGuardBuilt();

  const home = mkdtempSync(join(tmpdir(), "w141-bash-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  // The workspace /bash commands run in and /run/begin declares: a real
  // canonicalizable directory (a nonexistent one is the REFUSAL lane below).
  const workspace = mkdtempSync(join(tmpdir(), "w141-bash-ws-"));
  context.after(() => rmSync(workspace, { recursive: true, force: true }));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    WORKFLOW_HUB_PROVENANCE: join(home, "provenance.jsonl"),
    WORKFLOW_HUB_SCHEDULES: join(home, "schedules.json"),
    // Checkpoint F (same as W128/W133): the fail-closed stub keeps the RSI
    // loop out of the probe — no agent turns, ever.
    WORKFLOW_RSI_AGENT: "0",
  };
  // Determinism: these operator seams would change hub behavior if inherited.
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
  // The child leads its own process group (detached) so the group kill reaches
  // the guard MCP grandchild it composes — W128's kill-group pattern.
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

  // Startup: both banners (src/cli/hub.ts:367-368), tokens from the hub's own
  // discovery (the shape pins are W128's; only the credentials are extracted).
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
  const token = (JSON.parse(readFileSync(discoveryPath, "utf8")) as { token: string }).token;
  assert.match(token, /^[0-9a-f]{64}$/);
  const verifierToken = (JSON.parse(readFileSync(join(dirname(discoveryPath), "verifier.json"), "utf8")) as { token: string }).token;
  assert.match(verifierToken, /^[0-9a-f]{64}$/);
  assert.notEqual(verifierToken, token, "the verifier credential is distinct from the operator credential (P1-1)");

  // ── /bash auth, BOTH refusal directions ─────────────────────────────────
  // /bash is an OPERATOR route (hub-http.ts:92-97 — not in the verifierOnly
  // set): no token → 401, and the VERIFIER credential → 401 too. Each
  // credential opens exactly its own class.
  const bashNoToken = await postRoute(endpoint, "/bash", undefined, { cwd: workspace, command: "echo refused" });
  assert.equal(bashNoToken.status, 401);
  assert.deepEqual(bashNoToken.body, { error: "unauthorized" });
  const bashVerifierToken = await postRoute(endpoint, "/bash", verifierToken, { cwd: workspace, command: "echo refused" });
  assert.equal(bashVerifierToken.status, 401, "the verifier credential must not open the shell lane");
  assert.deepEqual(bashVerifierToken.body, { error: "unauthorized" });

  // ── the contained-shell happy lane (operator token, innocuous builtins) ──
  // The response field is exactly `output`, and the output is the
  // CONCATENATION of stdout and stderr with no separator and no exit-code
  // field (contained-shell-executor.ts:62-68 — the 200 shape exists only for
  // exit 0).
  const echo = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: "echo hub-bash-e2e" });
  assert.equal(echo.status, 200);
  assert.deepEqual(echo.body, { output: "hub-bash-e2e\n" }, `observed: ${JSON.stringify(echo.body)}`);

  // Working directory semantics, OBSERVED: the command runs IN the requested
  // cwd (/bin/bash -c <command> with cwd = body.cwd, contained-shell-executor.ts:76-81).
  const pwd = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: "pwd" });
  assert.equal(pwd.status, 200);
  assert.deepEqual(pwd.body, { output: `${workspace}\n` }, `the command ran in the requested cwd — observed: ${JSON.stringify(pwd.body)}`);

  // stdout and stderr concatenate in fd order, no separator, no field per stream.
  const bothStreams = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: "printf OUT; printf ERR >&2" });
  assert.equal(bothStreams.status, 200);
  assert.deepEqual(bothStreams.body, { output: "OUTERR" }, `observed: ${JSON.stringify(bothStreams.body)}`);

  // The seat's environment contract (the enforced-boundary signature): a
  // cleared environment plus the seat's synthesized default PATH, and NO
  // other variable — no HOME, none of the hub's ambient environment
  // (linux-bwrap.ts:136-140). The PATH expectation mirrors the source exactly
  // (a system /usr node contributes nothing).
  const envString = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: "/usr/bin/env" });
  assert.equal(envString.status, 200);
  const envOutput = String(envString.body.output);
  const envKeys = envOutput.split("\n").filter((line) => line.length > 0).map((line) => line.slice(0, line.indexOf("="))).sort();
  assert.deepEqual(
    envKeys,
    ["PATH", "PWD", "SHLVL", "_"],
    `the seat hands the child only bash's runtime variables plus the synthesized PATH — observed: ${JSON.stringify(envOutput)}`,
  );
  assert.ok(!envOutput.includes("HOME="), "no HOME reaches the seat — the environment is not the hub's");
  const seatBinDirs = process.execPath.startsWith("/usr/") ? [] : [dirname(process.execPath)];
  assert.ok(
    envOutput.includes(`PATH=${[...seatBinDirs, "/usr/local/bin", "/usr/bin", "/bin"].join(":")}\n`),
    `the synthesized default PATH — observed: ${JSON.stringify(envOutput)}`,
  );

  // The structured command form executes the binary DIRECTLY (no /bin/bash -c
  // wrapper, contained-shell-executor.ts:90-96): bash's own runtime additions
  // disappear from the environment.
  const envStructured = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: { command: "/usr/bin/env", args: [] } });
  assert.equal(envStructured.status, 200);
  const structuredKeys = String(envStructured.body.output).split("\n").filter((line) => line.length > 0).map((line) => line.slice(0, line.indexOf("="))).sort();
  assert.deepEqual(structuredKeys, ["PATH", "PWD"], `observed: ${JSON.stringify(envStructured.body)}`);
  const trueStructured = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: { command: "/usr/bin/true", args: [] } });
  assert.equal(trueStructured.status, 200);
  assert.deepEqual(trueStructured.body, { output: "" }, "a silent successful binary is the empty output — observed");

  // Output size, OBSERVED: no cap, no truncation (finding (d) — requests are
  // capped at 1 MB, the {output} response is not).
  const large = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: 'printf "x%.0s" {1..200000}' });
  assert.equal(large.status, 200);
  assert.equal(String(large.body.output).length, 200_000, "the 200,000-character output came back verbatim");
  assert.match(String(large.body.output), /^x+$/, "the output is exactly the printf's, byte for byte");

  // ── refusals ─────────────────────────────────────────────────────────────
  // (a) nonzero exit: W145 flipped this deliberately (2026-09-25) — the
  // command's result is data, not a server fault: 422 {error, exitCode}. The
  // pre-fix truth (500 with no exit-code field) is recorded in the W142/W145
  // ledger entries.
  const failing = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: "echo boom >&2; exit 3" });
  assert.equal(failing.status, 422, "a nonzero exit is the command's result — the exit code rides the wire");
  assert.deepEqual(failing.body, { error: "boom\n", exitCode: 3 }, `observed: ${JSON.stringify(failing.body)}`);
  const failingSilent = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: "exit 7" });
  assert.equal(failingSilent.status, 422);
  assert.deepEqual(failingSilent.body, { error: "", exitCode: 7 }, "an output-less failure still carries its exit code");

  // A nonexistent binary: bash's own failure text (exit 127) — the same 422
  // contract, the code named.
  const missingBinary = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: "/usr/bin/definitely-missing-abc123" });
  assert.equal(missingBinary.status, 422);
  assert.deepEqual(
    missingBinary.body,
    { error: "/bin/bash: line 1: /usr/bin/definitely-missing-abc123: No such file or directory\n", exitCode: 127 },
    `observed: ${JSON.stringify(missingBinary.body)}`,
  );

  // (b) empty command: W145 flipped this deliberately (2026-09-25) — a
  // client-shaped fault is a 400 at the route, never a 500 from the executor.
  const emptyCommand = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: "" });
  assert.equal(emptyCommand.status, 400, "an empty command is a client fault");
  assert.deepEqual(emptyCommand.body, { error: "invalid bash request" });

  // Non-canonical cwd declarations refuse at the registry's canonicalization
  // (run-registry.ts:88-94) BEFORE the executor is even built.
  const emptyCwd = await postRoute(endpoint, "/bash", token, { cwd: "", command: "echo refused" });
  assert.equal(emptyCwd.status, 500);
  assert.deepEqual(emptyCwd.body, { error: "declared workspace must be absolute: " });
  const relativeCwd = await postRoute(endpoint, "/bash", token, { cwd: "relative/nope", command: "echo refused" });
  assert.equal(relativeCwd.status, 500);
  assert.deepEqual(relativeCwd.body, { error: "declared workspace must be absolute: relative/nope" });

  // The W134 body contract on this lane: malformed and zero-byte bodies are
  // 400s naming the requirement (hub-http.ts:289-307), never 500s.
  const malformedBody = await postRoute(endpoint, "/bash", token, undefined, "{malformed");
  assert.equal(malformedBody.status, 400);
  assert.deepEqual(malformedBody.body, { error: "a JSON request body is required (send {} for read routes)" });
  const zeroByteBody = await postRoute(endpoint, "/bash", token, undefined, "");
  assert.equal(zeroByteBody.status, 400);
  assert.deepEqual(zeroByteBody.body, { error: "a JSON request body is required (send {} for read routes)" });

  // The route-level shape refusal (hub-http.ts:256-258): a record body
  // without cwd/command fails closed at 400 (the in-process pin's class,
  // hub-protocol.test.ts:80, now on the compiled seat).
  const shapelessBody = await postRoute(endpoint, "/bash", token, {});
  assert.equal(shapelessBody.status, 400);
  assert.deepEqual(shapelessBody.body, { error: "invalid bash request" });

  // The workspace claim over HTTP: declaring workspace A while pointing cwd at
  // B denies the mutating proposal — the application's confinement decision
  // (workflow.ts:199-208) surfaced through the executor's throw
  // (workflow-process.ts:33-41). Nothing executed in either directory.
  const otherWorkspace = mkdtempSync(join(tmpdir(), "w141-bash-ws-other-"));
  context.after(() => rmSync(otherWorkspace, { recursive: true, force: true }));
  const crossWorkspace = await postRoute(endpoint, "/bash", token, { workspace, cwd: otherWorkspace, command: "echo refused" });
  assert.equal(crossWorkspace.status, 500);
  assert.deepEqual(
    crossWorkspace.body,
    { error: `Workflow denied process execution: WORKSPACE_PATH_DENIED: path ${otherWorkspace} is outside authorized workspace ${workspace}` },
    `observed: ${JSON.stringify(crossWorkspace.body)}`,
  );

  // The guard lane refuses any non-allow decision BEFORE execution
  // (workflow-process.ts:14-19): the promotion gate's ask class denies the
  // shell over the compiled seat. Harmless if it ever executed — the workflow
  // binary is not on the seat's PATH.
  const guardAsk = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: "workflow install" });
  assert.equal(guardAsk.status, 500);
  assert.deepEqual(
    guardAsk.body,
    { error: "guard denied process execution: promotion-gate: Installing into the live control plane requires operator approval (T1 promotion): run it from the operator's shell." },
    `observed: ${JSON.stringify(guardAsk.body)}`,
  );

  // ── /run/begin: token classes, malformed bodies, the cannot-canonicalize
  // refusal, ONE run-task record, and the observed removal path ────────────
  // /run/begin is an OPERATOR route (hub-http.ts:92-97): the verifier
  // credential and no credential are both 401s — authorization precedes body
  // parsing (hub-http.ts:98 before 100), so these pins move no state.
  const beginVerifierToken = await postRoute(endpoint, "/run/begin", verifierToken, { runId: "w141-e2e-run-record", title: "refused", workspace });
  assert.equal(beginVerifierToken.status, 401, "begin is the operator side of the run lifecycle — the verifier credential must not begin runs");
  assert.deepEqual(beginVerifierToken.body, { error: "unauthorized" });
  const beginNoToken = await postRoute(endpoint, "/run/begin", undefined, { runId: "w141-e2e-run-record", title: "refused", workspace });
  assert.equal(beginNoToken.status, 401);
  assert.deepEqual(beginNoToken.body, { error: "unauthorized" });

  // The route-level shape refusal (hub-http.ts:114-116).
  const beginShapeless = await postRoute(endpoint, "/run/begin", token, {});
  assert.equal(beginShapeless.status, 400);
  assert.deepEqual(beginShapeless.body, { error: "invalid run begin request" });

  // (e) the registry's client-shaped refusals land in the 500 catch-all
  // (recorded, not fixed): empty runId, and the CANNOT-CANONICALIZE workspace
  // (run-registry.ts:88-94) — nothing composes, no run task is created.
  const beginEmptyRunId = await postRoute(endpoint, "/run/begin", token, { runId: "  ", title: "t", workspace });
  assert.equal(beginEmptyRunId.status, 500);
  assert.deepEqual(beginEmptyRunId.body, { error: "run begin requires a non-empty runId and title" });
  const beginNonCanonical = await postRoute(
    endpoint,
    "/run/begin",
    token,
    { runId: "w141-e2e-noncanon", title: "t", workspace: join(workspace, "does-not-exist") },
  );
  assert.equal(beginNonCanonical.status, 500, "a non-canonicalizable workspace is (currently) a server-fault classification — observed");
  assert.deepEqual(
    beginNonCanonical.body,
    { error: `declared workspace is not an existing directory: ${join(workspace, "does-not-exist")}` },
    `observed: ${JSON.stringify(beginNonCanonical.body)}`,
  );

  // The registry holds NOTHING from the refused begins (the refusal precedes
  // task creation, run-registry.ts:280-311): the fresh projection is the
  // empty tasks list (the seeded interactive task is suppressed — W128's pin
  // re-observed as the baseline here).
  const snapshot = async (): Promise<SnapshotProjection> => {
    const response = await postRoute(endpoint, "/snapshot", token, {});
    assert.equal(response.status, 200);
    return (response.body.snapshot as SnapshotProjection);
  };
  const fresh = await snapshot();
  assert.equal(fresh.enforcementLevel, "enforced", "the hub composes authoritativePreMutation (src/cli/hub.ts:60)");
  assert.deepEqual(fresh.tasks, [], "no run task exists after the refused begins — nothing composes");
  assert.ok(
    (await postRoute(endpoint, "/snapshot", token, {})).body.gateObservability !== undefined,
    "run-gate observability rides the projection (W128's pin — presence re-observed)",
  );

  // ONE run-task record (the cap this probe honors): begin is a TASK RECORD
  // only — run-registry.ts:280-324 composes a WorkspaceApplication, adds the
  // task, transitions IN_PROGRESS, and returns. No runtime, no spawn, and no
  // schedule is saved, so nothing can arm the record into a turn.
  const runId = "w141-e2e-run-record";
  const beginHappy = await postRoute(endpoint, "/run/begin", token, { runId, title: "w141 e2e run record", workspace });
  assert.equal(beginHappy.status, 200);
  assert.deepEqual(beginHappy.body, {}, "begin's happy response is the empty object — observed");

  // What the registry holds, observed via /snapshot: exactly the run record,
  // IN_PROGRESS, no blockers.
  const afterBegin = await snapshot();
  assert.deepEqual(
    afterBegin.tasks,
    [{ id: `run:${runId}`, title: "w141 e2e run record", state: "IN_PROGRESS", blockers: [] }],
    `the run record is the only visible task — observed: ${JSON.stringify(afterBegin.tasks)}`,
  );

  // The duplicate refusal (run-registry.ts:284) — again a 500 (finding (e)).
  const beginDuplicate = await postRoute(endpoint, "/run/begin", token, { runId, title: "t", workspace });
  assert.equal(beginDuplicate.status, 500);
  assert.deepEqual(beginDuplicate.body, { error: `duplicate run: ${runId}` });

  // The removal path, OBSERVED: /run/finish with outcome "failed" is
  // verifier-gated BOTH directions, records one failed environment evidence,
  // transitions the record to FAILED, and HIDES it from the projection — the
  // task stays on the graph (finding (f): no deletion path exists).
  const finishOperator = await postRoute(endpoint, "/run/finish", token, { runId, outcome: "failed" });
  assert.equal(finishOperator.status, 401, "/run/finish requires the VERIFIER credential (hub-http.ts:92-97)");
  assert.deepEqual(finishOperator.body, { error: "unauthorized" });
  const finishVerifier = await postRoute(endpoint, "/run/finish", verifierToken, { runId, outcome: "failed" });
  assert.equal(finishVerifier.status, 200);
  assert.deepEqual(finishVerifier.body, {}, "the failed finish's happy response is the empty object — observed");

  const afterFinish = await snapshot();
  assert.deepEqual(
    afterFinish.tasks,
    [],
    "the finished record is hidden from the projection (finishedRunTaskIds, run-registry.ts:251-257)",
  );
  assert.equal(afterFinish.evidence.length, 1, `the failed finish left exactly one evidence — observed: ${JSON.stringify(afterFinish.evidence)}`);
  assert.equal(afterFinish.evidence[0]?.authority, "environment");
  assert.equal(afterFinish.evidence[0]?.subject, runId);
  assert.equal(afterFinish.evidence[0]?.result, "failed");
  assert.equal(afterFinish.evidence[0]?.freshness, "fresh");

  // ── teardown, re-observed (this probe owns its hub process) ─────────────
  // Group SIGTERM → the hub's guarded shutdown exits 0 on its own (src/cli/
  // hub.ts:370-390) and hub.close() unlinks discovery.json and verifier.json.
  killGroup("SIGTERM");
  const exit = await Promise.race([
    exitPromise,
    sleep(10_000).then(() => ({ code: null, signal: "TIMEOUT" as const })),
  ]);
  assert.deepEqual(
    exit,
    { code: 0, signal: null },
    `the hub exits 0 through its guarded shutdown — observed: ${JSON.stringify({ exit, output: output.slice(-600) })}`,
  );
  assert.ok(!existsSync(discoveryPath), "the shutdown unlinked discovery.json (workflow-hub.ts:175-181)");
  assert.ok(!existsSync(join(dirname(discoveryPath), "verifier.json")), "the shutdown unlinked verifier.json");
});

// W144: the /bash lane is BOUNDED — the hub passes the env-derived cap into
// the executor, the backend kills the process group at the cap, and the
// response carries the named timeout error WITH the partial output. The hub
// must stay alive and serving after the kill (the executor never wedges).
// The test's own 15s timeout keeps the pre-change red bounded (pre-fix the
// request rode the sleep's full 30s and answered 200).
test("W144: the /bash lane is bounded by WORKFLOW_HUB_BASH_TIMEOUT_MS and the hub survives the kill", { timeout: 15_000 }, async (context) => {
  ensureFresh(distArtifact("cli", "hub.js"));
  ensureToolboxGuardBuilt();

  const home = mkdtempSync(join(tmpdir(), "w144-timeout-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const workspace = mkdtempSync(join(tmpdir(), "w144-timeout-ws-"));
  context.after(() => rmSync(workspace, { recursive: true, force: true }));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    WORKFLOW_HUB_PROVENANCE: join(home, "provenance.jsonl"),
    WORKFLOW_HUB_SCHEDULES: join(home, "schedules.json"),
    WORKFLOW_HUB_BASH_TIMEOUT_MS: "750",
    WORKFLOW_RSI_AGENT: "0",
  };
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
  assert.ok(listeningMatch !== null && discoveryMatch !== null);
  const endpoint = listeningMatch![1]!;
  const token = (JSON.parse(readFileSync(discoveryMatch![1]!.trim(), "utf8")) as { token: string }).token;

  // The bounded lane: a command that prints then hangs answers 500 with the
  // named timeout error carrying the PARTIAL output — the kill landed at the
  // 750ms cap, not the sleep's full duration.
  const bounded = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: "echo partial; sleep 30" });
  assert.equal(bounded.status, 500, `observed: ${JSON.stringify(bounded.body)}`);
  assert.match(String(bounded.body.error), /timed out after 750ms/);
  assert.match(String(bounded.body.error), /process group SIGKILL/);
  assert.match(String(bounded.body.error), /partial/, "the partial output rides the timeout error");
  assert.ok(exitInfo === undefined, "the hub survived the kill");

  // The executor never wedges: the next command answers normally.
  const after = await postRoute(endpoint, "/bash", token, { cwd: workspace, command: "echo unwedged" });
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, { output: "unwedged\n" });

  await killGroup("SIGTERM");
  const exit = await Promise.race([exitPromise, sleep(10_000).then(() => undefined)]);
  assert.ok(exit !== undefined, "the hub exited after the group SIGTERM");
  assert.deepEqual(exit, { code: 0, signal: null }, "the shutdown is clean");
});
