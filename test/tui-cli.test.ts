import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { spawn as spawnPty } from "node-pty";
import { resolveTuiWorkspace } from "../src/cli/tui-args.js";

test("TUI workspace accepts Cline-compatible --cwd and -c arguments", () => {
  assert.equal(resolveTuiWorkspace(["--cwd", "/tmp/project"], "/fallback"), "/tmp/project");
  assert.equal(resolveTuiWorkspace(["-c", "relative/project"], "/fallback"), "/fallback/relative/project");
  assert.equal(resolveTuiWorkspace([], "/fallback"), "/fallback");
});

test("TUI workspace rejects a missing cwd value", () => {
  assert.throws(() => resolveTuiWorkspace(["--cwd"], "/fallback"), /requires a path/);
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
