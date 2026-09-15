import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";

import {
  TaskGraph,
  WorkflowApplication,
  WorkflowCodingSession,
  WorkflowTui,
  hostCapabilities,
  taskId,
  type CodingSessionDriver,
  type WorkflowTask,
} from "../src/index.js";

function createApplication(): WorkflowApplication {
  const tasks: WorkflowTask[] = [
    { id: taskId("A"), title: "Foundation work", state: "BLOCKED", dependencies: [], requiredEvidence: [] },
    { id: taskId("B"), title: "Feature work", state: "BLOCKED", dependencies: [taskId("A")], requiredEvidence: [] },
    { id: taskId("C"), title: "Polish", state: "BLOCKED", dependencies: [taskId("B")], requiredEvidence: [] },
  ];
  const application = new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
  application.transition(taskId("A"), "IN_PROGRESS");
  application.transition(taskId("A"), "VERIFYING");
  application.transition(taskId("A"), "VERIFIED");
  application.transition(taskId("B"), "IN_PROGRESS");
  return application;
}

async function waitForFrame(view: { lastFrame(): string | undefined }, expected: RegExp): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!expected.test(view.lastFrame() ?? "") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("TUI activity panel lists open review follow-ups", () => {
  const view = render(React.createElement(WorkflowTui, {
    application: createApplication(),
    reviewFollowUps: [
      { severity: "P2", summary: "missing edge coverage", paths: ["src/x.ts"], id: "1", reviewId: "r1", status: "open", createdAt: 1 },
      { severity: "P3", summary: "nit: naming", paths: [], id: "2", reviewId: "r1", status: "open", createdAt: 2 },
    ],
  }));

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /review follow-ups/i);
  assert.match(frame, /2 open/);
  assert.match(frame, /missing edge coverage/);
  view.unmount();
});


test("TUI renders an always-visible task list with states and progress", () => {
  const view = render(React.createElement(WorkflowTui, { application: createApplication() }));

  const frame = view.lastFrame() ?? "";
  // No Ctrl+W needed: tasks, their states, and progress are always visible.
  assert.match(frame, /Foundation work/);
  assert.match(frame, /Feature work/);
  assert.match(frame, /VERIFIED/);
  assert.match(frame, /IN_PROGRESS/);
  assert.match(frame, /BLOCKED/);
  assert.match(frame, /1\/3 verified/i);
  view.unmount();
});

test("TUI transcript renders session log events with level tags", async () => {
  const driver: CodingSessionDriver = {
    async start(_prompt, emit) {
      emit({ type: "log", level: "info", message: "learning-mcp profile loaded", source: "learning-mcp" });
      emit({ type: "log", level: "warning", message: "budget nearly exhausted" });
      emit({ type: "completed", result: "done" });
    },
    async cancel() {},
  };
  const session = new WorkflowCodingSession(driver);
  const view = render(React.createElement(WorkflowTui, { application: createApplication(), session }));

  view.stdin.write("go");
  view.stdin.write("\r");
  await waitForFrame(view, /profile loaded/);

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /\[info\].*profile loaded/);
  assert.match(frame, /\[warning\].*budget nearly exhausted/);
  view.unmount();
});

test("TUI session activity shows tools in flight and recent logs", async () => {
  const driver: CodingSessionDriver = {
    async start(_prompt, emit) {
      emit({ type: "tool-proposal", tool: "execute_command", subjects: ["npm test"] });
      emit({ type: "log", level: "debug", message: "awaiting guard verdict" });
      // No tool-outcome: the tool stays in flight; session keeps running.
      await new Promise(() => {});
    },
    async cancel() {},
  };
  const session = new WorkflowCodingSession(driver);
  const view = render(React.createElement(WorkflowTui, { application: createApplication(), session }));

  view.stdin.write("go");
  view.stdin.write("\r");
  await waitForFrame(view, /awaiting guard verdict/);

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /execute_command/);
  assert.match(frame, /in flight|running/i);
  assert.match(frame, /awaiting guard verdict/);
  view.unmount();
});

// ── Plan Task A3: run-gate observability rows ──────────────────────────────

test("TUI activity panel surfaces blocking reasons, verdicts, and unverified claims", async () => {
  const view = render(React.createElement(WorkflowTui, {
    application: createApplication(),
    gateObservability: () => ({
      reviewOutcomes: {
        "schedule:nightly:abc": {
          reviewerRunId: "schedule:hub-reviewer-1",
          verdict: "changes_requested",
          recorded: false,
          summary: "weak coverage",
          parseFailure: "unparseable reviewer verdict: ???",
        },
      },
      blockingReasons: {
        "schedule:nightly:abc": "test evidence failed: 1 failing: expected 3, got 4",
      },
      completionClaims: {
        "schedule:nightly:abc": {
          runId: "schedule:nightly:abc",
          claim: "All tests pass and the feature is complete.",
          verifiedAtClaim: false,
          observedAt: "2026-09-15T00:00:00.000Z",
        },
      },
    }),
  }));
  await waitForFrame(view, /blocked runs \(1\)/);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /\[blocked\]/);
  assert.match(frame, /expected 3, got 4/);
  assert.match(frame, /review verdicts \(1\)/);
  assert.match(frame, /changes_requested/);
  assert.match(frame, /unparseable reviewer verdict/);
  assert.match(frame, /unverified completion claims \(1\)/);
  assert.match(frame, /\[unverified claim\]/);
  assert.match(frame, /All tests pass/);
  assert.match(frame, /feature is complete/);
  view.unmount();
});

test("TUI activity panel stays quiet when no gate observability exists", async () => {
  const view = render(React.createElement(WorkflowTui, { application: createApplication() }));
  await waitForFrame(view, /No live activity\./);
  const frame = view.lastFrame() ?? "";
  assert.equal(/blocked runs/.test(frame), false);
  assert.equal(/review verdicts/.test(frame), false);
  assert.equal(/unverified completion claims/.test(frame), false);
  view.unmount();
});

// ── Web-UI parity: thinking rows, usage meter, plan projection ────────────

test("thinking chunks render as dim [thinking] transcript rows", async () => {
  const driver: CodingSessionDriver = {
    async start(prompt, emit) {
      emit({ type: "assistant", text: "Let me look." });
      emit({ type: "log", level: "info", message: "considering the test files", source: "agent-thought" });
      emit({ type: "assistant", text: "Done." });
    },
    async cancel() {},
  };
  const session = new WorkflowCodingSession(driver);
  const view = render(React.createElement(WorkflowTui, { application: createApplication(), session }));
  await session.submit("go");
  await waitForFrame(view, /Done\./);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /\[thinking\]/);
  assert.match(frame, /considering the test files/);
  view.unmount();
});

test("the usage meter renders in the composer footer line", async () => {
  const view = render(React.createElement(WorkflowTui, {
    application: createApplication(),
    usage: () => "8668 tokens · $0.0132",
  }));
  await waitForFrame(view, /8668 tokens · \$0\.0132/);
  view.unmount();
});
