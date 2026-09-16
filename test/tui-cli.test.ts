import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { spawn as spawnPty } from "node-pty";
import { resolveTuiWorkspace } from "../src/cli/tui-args.js";
import { resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import { clineEnv } from "../.workflow-cline/cline/apps/cli/src/tests/helpers/env.js";

test("TUI workspace accepts Cline-compatible --cwd and -c arguments", () => {
  assert.equal(resolveTuiWorkspace(["--cwd", "/tmp/project"], "/fallback"), "/tmp/project");
  assert.equal(resolveTuiWorkspace(["-c", "relative/project"], "/fallback"), "/fallback/relative/project");
  assert.equal(resolveTuiWorkspace([], "/fallback"), "/fallback");
});

test("TUI workspace rejects a missing cwd value", () => {
  assert.throws(() => resolveTuiWorkspace(["--cwd"], "/fallback"), /requires a path/);
});

test("TUI launcher exposes no artwork hooks", () => {
  const launcher = readFileSync(resolve(process.cwd(), "src", "cli", "tui.tsx"), "utf8");
  assert.doesNotMatch(launcher, /raven-small\.ans|homeArt|WORKFLOW_TUI_ANIMATION_PATH|WORKFLOW_TUI_STATUS_ANIMATION_PATH|WORKFLOW_TUI_MARK_B64/);
});

test("TUI launcher registers vendored toolbox MCP servers at a persistent path", () => {
  const launcher = readFileSync(resolve(process.cwd(), "src", "cli", "tui.tsx"), "utf8");
  assert.match(launcher, /preparePersistentMcpSettings/);
  assert.match(launcher, /CLINE_MCP_SETTINGS_PATH/);
  assert.match(launcher, /cline_mcp_settings\.json/);
});

test("TUI launcher leaves interactive SIGINT handling to Cline", () => {
  const launcher = readFileSync(resolve(process.cwd(), "src", "cli", "tui.tsx"), "utf8");
  assert.match(launcher, /process\.on\(["']SIGINT["'],\s*\(\)\s*=>\s*\{\}\)/);
});

test("Workflow-launched TUI keeps Ctrl+C local to the active turn", { timeout: 90_000 }, async (t) => {
  const env = clineEnv("default", {
    CLINE_VCR_CASSETTE: resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "tests", "fixtures", "headless-yolo-basic.json"),
    CLINE_SESSION_BACKEND_MODE: "local",
    npm_config_cache: resolve(process.env.HOME ?? tmpdir(), ".npm"),
    // W044 PTY-suite hygiene: this suite starts its own hub child and the
    // PTY TUI must REUSE it — autohub stays off so a probe failure fails
    // the test loudly instead of leaving an unowned detached hub behind.
    WORKFLOW_AUTOHUB: "0",
  });
  const home = env.HOME;
  assert.ok(home);
  const hub = spawnChild(process.execPath, ["--import", "tsx", "src/cli/hub.ts"], {
    cwd: process.cwd(),
    env,
    stdio: "ignore",
  });
  t.after(() => { if (hub.exitCode === null) hub.kill("SIGTERM"); });

  const discoveryPath = resolveHubDiscoveryPath(resolve(home, ".workflow"));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      readFileSync(discoveryPath);
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  assert.doesNotThrow(() => readFileSync(discoveryPath), "Workflow hub did not become ready");

  let output = "";
  const terminal = spawnPty(process.execPath, ["--import", "tsx", "src/cli/tui.tsx", "--cwd", process.cwd()], {
    name: "xterm",
    cols: 120,
    rows: 50,
    cwd: process.cwd(),
    env: { ...env, TERM: "xterm" },
  });
  terminal.onData((chunk) => { output += chunk; });
  t.after(() => { try { terminal.kill(); } catch { /* PTY cleanup is best-effort */ } });

  const waitForOutput = async (text: string, timeout = 15_000) => {
    const started = Date.now();
    while (!output.includes(text)) {
      if (Date.now() - started > timeout) assert.fail(`Timed out waiting for ${JSON.stringify(text)}\n${output.slice(-2_000)}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    output = "";
  };
  const submit = async (text: string) => {
    terminal.write(text);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    terminal.write("\r");
  };

  await waitForOutput("What can I do for you?", 45_000);
  await submit("tell me a joke");
  await waitForOutput("Why", 30_000);
  terminal.write("\x03");
  await submit("/settings");
  await waitForOutput("Auto-approve all");
});

test("patched Cline zen and connector sessions attach the Workflow bridge localRuntime", () => {
  const zen = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "runtime", "run-zen.ts"),
    "utf8",
  );
  const connector = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "connectors", "session-runtime.ts"),
    "utf8",
  );
  const helper = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "utils", "workflow-bridge-local-runtime.ts"),
    "utf8",
  );
  assert.match(zen, /workflowBridgeLocalRuntime/);
  assert.match(connector, /workflowBridgeLocalRuntime/);
  assert.match(helper, /createWorkflowBridge\(\)\.authorize\(undefined\)/);
});

test("patched Cline headless mode is flow through the Workflow authorization bridge", () => {
  const runAgent = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "runtime", "run-agent.ts"),
    "utf8",
  );
  assert.match(runAgent, /createWorkflowBridge/);
  assert.match(runAgent, /workflow\.authorize\(runtimeHooks\.hooks\)/);
});

test("patched Cline renders the Workflow task list only after entering chat", () => {
  const chatView = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "tui", "views", "chat-view.tsx"),
    "utf8",
  );
  const homeView = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "tui", "views", "home-view.tsx"),
    "utf8",
  );
  const bridge = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "utils", "workflow-bridge.ts"),
    "utf8",
  );
  assert.match(chatView, /WorkflowTaskList/);
  assert.doesNotMatch(homeView, /WorkflowTaskList/);
  assert.match(bridge, /\/snapshot/);
  assert.match(chatView, /if \(available !== true \|\| tasks\.length === 0\) return null/);
  assert.match(chatView, /createWorkflowSnapshotPoller/);
  assert.match(chatView, /const \[expanded, setExpanded\] = useState\(true\)/);
  assert.match(chatView, /onMouseDown=\{\(\) => setExpanded\(!expanded\)\}/);
  assert.match(chatView, /expanded \? "v" : ">"/);
  assert.match(chatView, /\{expanded \? \(/);
  assert.match(bridge, /onState\(\{ available: false, tasks: \[\] \}\)/);
  assert.match(bridge, /active && requestGeneration === generation/);
  assert.doesNotMatch(chatView, /authority unavailable/);
});

test("a TUI launch that auto-spawns the hub reaps it on exit — the spawned-process count returns to baseline", { timeout: 120_000 }, async (t) => {
  // W044 end-to-end: no hub exists in this HOME, so the launcher's autohub
  // path must spawn one AND own it. When the session exits (here: SIGHUP via
  // PTY close, the terminal-hangup path), the owned hub must be terminated
  // and its discovery/lock artifacts removed — no orphaned daemon survives.
  const home = mkdtempSync(resolve(tmpdir(), "workflow-tui-reap-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const workflowDir = resolve(home, ".workflow");
  const discoveryPath = resolveHubDiscoveryPath(workflowDir);
  const lockPidPath = resolve(workflowDir, "hub", "lock", "pid");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TERM: "xterm",
    npm_config_cache: resolve(process.env.HOME ?? tmpdir(), ".npm"),
  };

  let output = "";
  const terminal = spawnPty(process.execPath, ["--import", "tsx", "src/cli/tui.tsx", "--cwd", process.cwd()], {
    name: "xterm",
    cols: 120,
    rows: 50,
    cwd: process.cwd(),
    env,
  });
  terminal.onData((chunk) => { output += chunk; });
  t.after(() => { try { terminal.kill(); } catch { /* best-effort */ } });

  // Wait for the auto-spawned hub to publish its discovery and lock pid.
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    try {
      readFileSync(discoveryPath);
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  assert.doesNotThrow(() => readFileSync(discoveryPath), `auto-spawned hub never published discovery\n${output.slice(-2_000)}`);
  const hubPid = Number(readFileSync(lockPidPath, "utf8"));
  assert.ok(Number.isInteger(hubPid) && hubPid > 0, "the hub lock must record its pid");
  try {
    process.kill(hubPid, 0);
  } catch {
    assert.fail("the auto-spawned hub daemon must be alive while the session runs");
  }

  // Session exit: close the PTY (SIGHUP to the launcher — the terminal-hangup
  // path an operator gets by closing their terminal).
  terminal.kill();
  await new Promise<void>((resolveExit) => terminal.onExit(() => resolveExit()));

  // The owned hub is terminated: its pid dies and its artifacts are gone.
  const reapDeadline = Date.now() + 15_000;
  while (Date.now() < reapDeadline) {
    let alive = true;
    try {
      process.kill(hubPid, 0);
    } catch {
      alive = false;
    }
    if (!alive) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  let hubAlive = true;
  try {
    process.kill(hubPid, 0);
  } catch {
    hubAlive = false;
  }
  assert.equal(hubAlive, false, "the owned hub daemon must not survive session exit");
  assert.throws(() => readFileSync(discoveryPath), "a reaped hub removes its discovery file");
  assert.throws(() => readFileSync(lockPidPath), "a reaped hub releases its instance lock");
});

test("patched Cline refuses interactive startup without the Workflow authorization bridge", async () => {
  const clineRoot = resolve(process.cwd(), ".workflow-cline", "cline");
  const home = mkdtempSync(resolve(tmpdir(), "workflow-cline-no-bridge-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.WORKFLOW_CLINE_BRIDGE_URL;
  delete env.WORKFLOW_CLINE_BRIDGE_TOKEN;
  let output = "";
  const terminal = spawnPty(
    "npx",
    ["--yes", "bun@1.3.13", "run", "--cwd", clineRoot, "cli", "--", "-i", "--cwd", process.cwd()],
    { name: "xterm", cols: 100, rows: 30, cwd: process.cwd(), env: { ...env, TERM: "xterm" } },
  );
  terminal.onData((chunk) => { output += chunk; });
  try {
    const exitCode = await new Promise<number>((resolveExit) => terminal.onExit(({ exitCode }) => resolveExit(exitCode)));
    assert.notEqual(exitCode, 0, output);
    assert.match(output, /Workflow authorization bridge is required for this Cline build/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
