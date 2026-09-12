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

test("patched Cline retains bounded truecolor frame rendering for Workflow status sprites", () => {
  const trackedRobot = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "tui", "components", "tracked-robot.tsx"),
    "utf8",
  );
  assert.match(trackedRobot, /decoded\.frames\.length <= 120/);
  assert.match(trackedRobot, /WORKFLOW_TUI_ANIMATION_PATH/);
  assert.match(trackedRobot, /readFileSync\(path, "utf8"\)/);
  assert.ok((trackedRobot.match(/readFileSync\(/g)?.length ?? 0) >= 1);
  assert.match(trackedRobot, /useRef<ReturnType<typeof loadWorkflowAnimation> \| null>\(null\)/);
  assert.match(trackedRobot, /workflowAnimation\.current === null\) workflowAnimation\.current = loadWorkflowAnimation\(workflowAnimationPath\)/);
  assert.doesNotMatch(trackedRobot, /useRef\(loadWorkflowAnimation\(/);
  assert.match(trackedRobot, /Number\.isFinite\(decoded\?\.frameRate\)/);
  assert.match(trackedRobot, /decoded\.delays\.length === decoded\.frames\?\.length/);
  assert.match(trackedRobot, /workflowAnimation\.current\?\.width/);
  assert.match(trackedRobot, /workflowAnimation\.current\?\.height/);
  assert.match(trackedRobot, /Date\.now\(\) - workflowStartedAt\.current/);
  assert.match(trackedRobot, /lines\.length > 10_000/);
  assert.match(trackedRobot, /line\.length > 10_000/);
  assert.match(trackedRobot, /\/\^\[\\x20-\\x7e▀▄█\]\*\$\/u/);
  assert.match(trackedRobot, /fitWorkflowFrame/);
  assert.match(trackedRobot, /workflowWidth && workflowHeight \? workflowFrames\[workflowFrame\]! : fitWorkflowFrame/);
  assert.match(trackedRobot, /renderWorkflowFrame\(frame\)/);
  assert.match(trackedRobot, /<span key=.* fg=\{segment\.fg\} bg=\{segment\.bg\}>/);
	assert.match(trackedRobot, /padStart\(2, "0"\)/);
	assert.doesNotMatch(trackedRobot, /`rgb\(\$\{red\},\$\{green\},\$\{blue\}\)`/);
  assert.match(trackedRobot, /props\.animationWidth/);
  assert.match(trackedRobot, /props\.animationHeight/);
  assert.match(trackedRobot, /catch \{/);
});

test("TUI launcher does not load the old start-page raven artwork", () => {
  const launcher = readFileSync(resolve(process.cwd(), "src", "cli", "tui.tsx"), "utf8");
  assert.doesNotMatch(launcher, /raven-small\.ans|homeArt|WORKFLOW_TUI_ANIMATION_PATH/);
});

test("patched Cline accepts only bounded truecolor SGR artwork outside printable ASCII", () => {
  const trackedRobot = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "tui", "components", "tracked-robot.tsx"),
    "utf8",
  );
  assert.match(trackedRobot, /stripWorkflowSgr/);
  assert.match(trackedRobot, /validateWorkflowFrame/);
  assert.match(trackedRobot, /line\.matchAll\(WORKFLOW_SGR\)/);
  assert.match(trackedRobot, /\(\?:38\|48\);2/);
  assert.match(trackedRobot, /\\x7e▀▄█/u);
  assert.match(trackedRobot, /visibleLine\.length === width/);
});

test("patched Cline home no longer reserves space for large Workflow artwork", () => {
  const homeView = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "tui", "views", "home-view.tsx"),
    "utf8",
  );
  assert.doesNotMatch(homeView, /TrackedRobot|maxAnimationHeight|maxAnimationWidth|animationWidth|animationHeight/);
});

test("Workflow home removes the large artwork without adding a status sprite", () => {
  const homeView = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "tui", "views", "home-view.tsx"),
    "utf8",
  );
  const statusBar = readFileSync(
    resolve(process.cwd(), ".workflow-cline", "cline", "apps", "cli", "src", "tui", "components", "status-bar.tsx"),
    "utf8",
  );
  const launcher = readFileSync(resolve(process.cwd(), "src", "cli", "tui.tsx"), "utf8");

  assert.doesNotMatch(homeView, /<TrackedRobot/);
  assert.doesNotMatch(launcher, /CROW|Crow|crow|WORKFLOW_TUI_STATUS_ANIMATION_PATH/);
  assert.doesNotMatch(statusBar, /WorkflowCrow|resolveWorkflowCrowState|WORKFLOW_TUI_STATUS_ANIMATION_PATH/);
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
