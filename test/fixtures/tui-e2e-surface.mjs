#!/usr/bin/env node
/**
 * E2E surface fixture: mirrors the composer-bearing CLI entries
 * (acp-tui.tsx / universal-tui.tsx / ink-tui.tsx standalone) exactly —
 * OSC 11 detection BEFORE render, then WorkflowTui over a real session —
 * with a scripted driver instead of a spawned agent. Driven over a real
 * PTY by test/tui-e2e.test.ts.
 */
import React from "react";
import { render } from "ink";

import {
  TaskGraph,
  WorkflowApplication,
  WorkflowCodingSession,
  WorkflowTui,
  hostCapabilities,
  taskId,
} from "../../src/index.js";
import { detectTerminalBackground } from "../../src/ui/terminal-theme.js";

const task = {
  id: taskId("E2E"),
  title: "E2E surface exercise",
  state: "IN_PROGRESS",
  dependencies: [],
  requiredEvidence: [],
};
const application = new WorkflowApplication(
  new TaskGraph([task]),
  hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  [],
  new Set(["read", "mutation", "process"]),
  process.cwd(),
);

const driver = {
  async start(prompt, emit) {
    emit({ type: "status", status: "planning" });
    emit({ type: "tool-proposal", tool: "read_files", subjects: ["README.md"] });
    emit({ type: "log", level: "info", message: "checking the graph invariants", source: "agent-thought" });
    // Hold the turn open briefly so the running phase (spinner, in-flight
    // tool) is observable in the rendered frames.
    await new Promise((resolve) => setTimeout(resolve, 400));
    emit({ type: "tool-outcome", tool: "read_files", outcome: "succeeded" });
    emit({ type: "assistant", text: `e2e assistant reply: ${prompt}` });
    emit({ type: "completed", result: "e2e turn complete" });
  },
  async cancel() {},
};
const session = new WorkflowCodingSession(driver);

const composerBackground = await detectTerminalBackground();
const { waitUntilExit } = render(React.createElement(WorkflowTui, {
  application,
  session,
  connectionLabel: "e2e",
  ...(composerBackground === undefined ? {} : { composerBackground }),
}));
await waitUntilExit();
