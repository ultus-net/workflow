#!/usr/bin/env node
import React from "react";
import { render } from "ink";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { createConfiguredClineRuntime } from "../integrations/cline-runtime.js";
import { createReviewFollowUpsClient, type ReviewFollowUp } from "../integrations/review-followups.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
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

// Advisory: open review follow-ups (P2/P3 debt from adversarial reviews),
// shown in the Activity panel. Missing server → empty list.
const reviewServer = resolve(fileURLToPath(import.meta.url), "../../../mcp-toolbox/apps/review-accountability-mcp/dist/server.js");
const followUpsClient = existsSync(reviewServer)
  ? await createReviewFollowUpsClient({ serverScript: reviewServer, workspaceRoot: workspace }).catch(() => undefined)
  : undefined;
const reviewFollowUps: readonly ReviewFollowUp[] = followUpsClient === undefined ? [] : await followUpsClient.openFollowUps(8).catch(() => []);

const { waitUntilExit } = render(
  React.createElement(WorkflowTui, {
    application,
    session: runtime.session,
    reviewFollowUps,
    onStyleChange: (style) => runtime.setSessionStyle(style),
  }),
);
await waitUntilExit();
await runtime.dispose();
await followUpsClient?.close();
