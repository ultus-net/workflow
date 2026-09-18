import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";

import { WorkflowCodingSession, type CodingSessionEvent } from "../src/application/coding-session.js";
import { taskId, type PolicyDecision } from "../src/kernel/contracts.js";
import { AcpSessionDriver, turnTimeoutMs } from "../src/integrations/acp-session.js";
import { WorkflowTui } from "../src/ui/tui.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import type { ProposedToolAction } from "../src/adapters/host.js";

/**
 * W047: G5 error surfacing + G7 context visibility. Every failure surfaces
 * with an actionable cause; agent-emitted usage/context signals project into
 * the session record as ADVISORY context; the unknown-method and watchdog
 * boundaries are pinned. Visibility is never upgraded to control.
 */

function fakeAgent(mode: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["test/fixtures/fake-acp-agent.mjs", mode], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function driverFor(mode: string, authorize: (action: ProposedToolAction) => PolicyDecision | Promise<PolicyDecision> = () => ({ kind: "allow" })): {
  driver: AcpSessionDriver;
  child: ChildProcessWithoutNullStreams;
  session: WorkflowCodingSession;
  events: CodingSessionEvent[];
} {
  const child = fakeAgent(mode);
  const driver = new AcpSessionDriver({
    child,
    authorize,
    workspace: "/repo",
    workspaceSessionId: "workflow-session",
    taskId: taskId("W047-TEST"),
  });
  const session = new WorkflowCodingSession(driver);
  const events: CodingSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { driver, child, session, events };
}

async function reapChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
}

async function waitForFrame(view: { lastFrame(): string | undefined }, expected: RegExp): Promise<void> {
  const deadline = Date.now() + 4_000;
  // Normalize whitespace inside the loop too: ink may wrap long lines
  // (e.g. `fail-closed:` split across rows), so match the collapsed frame.
  const normalized = () => (view.lastFrame() ?? "").replace(/\s+/g, " ");
  while (!expected.test(normalized()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The wait loop is not allowed to vacuously pass: assert the frame
  // actually matched.
  assert.ok(expected.test(normalized()), `frame never matched ${String(expected)}; last frame:\n${view.lastFrame() ?? ""}`);
}

// ── G5: crash paths surface with actionable causes ────────────────────────

test("an agent crash mid-turn surfaces as a failed turn with the exit cause — never a hang", async () => {
  const { driver, child, session, events } = driverFor("crash-mid-turn");
  try {
    // runTurn catches the driver throw itself and records the failure; the
    // submit resolves once the failed turn is recorded.
    await session.submit("please crash");
  } finally {
    await driver.dispose();
    await reapChild(child);
  }
  const snapshot = session.snapshot();
  assert.equal(snapshot.state, "failed");
  if (snapshot.state === "failed") assert.match(snapshot.reason, /ACP agent exited/);
  const failure = events.find((event) => event.type === "failed");
  assert.ok(failure !== undefined && failure.type === "failed", "the failure reaches session subscribers");
  if (failure.type === "failed") assert.match(failure.reason, /ACP agent exited/);
});

test("an agent crash between turns surfaces on the next prompt as a closed-client cause", async () => {
  const { driver, child, session } = driverFor("crash-idle");
  try {
    await session.submit("first turn");
    assert.equal(session.snapshot().state, "completed");
    // The agent exits ~10ms after its first end_turn.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await session.submit("second turn");
    const snapshot = session.snapshot();
    assert.equal(snapshot.state, "failed");
    if (snapshot.state === "failed") assert.match(snapshot.reason, /ACP client is closed|ACP agent exited/);
  } finally {
    await driver.dispose();
    await reapChild(child);
  }
});

test("a fail-closed permission denial threads its wire cause into the failed turn", async () => {
  const { driver, child, session } = driverFor("permission-no-reject", () => ({
    kind: "deny",
    code: "WORKSPACE_PATH_DENIED",
    reason: "outside the workspace",
  }));
  try {
    await session.submit("edit the file");
    const snapshot = session.snapshot();
    assert.equal(snapshot.state, "failed");
    if (snapshot.state === "failed") {
      assert.match(snapshot.reason, /ACP turn cancelled by the agent \(fail-closed: no_reject_option\)/);
    }
  } finally {
    await driver.dispose();
    await reapChild(child);
  }
});

// ── The turn watchdog (optional, operator-armed) ───────────────────────────

test("turnTimeoutMs parses the env gate fail-closed", () => {
  assert.equal(turnTimeoutMs({}), undefined);
  assert.equal(turnTimeoutMs({ WORKFLOW_ACP_TURN_TIMEOUT_MS: "250" }), 250);
  assert.throws(() => turnTimeoutMs({ WORKFLOW_ACP_TURN_TIMEOUT_MS: "soon" }), /positive number/);
  assert.throws(() => turnTimeoutMs({ WORKFLOW_ACP_TURN_TIMEOUT_MS: "-1" }), /positive number/);
});

test("a hung turn surfaces through the armed watchdog instead of hanging forever", async () => {
  const previous = process.env.WORKFLOW_ACP_TURN_TIMEOUT_MS;
  process.env.WORKFLOW_ACP_TURN_TIMEOUT_MS = "150";
  const { driver, child, session } = driverFor("hang");
  try {
    const started = Date.now();
    await session.submit("hang the turn");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `the watchdog must end the turn, not the test timeout (took ${elapsed}ms)`);
    const snapshot = session.snapshot();
    assert.equal(snapshot.state, "failed");
    if (snapshot.state === "failed") {
      assert.match(snapshot.reason, /exceeded WORKFLOW_ACP_TURN_TIMEOUT_MS=150ms/);
      assert.match(snapshot.reason, /cancel the turn or restart the session/);
    }
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_ACP_TURN_TIMEOUT_MS;
    else process.env.WORKFLOW_ACP_TURN_TIMEOUT_MS = previous;
    await driver.dispose();
    await reapChild(child);
  }
});

// ── G7: context signals project into the session record (advisory) ─────────

test("a standard usage_update projects into the session record as advisory agent-context", async () => {
  const { driver, child, session, events } = driverFor("usage-update");
  try {
    await session.submit("use some tokens");
    const context = events.find((event) => event.type === "agent-context");
    assert.ok(context !== undefined, "usage_update must reach the session record");
    if (context.type === "agent-context") {
      assert.equal(context.kind, "usage_update");
      const payload = context.payload as { totalTokens?: number; costUsd?: number };
      assert.equal(payload.totalTokens, 100);
    }
    assert.equal(session.snapshot().state, "completed", "advisory context never disturbs the turn");
  } finally {
    await driver.dispose();
    await reapChild(child);
  }
});

test("goose-style agent-custom notifications are tolerated and project — requests stay fail-closed", async () => {
  const { driver, child, session, events } = driverFor("goose-usage");
  try {
    await session.submit("emit the goose usage channel");
    const contexts = events.filter((event) => event.type === "agent-context");
    assert.ok(contexts.length >= 2, "both the nested-update channel and the raw custom notification project");
    const usage = contexts.find((event) => event.type === "agent-context" && event.kind === "usage_update");
    assert.ok(usage !== undefined, "the _goose/unstable/session/update nested payload projects as usage_update");
    const raw = contexts.find((event) => event.type === "agent-context" && event.kind === "agent_custom");
    assert.ok(raw !== undefined, "a custom notification without a nested update projects as agent_custom");
    if (raw.type === "agent-context") {
      const payload = raw.payload as { method?: string };
      assert.equal(payload.method, "_goose/unstable/status");
    }
    assert.equal(session.snapshot().state, "completed", "the turn still completes normally");
  } finally {
    await driver.dispose();
    await reapChild(child);
  }
});

test("an agent-custom REQUEST (with an id) stays fail-closed and tears the connection down", async () => {
  const { driver, child, session } = driverFor("custom-request");
  try {
    await session.submit("send a custom request");
    const snapshot = session.snapshot();
    assert.equal(snapshot.state, "failed");
    if (snapshot.state === "failed") assert.match(snapshot.reason, /unsupported ACP method: _custom\/needs-an-answer/);
  } finally {
    await driver.dispose();
    await reapChild(child);
  }
});

// ── TUI rendering of the surfaced failure and advisory context ─────────────

function createApplication(): WorkflowApplication {
  const application = new WorkflowApplication(
    new TaskGraph([{ id: taskId("W047-RENDER"), title: "W047 render", state: "IN_PROGRESS", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation"]),
    "/repo",
  );
  application.startInteractiveTask();
  return application;
}

test("the TUI renders a failed turn's actionable reason as a red row", async () => {
  const session = new WorkflowCodingSession({
    async start(_prompt, emit) {
      emit({ type: "failed", reason: "ACP turn cancelled by the agent (fail-closed: no_reject_option)" });
    },
    async cancel() {},
  });
  const view = render(React.createElement(WorkflowTui, { application: createApplication(), session }));
  // Drive the turn through the TUI's own composer (the queue-test pattern):
  // direct session.submit bypasses the composer and predates this work with
  // an ink-testing-library render quirk on completed turns.
  view.stdin.write("go");
  view.stdin.write("\r");
  await waitForFrame(view, /fail-closed: no_reject_option/);
  view.unmount();
  cleanup();
});

test("the TUI renders advisory agent-context as a dim [context] row", async () => {
  const session = new WorkflowCodingSession({
    async start(_prompt, emit) {
      emit({ type: "agent-context", kind: "usage_update", payload: { totalTokens: 250, costUsd: 0.02 } });
      emit({ type: "completed", result: "ok" });
    },
    async cancel() {},
  });
  const view = render(React.createElement(WorkflowTui, { application: createApplication(), session }));
  // Same composer-driven submit as the failed-row render test.
  view.stdin.write("go");
  view.stdin.write("\r");
  await waitForFrame(view, /usage_update: totalTokens 250 · \$0\.02/);
  view.unmount();
  cleanup();
});

// ── Launcher boot catches: failures print an actionable cause ─────────────

test("the ACP TUI catches composition failures with a blocking-reason-style cause", () => {
  const source = readFileSync(join(process.cwd(), "src", "cli", "acp-tui.tsx"), "utf8");
  assert.match(source, /failed to start the contained session/, "boot failures must print an actionable cause, not a raw stack");
  assert.match(source, /process\.exit\(1\)/);
});

test("the universal TUI catches composition failures with a blocking-reason-style cause", () => {
  const source = readFileSync(join(process.cwd(), "src", "cli", "universal-tui.tsx"), "utf8");
  assert.match(source, /failed to start the composed/, "boot failures must print an actionable cause, not a raw stack");
  assert.match(source, /process\.exit\(1\)/);
  assert.match(source, /composed\?\.dispose\(\)/, "the finally must tolerate a composition that never produced a driver");
});
