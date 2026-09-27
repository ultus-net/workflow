import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { distArtifact, ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

// W128 — the COMPILED web service's HTTP API, end to end (behavioral e2e).
// W126's compiled smoke only proved start + teardown for workflow-web; the
// behavioral seat (test/web.test.ts) drives createWorkflowWebServer from SRC.
// Behavioral divergence between the seats is LESS-0012's recorded class, so
// this file drives the COMPILED service's real HTTP API (dist/cli/web-launch.js
// → src/cli/web-service.ts's startWorkflowWeb → src/ui/web.ts's routes):
//   - GET /           the operator shell HTML (src/ui/web.ts's PAGE, "Workflow Control");
//   - GET /api/snapshot  the application snapshot — seed pinned from
//     src/cli/web-service.ts's TaskGraph seed (W001 no deps, W002 on W001)
//     AS THE KERNEL SERVES IT: the seed states are BLOCKED, but the
//     constructor's #recomputeReadiness (src/kernel/task-graph.ts) recomputes
//     dependency-derived readiness live, so W001 answers READY and W002
//     BLOCKED — pinned from the kernel's recompute rule, not the seed literal;
//   - POST /api/transition  the kernel's TransitionResult answered verbatim
//     (src/ui/web.ts: result.kind === "accepted" ? 200 : 409), then the
//     follow-up snapshot proves the state moved IN_PROGRESS and the
//     application history recorded it;
//   - GET /app.js + /app.css  the PREBUILT bundle served over HTTP (W127's
//     composition: compiled web-service.ts's buildWebappBundle resolves
//     dist/ui/webapp/prebuilt.js|css beside the compiled module BEFORE the
//     runtime esbuild fallback). The served bytes are pinned equal to the
//     on-disk prebuilt artifact — the strongest honest proof that the
//     packaged seat serves the prebuilt bundle, not a runtime rebuild —
//     plus the minification-surviving literals ("composer-chips", "--accent").
//
// SAFETY CONTRACT (LESS-0051, non-negotiable): no agent or PTY spawns ever
// (this flow never creates a session channel, so WebSessionManager's factory
// never runs); all state lands under a redirected HOME (fresh mkdtemp, the
// hub discovery dir included); the server binds port 0 (ephemeral, loopback
// only); the browser opener is suppressed (--no-browser) and the stock-tab
// discovery is suppressed (WORKFLOW_OPENCODE_STOCK_TAB=0, src/cli/web-launch.ts).
// Teardown follows the W126 daemon pattern — async spawn → banner → process-
// group SIGTERM → the surface's OWN exit pinned (web-launch's shutdown handler:
// service.close().then(() => process.exit(0)) → exit 0, no signal kill) —
// never spawnSync's timeout kill, which cannot see a clean teardown (LESS-0051:
// the ETIMEDOUT trap). Process-group kill per
// src/cli/opencode-attach.ts's terminateProcessGroup, so no grandchild outlives
// the probe.

/** The snapshot the HTTP API serves (src/application/workflow.ts's projection). */
interface Snapshot {
  readonly enforcementLevel: string;
  readonly transport: string;
  readonly mutationEpoch: number;
  readonly tasks: readonly { readonly id: string; readonly title: string; readonly state: string; readonly blockers: readonly string[] }[];
  readonly evidence: readonly unknown[];
  readonly history: readonly { readonly taskId: string; readonly from: string; readonly to: string }[];
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
}

test("W128: the compiled web service serves the operator HTTP API end to end — kernel transitions and the W127 prebuilt bundle over HTTP", async (context) => {
  ensureFresh(distArtifact("cli", "web-launch.js"));
  // The prebuilt bundle the compiled seat must serve (W127): read BEFORE the
  // spawn so the equality pin below compares the same generation the service
  // composed at startup (buildWebappBundle reads it once, at start).
  const prebuiltJs = readFileSync(distArtifact("ui", "webapp", "prebuilt.js"), "utf8");
  const prebuiltCss = readFileSync(distArtifact("ui", "webapp", "prebuilt.css"), "utf8");

  const home = mkdtempSync(join(tmpdir(), "w128-web-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));

  let output = "";
  let exit: ChildExit | undefined;
  const child: ChildProcess = spawn(process.execPath, [distArtifact("cli", "web-launch.js"), "--no-browser", "--port", "0"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      WORKFLOW_HUB_DIR: home,
      WORKFLOW_OPENCODE_SERVER_HOME: join(home, "opencode-server"),
      WORKFLOW_OPENCODE_STOCK_TAB: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  // The child leads its own process group (detached), so the kill reaches every
  // grandchild it spawned — the kill-group pattern is
  // src/cli/opencode-attach.ts's terminateProcessGroup.
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
  child.once("exit", (code, signal) => { exit = { code, signal }; });
  context.after(() => {
    if (exit === undefined) killTree("SIGKILL");
  });

  // Wait for the startup banner (src/cli/web-launch.ts's launch log), which
  // carries the ephemeral port parsed out of it.
  const deadline = Date.now() + 20_000;
  while (exit === undefined && !output.includes("Workflow browser UI:") && Date.now() < deadline) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  }
  const banner = output.match(/Workflow browser UI: http:\/\/127\.0\.0\.1:(\d+)/);
  assert.ok(
    banner !== null,
    `the compiled web service never printed its startup banner within 20s — output: ${output.slice(0, 600)}`,
  );
  assert.ok(banner[1] !== undefined && banner[1] !== "0", `the banner must carry the real ephemeral port — output: ${output.slice(0, 600)}`);
  const port = Number(banner[1]);
  const base = `http://127.0.0.1:${port}`;
  // --no-browser took the suppressed-opener path (src/cli/web-launch.ts); no
  // browser may ever open under this contract.
  assert.ok(output.includes("Browser open suppressed"), `the suppressed-opener banner must appear — output: ${output.slice(0, 600)}`);

  // The operator shell (src/ui/web.ts's PAGE literal).
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Workflow Control/);

  // The kernel's live view: seed states recomputed from dependencies
  // (src/kernel/task-graph.ts's #recomputeReadiness — W001 has no
  // dependencies, so it answers READY even though the seed literal says
  // BLOCKED; W002 depends on the not-yet-VERIFIED W001, so it stays BLOCKED).
  const snapshotOf = async (): Promise<Snapshot> => {
    const response = await fetch(`${base}/api/snapshot`);
    assert.equal(response.status, 200);
    return await response.json() as Snapshot;
  };
  const before = await snapshotOf();
  // The seed rides hostCapabilities({ transport: "acp", authoritativePreMutation: false })
  // (src/cli/web-service.ts) — advisory is the honest enforcement level.
  assert.equal(before.transport, "acp");
  assert.equal(before.enforcementLevel, "advisory");
  assert.equal(before.mutationEpoch, 0);
  assert.deepEqual(before.history, []);
  const byId = (snapshot: Snapshot): Map<string, Snapshot["tasks"][number]> =>
    new Map(snapshot.tasks.map((task) => [task.id, task]));
  const beforeById = byId(before);
  assert.equal(before.tasks.length, 2, `exactly the two seed tasks — got: ${JSON.stringify(before.tasks)}`);
  assert.equal(beforeById.get("W001")?.title, "Inspect the browser Workflow UI");
  assert.equal(beforeById.get("W001")?.state, "READY", "W001 recomputes READY: no dependencies (the kernel's live truth, not the seed literal)");
  assert.equal(beforeById.get("W002")?.state, "BLOCKED", "W002 stays BLOCKED: its dependency W001 is not VERIFIED");
  assert.deepEqual(beforeById.get("W002")?.blockers, ["W001"]);

  // The kernel answers its TransitionResult verbatim over HTTP
  // (src/ui/web.ts: accepted → 200; READY→IN_PROGRESS is legal).
  const transition = await fetch(`${base}/api/transition`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "W001", requested: "IN_PROGRESS" }),
  });
  assert.equal(transition.status, 200);
  // W157: the operator web route stamps the transition (the trusted-mutation
  // gate above is the operator boundary) — the result carries the stamp and
  // the observedAt is the route's own clock.
  const transitionBody = await transition.json() as { transition: { attribution?: { actor: string; authority: string; observedAt: string } } };
  assert.equal(transitionBody.transition.attribution?.actor, "operator");
  assert.equal(transitionBody.transition.attribution?.authority, "operator task transition (web route, trusted mutation)");
  assert.match(transitionBody.transition.attribution?.observedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

  // The state moved, the history recorded it, and the mutation epoch did not
  // move (a task-state transition is not a mutation — only recordMutation
  // bumps the kernel's epoch).
  const after = await snapshotOf();
  const afterById = byId(after);
  assert.equal(afterById.get("W001")?.state, "IN_PROGRESS");
  assert.equal(afterById.get("W002")?.state, "BLOCKED");
  assert.deepEqual(afterById.get("W002")?.blockers, ["W001"]);
  // W157: the history row carries the route's operator stamp verbatim.
  assert.deepEqual(after.history, [{
    taskId: "W001",
    from: "READY",
    to: "IN_PROGRESS",
    attribution: { actor: "operator", authority: "operator task transition (web route, trusted mutation)", observedAt: transitionBody.transition.attribution!.observedAt },
  }]);
  assert.equal(after.mutationEpoch, 0);

  // The PREBUILT bundle over HTTP (W127): the compiled module's
  // buildWebappBundle reads dist/ui/webapp/prebuilt.js|css before ever
  // touching the runtime esbuild fallback, and src/ui/web.ts serves those
  // in-memory bytes at /app.js and /app.css.
  const appJs = await fetch(`${base}/app.js`);
  assert.equal(appJs.status, 200);
  assert.match(appJs.headers.get("content-type") ?? "", /text\/javascript/);
  const jsBody = await appJs.text();
  assert.ok(jsBody.length > 0, "/app.js must be non-empty");
  assert.ok(jsBody.includes("composer-chips"), "/app.js must carry the minification-surviving 'composer-chips' literal");
  assert.equal(jsBody, prebuiltJs, "/app.js must serve the on-disk prebuilt artifact byte-for-byte (the W127 prebuilt branch, not a runtime rebuild)");

  const appCss = await fetch(`${base}/app.css`);
  assert.equal(appCss.status, 200);
  assert.match(appCss.headers.get("content-type") ?? "", /text\/css/);
  const cssBody = await appCss.text();
  assert.ok(cssBody.length > 0, "/app.css must be non-empty");
  assert.ok(cssBody.includes("--accent"), "/app.css must carry the '--accent' token literal");
  assert.equal(cssBody, prebuiltCss, "/app.css must serve the on-disk prebuilt artifact byte-for-byte (the W127 prebuilt branch)");

  // Teardown: SIGTERM the process group and pin the surface's OWN teardown —
  // web-launch's shutdown handler is service.close().then(() => process.exit(0)),
  // so the honest exit is 0 with no signal kill (LESS-0051: the async
  // spawn → banner → SIGTERM → pinned-exit pattern; never spawnSync's
  // timeout kill, whose ETIMEDOUT reporting cannot see a clean teardown).
  killTree("SIGTERM");
  const result = await new Promise<ChildExit>((resolveExit) => {
    const hardKill = setTimeout(() => {
      killTree("SIGKILL");
    }, 15_000);
    child.once("exit", (code, signal) => {
      clearTimeout(hardKill);
      resolveExit({ code, signal });
    });
  });
  assert.equal(
    result.signal,
    null,
    `the compiled web service died by ${result.signal} instead of its own SIGTERM teardown — output: ${output.slice(0, 600)}`,
  );
  assert.equal(
    result.code,
    0,
    `after SIGTERM the shutdown handler must exit 0 (service.close().then(() => process.exit(0))) — output: ${output.slice(0, 600)}`,
  );
});