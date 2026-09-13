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
// Demo seed covering every task state so the TUI panels (state counts,
// blocker annotations, interactive transitions) are all exercised. The graph
// recomputes READY/BLOCKED from dependencies, so W002 flips to READY at boot.
const tasks: WorkflowTask[] = [
  {
    id: taskId("W001"),
    title: "Inspect the runnable Workflow TUI",
    state: "VERIFIED",
    dependencies: [],
    requiredEvidence: [{ authority: "environment", subject: "typecheck" }],
  },
  {
    id: taskId("W002"),
    title: "Observe dependency-derived readiness",
    state: "BLOCKED",
    dependencies: [taskId("W001")],
    requiredEvidence: [],
  },
  {
    id: taskId("W003"),
    title: "Drive a task through the interactive transitions",
    state: "IN_PROGRESS",
    dependencies: [taskId("W001")],
    requiredEvidence: [{ authority: "host", subject: "session transcript" }],
  },
  {
    id: taskId("W004"),
    title: "Watch verification evidence land",
    state: "VERIFYING",
    dependencies: [taskId("W003")],
    requiredEvidence: [{ authority: "mcp", subject: "test run" }],
  },
  {
    id: taskId("W005"),
    title: "Recover from a failed transition",
    state: "FAILED",
    dependencies: [taskId("W002")],
    requiredEvidence: [],
  },
  {
    id: taskId("W006"),
    title: "Stay blocked behind the failed task",
    state: "BLOCKED",
    dependencies: [taskId("W005")],
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
