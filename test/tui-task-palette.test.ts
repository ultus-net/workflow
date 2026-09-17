import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";

import {
  TaskGraph,
  WorkflowApplication,
  WorkflowTui,
  createTaskCommandPort,
  hostCapabilities,
  taskId,
  type WorkflowTask,
} from "../src/index.js";

// Palette tests mount the full TUI; a view leaked by a failing assertion
// would keep the 1s monitor poll alive past the results. Unmount everything.
afterEach(() => cleanup());

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
  application.selectActiveTask(taskId("B"));
  return application;
}

async function waitForFrame(view: { lastFrame(): string | undefined }, expected: RegExp): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!expected.test(view.lastFrame() ?? "") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Ctrl+T opens the task palette: tasks, states, and the active marker render", async () => {
  const application = createApplication();
  const view = render(React.createElement(WorkflowTui, {
    application,
    taskCommands: createTaskCommandPort(application),
  }));

  view.stdin.write("\x14");
  await waitForFrame(view, /Task palette/);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /◂ active/, "the port's active-task pointer marks the selected task");
  assert.match(frame, /VERIFIED/);
  assert.match(frame, /IN_PROGRESS/);
  assert.match(frame, /BLOCKED/);
  assert.match(frame, /a\/↵ activate/);
});

test("create through the palette adds a canonical task; activating it moves the authorization target", async () => {
  const application = createApplication();
  const port = createTaskCommandPort(application);
  const view = render(React.createElement(WorkflowTui, {
    application,
    taskCommands: port,
  }));

  view.stdin.write("\x14");
  await waitForFrame(view, /Task palette/);
  view.stdin.write("n");
  await waitForFrame(view, /new task title:/);
  view.stdin.write("Write the dogfood notes");
  view.stdin.write("\r");
  await waitForFrame(view, /created interactive-task-/);

  const created = application.snapshot().tasks.find((task) => task.title === "Write the dogfood notes");
  assert.ok(created !== undefined, "the palette created a canonical task through the port");
  assert.equal(created.state, "READY", "a dependency-free created task derives READY");

  // Cursor to the new task (appended last) and activate it.
  view.stdin.write("\u001B[B");
  view.stdin.write("\u001B[B");
  view.stdin.write("\u001B[B");
  view.stdin.write("a");
  await waitForFrame(view, /activated interactive-task-/);

  // Re-read: snapshots are copies, so the pre-activation reference is stale.
  const after = application.snapshot().tasks.find((task) => task.title === "Write the dogfood notes");
  assert.equal(after?.state, "IN_PROGRESS", "activation moved the task to IN_PROGRESS");
  assert.equal(port.activeTaskId(), after?.id, "the active pointer (the authorization target) follows the palette activation");
});

test("kernel rejections surface in the palette and never move canonical state", async () => {
  const application = createApplication();
  const view = render(React.createElement(WorkflowTui, {
    application,
    taskCommands: createTaskCommandPort(application),
  }));

  view.stdin.write("\x14");
  await waitForFrame(view, /Task palette/);
  // Cursor rests on task A (VERIFIED) — activating a VERIFIED task is
  // refused by the port/kernel with an operator-visible message.
  view.stdin.write("a");
  await waitForFrame(view, /✗ cannot activate/);
  assert.equal(
    application.snapshot().tasks.find((task) => task.id === taskId("A"))?.state,
    "VERIFIED",
    "the refused activation left the kernel state untouched",
  );
});

test("without a task port the palette is read-only and mutation keys are inert", async () => {
  const application = createApplication();
  const view = render(React.createElement(WorkflowTui, { application }));

  view.stdin.write("\x14");
  await waitForFrame(view, /read-only: this surface composes no task-command port/);
  view.stdin.write("n");
  const frame = view.lastFrame() ?? "";
  assert.doesNotMatch(frame, /new task title:/, "the create key must be inert without a port");
  assert.match(frame, /read-only/);
});
