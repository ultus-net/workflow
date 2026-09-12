import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { spawn } from "node-pty";
import { resolveTuiWorkspace } from "../src/cli/tui-args.js";

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

test("patched Cline refuses interactive startup without the Workflow authorization bridge", async () => {
  const clineRoot = resolve(process.cwd(), ".workflow-cline", "cline");
  const env = { ...process.env };
  delete env.WORKFLOW_CLINE_BRIDGE_URL;
  delete env.WORKFLOW_CLINE_BRIDGE_TOKEN;
  let output = "";
  const terminal = spawn(
    "npx",
    ["--yes", "bun@1.3.13", "run", "--cwd", clineRoot, "cli", "--", "-i", "--cwd", process.cwd()],
    { name: "xterm", cols: 100, rows: 30, cwd: process.cwd(), env: { ...env, TERM: "xterm" } },
  );
  terminal.onData((chunk) => { output += chunk; });
  const exitCode = await new Promise<number>((resolveExit) => terminal.onExit(({ exitCode }) => resolveExit(exitCode)));
  assert.notEqual(exitCode, 0, output);
  assert.match(output, /Workflow authorization bridge is required for this Cline build/);
});
