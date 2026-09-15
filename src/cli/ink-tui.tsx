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
import { createCheckpointLedger } from "../pedagogy/checkpoints.js";
import { resolveTuiWorkspace } from "./tui-args.js";
import { resolveWorkflowHub } from "./hub-client.js";
import { createHubSnapshotSource } from "./hub-snapshot.js";

/**
 * The Workflow monitoring TUI: task graph, live session activity, and the
 * log-enriched transcript. Hub-first: when the Workflow hub is reachable the
 * task panel projects the hub's canonical state (`/snapshot`), so the monitor
 * observes the same authority as every other surface. Without a hub it falls
 * back to a standalone local authority with the demo seed, labelled
 * "standalone (no hub)" in the mode bar.
 */
const workspace = resolveTuiWorkspace(process.argv.slice(2), process.cwd());

// Advisory: open review follow-ups (P2/P3 debt from adversarial reviews),
// shown in the Activity panel. Missing server → empty list.
const reviewServer = resolve(fileURLToPath(import.meta.url), "../../../mcp-toolbox/apps/review-accountability-mcp/dist/server.js");
const followUpsClient = existsSync(reviewServer)
  ? await createReviewFollowUpsClient({ serverScript: reviewServer, workspaceRoot: workspace }).catch(() => undefined)
  : undefined;
const reviewFollowUps: readonly ReviewFollowUp[] = followUpsClient === undefined ? [] : await followUpsClient.openFollowUps(8).catch(() => []);

const hub = await resolveWorkflowHub().catch(() => undefined);

if (hub !== undefined) {
  const source = createHubSnapshotSource(hub, workspace);
  await source.refresh().catch(() => undefined);
  const refreshTimer = setInterval(() => void source.refresh().catch(() => undefined), 1_000);
  refreshTimer.unref();
  const { waitUntilExit } = render(
    React.createElement(WorkflowTui, {
      application: source,
      reviewFollowUps,
      // Plan Task A3: run-gate observability from the hub's /snapshot —
      // verdicts, blocking reasons, and unverified claims in the Activity
      // panel; refreshed on the same poll.
      gateObservability: () => source.gateObservability(),
      connectionLabel: "hub",
    }),
  );
  await waitUntilExit();
  clearInterval(refreshTimer);
  await followUpsClient?.close();
} else {
  // Standalone fallback: local authority + demo seed covering every task
  // state so the TUI panels are all exercised. The graph recomputes
  // READY/BLOCKED from dependencies, so W002 flips to READY at boot.
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

  const { waitUntilExit } = render(
    React.createElement(WorkflowTui, {
      application,
      session: runtime.session,
      reviewFollowUps,
      connectionLabel: "standalone (no hub)",
      onStyleChange: (style) => runtime.setSessionStyle(style),
      // The mode bar installs the pedagogy gate on the application; changing mode
      // re-creates the checkpoint ledger for the new mode. Leaves no gate when
      // the mode itself gates nothing (autonomous).
      onModeChange: (mode) => application.setPedagogyGate(createCheckpointLedger(mode)),
    }),
  );
  await waitUntilExit();
  await runtime.dispose();
  await followUpsClient?.close();
}
