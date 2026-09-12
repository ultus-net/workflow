#!/usr/bin/env node
import React from "react";
import { render } from "ink";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { createConfiguredClineRuntime } from "../integrations/cline-runtime.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { WorkflowTui } from "../ui/tui.js";
import { resolveTuiWorkspace } from "./tui-args.js";

/**
 * The Workflow monitoring TUI: task graph, live session activity, and the
 * log-enriched transcript over a real Cline coding session. Run with:
 *   npm run tui:workflow
 */
const workspace = resolveTuiWorkspace(process.argv.slice(2), process.cwd());
const tasks: WorkflowTask[] = [
  {
    id: taskId("W001"),
    title: "Inspect the runnable Workflow TUI",
    state: "BLOCKED",
    dependencies: [],
    requiredEvidence: [],
  },
  {
    id: taskId("W002"),
    title: "Observe dependency-derived readiness",
    state: "BLOCKED",
    dependencies: [taskId("W001")],
    requiredEvidence: [],
  },
];

const application = new WorkflowApplication(
  new TaskGraph(tasks),
  hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  [],
  new Set(["read", "mutation", "process"]),
  workspace,
);

// Lazy MCP tool loading: schemas enter the model context on demand via
// discover/call meta-tools instead of up-front for every server.
process.env.CLINE_LAZY_MCP_TOOLS ??= "1";

const runtime = await createConfiguredClineRuntime(application, workspace);
const { waitUntilExit } = render(
  React.createElement(WorkflowTui, {
    application,
    session: runtime.session,
    onStyleChange: (style) => runtime.setSessionStyle(style),
  }),
);
await waitUntilExit();
await runtime.dispose();
