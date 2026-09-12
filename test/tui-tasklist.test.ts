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
  const deadline = Date.now() + 1_000;
  while (!expected.test(view.lastFrame() ?? "") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
