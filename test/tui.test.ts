import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { render } from "ink-testing-library";

import {
  TaskGraph,
  WorkflowApplication,
  WorkflowTui,
  hostCapabilities,
  taskId,
  type WorkflowTask,
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
