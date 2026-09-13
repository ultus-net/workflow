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

test("legacy Ink projection keeps Workflow status compact and diagnostics secondary", async () => {
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

  assert.match(view.lastFrame() ?? "", /Workflow.*ENFORCED.*native/);
  assert.match(view.lastFrame() ?? "", /1 ready/);
  assert.doesNotMatch(view.lastFrame() ?? "", /\bTASKS\b|\bEVIDENCE\b|\bHISTORY\b/);

  view.stdin.write("\u0017");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(view.lastFrame() ?? "", /A\s+READY\s+First task/);
  view.unmount();
});

test("legacy Ink projection keeps its composition bounded", () => {
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
  const view = render(React.createElement(WorkflowTui, { application }));

  const lines = (view.lastFrame() ?? "").split("\n");
  const contentWidths = lines.map((line) => line.trimEnd().length - line.search(/\S|$/));
  assert.ok(contentWidths.every((width) => width <= 68), `expected a 68-column composition:\n${lines.join("\n")}`);
  view.unmount();
});

test("legacy Ink projection inherits terminal colors instead of assigning semantic colors", () => {
  const source = readFileSync(new URL("../src/ui/tui.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:color|backgroundColor|bgColor|borderColor)\s*=/);
});

test("legacy Ink projection renders conversation and tool activity", async () => {
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

  assert.match(view.lastFrame() ?? "", /What do you want to build\?/);
  view.stdin.write("Inspect README");
  await waitForFrame(view, /> Inspect README/);
  assert.match(view.lastFrame() ?? "", /> Inspect README/);
  view.stdin.write("\r");
  await waitForFrame(view, /completed.*Repository inspected/);

  assert.equal(submitted, "Inspect README");
  assert.match(view.lastFrame() ?? "", /You\s+Inspect README/);
  assert.match(view.lastFrame() ?? "", /Cline\s+Inspecting repository/);
  assert.match(view.lastFrame() ?? "", /\[tool\]\s+read_files\s+README\.md/);
  assert.match(view.lastFrame() ?? "", /\[ok\]\s+read_files/);
  assert.match(view.lastFrame() ?? "", /completed.*Repository inspected/);
  view.unmount();
});

async function waitForFrame(view: { lastFrame(): string | undefined }, expected: RegExp): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!expected.test(view.lastFrame() ?? "") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("legacy Ink projection cancels a coding session without changing canonical task state", async () => {
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

  view.stdin.write("Do work");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("\u0003");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(cancelled, true);
  assert.match(view.lastFrame() ?? "", /cancelled/);
  assert.equal(application.snapshot().tasks[0]?.state, "READY");
  view.unmount();
});
