import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { distArtifact, ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

// W131 — the COMPILED settings panel's HTTP contract, end to end (behavioral
// e2e, the e2e stream's third seat). The settings verb is the dispatcher's
// in-process branch (src/cli/workflow.ts: startWorkflowWeb + the settings
// banner + openBrowser), so this
// file drives the REAL compiled binary (dist/cli/workflow.js `settings`) and
// pins the settings-document HTTP contract src/ui/web.ts serves:
//   - the banner: `Workflow settings panel: http://127.0.0.1:<port> (the
//     Settings dialog lives on the operator shell)` — W134's CLI fix stopped
//     advertising `/settings` (a 404); the banner carries the REAL port,
//     never the 0 placeholder (PORT=0 is the ephemeral seam — the branch
//     passes no --port; src/cli/web-service.ts reads env PORT, 4173 unset);
//   - GET /settings → 404 {"error":"not found"}: the server has no /settings
//     page route — the settings surface is the SPA's settings DIALOG behind
//     GET / (src/ui/web.ts; src/ui/webapp/settings-dialog.tsx). The pre-W134
//     launcher printed AND opened this dead link (recorded as the W131
//     finding); the route still 404s as the server truth, and the CLI no
//     longer advertises it;
//   - GET /api/settings/mcp + /api/settings/agents: the merged read shapes
//     (global base + per-workspace overlay, overlay wins per server name and
//     per agent key — src/integrations/workflow-settings.ts), the vendored
//     toolbox catalog, and the /api/settings/agents facts: presence booleans
//     and the upstream URL only, never secret values;
//   - the honest refusal shapes: POST behind the cross-origin gate (403),
//     wrong content-type (415), `servers must be an array` / `agent is
//     required` / the preference-shape 400 — plus fail-closed normalization
//     on the happy path: a malformed MCP server is DROPPED, never guessed;
//   - the on-disk truth: the global document lands under the REDIRECTED HOME
//     (~/.config/workflow/settings.json, 0600 in a 0700 dir) and the
//     workspace overlay under the redirected workspace
//     (<workspace>/.workflow/settings.json) — the settings document is
//     homedir-based, so HOME is the isolation seam (LESS-0051).
//
// BROWSER SUPPRESSION (the safety-critical seam, observed on this desktop):
// the settings verb calls openBrowser UNCONDITIONALLY (src/cli/workflow.ts) —
// unlike `workflow web` it has NO --no-browser flag. The only in-process seam
// is the env gate src/cli/open-browser.ts honors: WORKFLOW_NO_BROWSER=1
// resolves openBrowser(false) BEFORE any opener lookup, so the honest
// "No browser opener available; open the URL above manually." line prints and
// no process is ever spawned. This host HAS xdg-open and a live display, so
// without the gate a real browser WOULD open. Defense in depth: the spawned
// child's desktop-session env (DISPLAY/WAYLAND_DISPLAY/DBUS_SESSION_BUS_ADDRESS)
// is stripped so even a hypothetical opener could not reach this session.
//
// SAFETY CONTRACT (LESS-0051, non-negotiable): no agent or PTY spawns ever
// (this flow never creates a session channel, so WebSessionManager's factory
// never runs); all state lands under redirected HOME/WORKFLOW_HUB_DIR
// (fresh mkdtemps) and the child's cwd is a redirected workspace so the
// per-workspace settings overlay can never write into the real repo; the
// server binds port 0 (ephemeral, loopback only); the fake
// WORKFLOW_OPENROUTER_MANAGEMENT_KEY rides the presence-boolean pin and is
// never echoed (the analytics client is only built on the usage routes).
// Teardown follows the W128 daemon pattern — async spawn → banner → process-
// group SIGTERM → the surface's OWN exit pinned (the settings branch's
// shutdown handler: service.close().then(() => process.exit(0)) → exit 0, no
// signal kill) — never spawnSync's timeout kill.

/** One normalized MCP server entry (src/integrations/workflow-settings.ts). */
interface SettingsMcpServer {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
}

/** The GET /api/settings/mcp read shape (src/ui/web.ts). */
interface McpSettingsRead {
  readonly servers: readonly SettingsMcpServer[];
  readonly global: readonly SettingsMcpServer[];
  readonly workspace: readonly SettingsMcpServer[];
  readonly workspaceOverlay: boolean;
  readonly catalog: readonly {
    readonly name: string;
    readonly description: string;
    readonly transport: string;
    readonly serverPath: string;
    readonly available: boolean;
  }[];
}

/** One normalized agent runtime preference. */
interface SettingsAgentPreference {
  readonly model?: string;
  readonly mode?: string;
  readonly thoughtLevel?: string;
  readonly autoCompact?: boolean;
  readonly autoCompactAtTokens?: number;
}

/** The GET /api/settings/agents read shape (src/ui/web.ts). */
interface AgentsSettingsRead {
  readonly agents: Readonly<Record<string, SettingsAgentPreference>>;
  readonly facts: {
    readonly upstream: string;
    readonly envModelOpencode: boolean;
    readonly envModelGoose: boolean;
    readonly managementKey: boolean;
  };
}

/** The GET /api/settings/mcp/live shape (src/integrations/opencode-live-state.ts). */
type LiveMcpRead =
  | { readonly live: true; readonly gatewayUrl: string; readonly servers: readonly { readonly name: string; readonly status: string }[] }
  | { readonly live: false; readonly reason: string };

interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
}

test("W131: the compiled settings panel serves the settings-document HTTP contract end to end — the advertised deep link's honest 404, fail-closed write shapes, and the browser-suppressed clean teardown", async (context) => {
  ensureFresh(distArtifact("cli", "workflow.js"));

  // Two isolated roots: HOME (the global settings document, the hub discovery
  // dir, and the opencode-server state home all follow the redirect) and the
  // child's cwd (the settings branch's workspace — its overlay MUST land
  // there, never in the real repo).
  const home = mkdtempSync(join(tmpdir(), "w131-settings-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "w131-settings-ws-"));
  context.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PORT: "0",
    WORKFLOW_HUB_DIR: home,
    WORKFLOW_OPENCODE_SERVER_HOME: join(home, "opencode-server"),
    // The suppression seam under test (src/cli/open-browser.ts): the ONLY
    // in-process gate the settings verb honors — it has no --no-browser flag.
    WORKFLOW_NO_BROWSER: "1",
    // Presence-boolean env for the /api/settings/agents facts pin: the
    // response must carry the PRESENCE of these, never their values.
    WORKFLOW_OPENCODE_MODEL: "w131-presence/model",
    WORKFLOW_OPENROUTER_MANAGEMENT_KEY: "w131-ephemeral-management-key",
  };
  // Defense in depth behind WORKFLOW_NO_BROWSER=1: strip the desktop-session
  // env so even a hypothetical opener could not reach this operator session.
  delete childEnv.DISPLAY;
  delete childEnv.WAYLAND_DISPLAY;
  delete childEnv.DBUS_SESSION_BUS_ADDRESS;

  let output = "";
  let exit: ChildExit | undefined;
  const child: ChildProcess = spawn(process.execPath, [distArtifact("cli", "workflow.js"), "settings"], {
    cwd: workspace,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  // The child leads its own process group (detached), so the kill reaches
  // every grandchild — src/cli/opencode-attach.ts's terminateProcessGroup.
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

  // Wait for the startup banner (src/cli/workflow.ts's settings branch) and
  // parse the base URL out of it.
  const deadline = Date.now() + 20_000;
  while (exit === undefined && !output.includes("Workflow settings panel:") && Date.now() < deadline) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  }
  // The banner and the branch line are adjacent writes across one awaited
  // promise — the pipe may deliver the banner's chunk a poll tick before the
  // second line's chunk, and the immediate assert then sees a banner-only
  // buffer (main's 02dcc4d evidence run and #312's first run failed exactly
  // so, both without any related diff in the path; locally green 3/3). Wait
  // for the DECISION line — either branch — before asserting, so a real
  // regression (the opener branch taken) still fails loudly and fast.
  const decisionDeadline = Date.now() + 5_000;
  while (
    exit === undefined &&
    !output.includes("No browser opener available;") &&
    !output.includes("Opening in your default browser") &&
    Date.now() < decisionDeadline
  ) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  const banner = output.match(/Workflow settings panel: (http:\/\/127\.0\.0\.1:(\d+)) \(/);
  assert.ok(
    banner !== null,
    `the compiled settings panel never printed its startup banner within 20s — output: ${output.slice(0, 600)}`,
  );
  assert.ok(banner[1] !== undefined && banner[2] !== undefined, "the banner must carry the base URL and the port");
  assert.notEqual(banner[2], "0", `the banner must carry the REAL ephemeral port, not the PORT=0 placeholder — output: ${output.slice(0, 600)}`);
  assert.ok(exit === undefined, `the settings panel must still be serving when the banner prints — early exit: ${JSON.stringify(exit)}`);
  const base = banner[1];

  // The suppression seam took the honest no-opener path: openBrowser resolved
  // false BEFORE spawning anything (src/cli/open-browser.ts honors
  // WORKFLOW_NO_BROWSER=1), so the else-branch line prints and no opener
  // process ever starts. The settings verb has no --no-browser flag — this env
  // gate is the only suppression seam it composes.
  assert.ok(
    output.includes("No browser opener available; open the URL above manually."),
    `the honest no-opener line must print (the settings verb's openBrowser resolved false under WORKFLOW_NO_BROWSER=1) — output: ${output.slice(0, 600)}`,
  );
  assert.ok(
    !output.includes("Opening in your default browser"),
    `no browser may ever open under this contract — output: ${output.slice(0, 600)}`,
  );

  // THE ROUTE-TRUTH PIN: the /settings route answers 404 — the server serves
  // the operator shell only at GET / (src/ui/web.ts has no /settings page
  // route — the settings surface is the SPA's settings DIALOG reached from
  // the shell). Pre-W134 the launcher printed and opened this dead link
  // (the W131 finding); the CLI now advertises the shell root (pinned
  // above), and the route pin remains the server truth.
  const deepLink = await fetch(`${base}/settings`);
  assert.equal(deepLink.status, 404, "the /settings route is a 404 (the server truth; the CLI no longer advertises it — W134)");
  assert.deepEqual(await deepLink.json(), { error: "not found" });

  // The operator shell the dialog actually lives behind (src/ui/web.ts's PAGE).
  const shell = await fetch(`${base}/`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Workflow Control/);

  // The settings-document reads BEFORE any write: empty defaults, the
  // workspace overlay flag on (the service composes a workspace root), and
  // the vendored toolbox catalog.
  const readMcp = async (): Promise<McpSettingsRead> => {
    const response = await fetch(`${base}/api/settings/mcp`);
    assert.equal(response.status, 200);
    return await response.json() as McpSettingsRead;
  };
  const before = await readMcp();
  assert.deepEqual(before.servers, [], "no settings document exists yet — the merged read is empty, never fabricated");
  assert.deepEqual(before.global, []);
  assert.deepEqual(before.workspace, []);
  assert.equal(before.workspaceOverlay, true, "the service composes a workspace root (the child's cwd), so the overlay flag is on");
  assert.ok(before.catalog.length > 0, "the vendored toolbox catalog must be non-empty");
  assert.ok(
    before.catalog.some((entry) => entry.name === "workflow-guard-mcp"),
    `the vendored guard must be cataloged — got: ${JSON.stringify(before.catalog.map((entry) => entry.name))}`,
  );
  for (const entry of before.catalog) {
    assert.equal(typeof entry.name, "string");
    assert.ok(entry.name.length > 0);
    assert.equal(typeof entry.available, "boolean");
  }

  // The agents read: empty preferences + the routing facts — presence
  // booleans for the env seams (WORKFLOW_OPENCODE_MODEL and the management
  // key are set in the child env) and the default upstream, with NO secret
  // values echoed anywhere in the body.
  const agentsResponse = await fetch(`${base}/api/settings/agents`);
  assert.equal(agentsResponse.status, 200);
  // One body read (a Response's body is single-use): the text is parsed AND
  // grepped for the fake key so the secret-leak pin and the shape pin share it.
  const agentsBody = await agentsResponse.text();
  const agentsBefore = JSON.parse(agentsBody) as AgentsSettingsRead;
  assert.deepEqual(agentsBefore.agents, {});
  assert.deepEqual(agentsBefore.facts, {
    upstream: "https://openrouter.ai",
    envModelOpencode: true,
    envModelGoose: false,
    managementKey: true,
  });
  assert.ok(
    !agentsBody.includes("w131-ephemeral-management-key"),
    "the management key value must never appear in the facts read — presence booleans only",
  );

  // The honest live-MCP refusal: no topology daemon under the redirected
  // state home — an unavailable STATE, never a fabricated connection.
  const live = await fetch(`${base}/api/settings/mcp/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json() as LiveMcpRead, {
    live: false,
    reason: "no server topology daemon is running for this workspace (live MCP unavailable)",
  });

  // An unknown route answers the uniform 404.
  const unknown = await fetch(`${base}/api/definitely-unknown-w131`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "not found" });

  // The mutation refusals, in the order the handler checks them
  // (src/ui/web.ts): the cross-origin gate first, then the content-type,
  // then the body shape. The origin gate is the ONLY auth these settings
  // mutations compose — no management key, no session scope — so a plain
  // loopback client (no Origin header — the shape this next write exercises;
  // the later writes use the same-origin shape instead) is trusted.
  const crossOrigin = await fetch(`${base}/api/settings/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: "{}",
  });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: "cross-origin mutation denied" });

  const wrongType = await fetch(`${base}/api/settings/mcp`, {
    method: "POST",
    headers: { "content-type": "text/plain", origin: base },
    body: "x",
  });
  assert.equal(wrongType.status, 415);
  assert.deepEqual(await wrongType.json(), { error: "content-type must be application/json" });

  const notArray = await fetch(`${base}/api/settings/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ scope: "global", servers: "nope" }),
  });
  assert.equal(notArray.status, 400);
  assert.deepEqual(await notArray.json(), { error: "servers must be an array" });

  const noAgent = await fetch(`${base}/api/settings/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ preference: { model: "m" } }),
  });
  assert.equal(noAgent.status, 400);
  assert.deepEqual(await noAgent.json(), { error: "agent is required" });

  const emptyPreference = await fetch(`${base}/api/settings/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ agent: "opencode", preference: { junk: 1 } }),
  });
  assert.equal(emptyPreference.status, 400);
  assert.deepEqual(
    await emptyPreference.json(),
    { error: "preference must set at least one of model, mode, thoughtLevel, autoCompact" },
  );

  // The writes. Global scope, with a deliberately malformed sibling server:
  // fail-closed normalization DROPS it (src/integrations/workflow-settings.ts),
  // never guesses a shape. This write also exercises the NO-ORIGIN trusted
  // path (node fetch sends no Origin/Sec-Fetch-Site headers —
  // isTrustedMutation's fallback branch; the round-2 review's note: the
  // same-origin shape is exercised by the later writes).
  const writeMcpGlobal = await fetch(`${base}/api/settings/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "global",
      servers: [
        { name: "w131-server", enabled: true, transport: "stdio", command: "echo", args: ["hi"], env: { R: "1" } },
        { name: "w131-malformed", transport: "nonsense" },
      ],
    }),
  });
  assert.equal(writeMcpGlobal.status, 200);
  const writtenGlobal = await writeMcpGlobal.json() as { scope: string; servers: readonly SettingsMcpServer[] };
  assert.equal(writtenGlobal.scope, "global");
  assert.deepEqual(
    writtenGlobal.servers,
    [{ name: "w131-server", enabled: true, transport: "stdio", command: "echo", args: ["hi"], env: { R: "1" } }],
    "the malformed server is DROPPED fail-closed — only the well-formed entry survives normalization",
  );

  // The agents write: the junk key is dropped, the compaction threshold is
  // kept (a positive integer), autoCompact persists as the operator's choice.
  const writeAgentsGlobal = await fetch(`${base}/api/settings/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      agent: "opencode",
      preference: { model: "w131-presence/model", autoCompact: true, autoCompactAtTokens: 1234, junkKey: true },
      scope: "global",
    }),
  });
  assert.equal(writeAgentsGlobal.status, 200);
  assert.deepEqual(await writeAgentsGlobal.json(), {
    scope: "global",
    agent: "opencode",
    preference: { model: "w131-presence/model", autoCompact: true, autoCompactAtTokens: 1234 },
  });

  // The workspace writes: the DEFAULT scope is workspace when the service
  // composes a workspace root (no scope field sent), and the same server NAME
  // as the global entry so the per-name overlay-wins merge is observable.
  const writeMcpWorkspace = await fetch(`${base}/api/settings/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      servers: [{ name: "w131-server", enabled: false, transport: "http", url: "http://127.0.0.1:9" }],
    }),
  });
  assert.equal(writeMcpWorkspace.status, 200);
  const writtenWorkspace = await writeMcpWorkspace.json() as { scope: string; servers: readonly SettingsMcpServer[] };
  assert.equal(writtenWorkspace.scope, "workspace", "the default scope is workspace when the service has a workspace root");
  assert.deepEqual(
    writtenWorkspace.servers,
    [{ name: "w131-server", enabled: false, transport: "http", url: "http://127.0.0.1:9" }],
  );

  const writeAgentsWorkspace = await fetch(`${base}/api/settings/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ agent: "goose", preference: { mode: "w131-dialog" }, scope: "workspace" }),
  });
  assert.equal(writeAgentsWorkspace.status, 200);
  assert.deepEqual(await writeAgentsWorkspace.json(), { scope: "workspace", agent: "goose", preference: { mode: "w131-dialog" } });

  // The merged reads after the writes: the overlay WINS per server name
  // (the workspace http/disabled entry shadows the global stdio/enabled one)
  // while the scope-split read still shows both layers.
  const after = await readMcp();
  assert.deepEqual(
    after.servers,
    [{ name: "w131-server", enabled: false, transport: "http", url: "http://127.0.0.1:9" }],
    "the workspace overlay wins per server name in the merged read",
  );
  assert.deepEqual(
    after.global,
    [{ name: "w131-server", enabled: true, transport: "stdio", command: "echo", args: ["hi"], env: { R: "1" } }],
  );
  assert.deepEqual(
    after.workspace,
    [{ name: "w131-server", enabled: false, transport: "http", url: "http://127.0.0.1:9" }],
  );

  // Agents merge per key: opencode from the global document, goose from the
  // workspace overlay — both visible in one read.
  const agentsAfterResponse = await fetch(`${base}/api/settings/agents`);
  assert.equal(agentsAfterResponse.status, 200);
  const agentsAfter = await agentsAfterResponse.json() as AgentsSettingsRead;
  assert.deepEqual(agentsAfter.agents, {
    opencode: { model: "w131-presence/model", autoCompact: true, autoCompactAtTokens: 1234 },
    goose: { mode: "w131-dialog" },
  });

  // The on-disk truth: the GLOBAL document followed the HOME redirect
  // (~/.config/workflow/settings.json — settingsPaths' homedir seam), the
  // OVERLAY followed the redirected workspace, the real repo was never
  // touched, and the custody modes are the code's 0600-in-0700.
  const globalDoc = join(home, ".config", "workflow", "settings.json");
  assert.ok(existsSync(globalDoc), "the global settings document must exist under the REDIRECTED HOME (the homedir seam, isolated)");
  const globalRaw = JSON.parse(readFileSync(globalDoc, "utf8")) as Record<string, unknown>;
  assert.equal(globalRaw.version, 1);
  assert.deepEqual(globalRaw.mcpServers, [{ name: "w131-server", enabled: true, transport: "stdio", command: "echo", args: ["hi"], env: { R: "1" } }]);
  assert.deepEqual(globalRaw.agents, { opencode: { model: "w131-presence/model", autoCompact: true, autoCompactAtTokens: 1234 } });
  assert.equal(typeof globalRaw.updatedAt, "string", "the write stamps updatedAt");
  assert.equal(statSync(globalDoc).mode & 0o777, 0o600, "the settings document is written 0600 (writeSettingsFile's custody mode)");
  assert.equal(statSync(dirname(globalDoc)).mode & 0o777, 0o700, "the settings document's directory is 0700");

  const overlayDoc = join(workspace, ".workflow", "settings.json");
  assert.ok(existsSync(overlayDoc), "the workspace overlay must exist under the REDIRECTED workspace");
  const overlayRaw = JSON.parse(readFileSync(overlayDoc, "utf8")) as Record<string, unknown>;
  assert.deepEqual(overlayRaw.mcpServers, [{ name: "w131-server", enabled: false, transport: "http", url: "http://127.0.0.1:9" }]);
  assert.deepEqual(overlayRaw.agents, { goose: { mode: "w131-dialog" } });
  assert.equal(statSync(overlayDoc).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(overlayDoc)).mode & 0o777, 0o700);
  assert.deepEqual(
    readdirSync(workspace),
    [".workflow"],
    "the settings surface touches only .workflow/ in its workspace — nothing else, and never the real repo",
  );
  assert.ok(
    !existsSync(join(repoRoot, ".workflow", "settings.json")),
    "the real repo must never gain a settings overlay from this run",
  );

  // Teardown: SIGTERM the process group and pin the surface's OWN teardown —
  // the settings branch's shutdown handler is service.close().then(() =>
  // process.exit(0)), so the honest exit is 0 with no signal kill (LESS-0051's
  // async spawn → banner → SIGTERM → pinned-exit pattern).
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
    `the compiled settings panel died by ${result.signal} instead of its own SIGTERM teardown — output: ${output.slice(0, 600)}`,
  );
  assert.equal(
    result.code,
    0,
    `after SIGTERM the shutdown handler must exit 0 (service.close().then(() => process.exit(0))) — output: ${output.slice(0, 600)}`,
  );
  // The full lifecycle composed exactly two stdout lines: the banner and the
  // honest no-opener line — no agent spawn, no stray logging. The equality
  // is read after the exit promise resolves (node flushes pipe stdout
  // before exit — the round-2 review's note-level flake caveat; if a flush
  // race ever appears, await stream close before this assert).
  // The W134 CLI fix: the verb no longer advertises ${base}/settings (a 404)
  // — it points at the shell root where the Settings dialog lives; the
  // /settings route itself still 404s (the server unchanged; pinned below as
  // the server truth).
  assert.equal(
    output,
    `Workflow settings panel: ${base} (the Settings dialog lives on the operator shell)\nNo browser opener available; open the URL above manually.\n`,
    `the settings verb's whole output must be exactly the banner + the no-opener line — output: ${JSON.stringify(output)}`,
  );
});