import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { render } from "ink-testing-library";

import {
  TaskGraph,
  WorkflowApplication,
  WorkflowCodingSession,
  WorkflowTui,
  hostCapabilities,
  taskId,
  type WorkflowTask,
  type CodingSessionDriver,
} from "../src/index.js";

test("TUI renders canonical state and advances the selected task through application commands", async () => {
  const tasks: WorkflowTask[] = [{
    id: taskId("A"),
    title: "First task",
    state: "BLOCKED",
    dependencies: [],
    requiredEvidence: [],
  }];
  const application = new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
  const view = render(React.createElement(WorkflowTui, { application }));

  assert.match(view.lastFrame() ?? "", /ENFORCED \/ native/);
  assert.match(view.lastFrame() ?? "", /A\s+READY\s+First task/);

  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(view.lastFrame() ?? "", /A\s+IN_PROGRESS\s+First task/);
  assert.match(view.lastFrame() ?? "", /A: READY -> IN_PROGRESS/);
  view.unmount();
});

test("TUI inherits terminal colors instead of assigning semantic colors", () => {
  const source = readFileSync(new URL("../src/ui/tui.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:color|backgroundColor)=/);
});

test("TUI submits coding prompts and renders host-neutral session activity", async () => {
  let submitted = "";
  const driver: CodingSessionDriver = {
    async start(prompt, emit) {
      submitted = prompt;
      emit({ type: "status", status: "planning" });
      emit({ type: "assistant", text: "Inspecting repository" });
      emit({ type: "tool-proposal", tool: "read_files", subjects: ["README.md"] });
      emit({ type: "tool-outcome", tool: "read_files", outcome: "succeeded" });
      emit({ type: "completed", result: "Repository inspected" });
    },
    async cancel() {},
  };
  const application = new WorkflowApplication(new TaskGraph([]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const session = new WorkflowCodingSession(driver);
  const view = render(React.createElement(WorkflowTui, { application, session }));

  view.stdin.write("i");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("Inspect README");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(submitted, "Inspect README");
  assert.match(view.lastFrame() ?? "", /SESSION completed/);
  assert.match(view.lastFrame() ?? "", /planning/);
  assert.match(view.lastFrame() ?? "", /assistant: Inspecting repository/);
  assert.match(view.lastFrame() ?? "", /proposed read_files README\.md/);
  assert.match(view.lastFrame() ?? "", /read_files succeeded/);
  view.unmount();
});

test("TUI cancels a running coding session without changing canonical task state", async () => {
  let cancelled = false;
  let release!: () => void;
  const driver: CodingSessionDriver = {
    async start(_prompt, emit) {
      emit({ type: "status", status: "working" });
      await new Promise<void>((resolve) => { release = resolve; });
    },
    async cancel() {
      cancelled = true;
      release();
    },
  };
  const task: WorkflowTask = { id: taskId("A"), title: "Keep state", state: "BLOCKED", dependencies: [], requiredEvidence: [] };
  const application = new WorkflowApplication(new TaskGraph([task]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const session = new WorkflowCodingSession(driver);
  const view = render(React.createElement(WorkflowTui, { application, session }));

  view.stdin.write("i");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("Do work");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("x");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(cancelled, true);
  assert.match(view.lastFrame() ?? "", /SESSION cancelled/);
  assert.equal(application.snapshot().tasks[0]?.state, "READY");
  view.unmount();
});
