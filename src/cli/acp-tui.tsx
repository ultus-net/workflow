#!/usr/bin/env node
import React from "react";
import { render } from "ink";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { createConfiguredAcpRuntime } from "../integrations/acp-runtime.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { WorkflowTui, type SessionConfigOption } from "../ui/tui.js";
import { resolveTuiWorkspace } from "./tui-args.js";

/**
 * The clean Workflow terminal surface over stock ACP: a contained agent (the
 * default spawn path; whole-agent Bubblewrap, fail-closed on policy-only
 * backends) with permission interception wired into Workflow authorize and the
 * session/update stream projected as events. Model traffic crosses the hub
 * metering proxy, so the agent env holds only a placeholder key and usage is
 * printed at exit. Run with:
 *   npm run tui:acp [--workspace <path>]
 *
 * Agent-advertised ACP config options appear in the `/` menu after session
 * creation and mutate that active session. Set WORKFLOW_ACP_RESUME=<sessionId>
 * to resume a persisted session.
 */
const workspace = resolveTuiWorkspace(process.argv.slice(2), process.cwd());

// One canonical session task: every tool proposal the agent makes is
// authorized against it. Per-prompt task decomposition lives in the hub
// follow-up, not here.
const sessionTask: WorkflowTask = {
  id: taskId("ACP-SESSION"),
  title: "Stock-ACP coding session",
  state: "IN_PROGRESS",
  dependencies: [],
  requiredEvidence: [],
};
const application = new WorkflowApplication(
  new TaskGraph([sessionTask]),
  hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  [],
  new Set(["read", "mutation", "process", "network"]),
  workspace,
);

const runtime = await createConfiguredAcpRuntime(application, workspace, sessionTask.id);

const { waitUntilExit } = render(
  React.createElement(WorkflowTui, {
    application,
    session: runtime.session,
    sessionConfigOptions: () => (runtime.driver.config()?.configOptions ?? []) as readonly SessionConfigOption[],
    onSetSessionConfig: async (id: string, value: string | boolean) => {
      await runtime.driver.setConfigOption(id, value);
    },
    // Web-parity usage meter (Batch 2): live tokens + cost from the metering
    // proxy in the composer footer.
    usage: () => {
      const metrics = runtime.metrics?.();
      return metrics === undefined
        ? undefined
        : `${metrics.totalTokens} tokens · $${metrics.costUsd.toFixed(4)}`;
    },
  }),
);
let renderError: unknown;
try {
  await waitUntilExit();
} catch (error) {
  renderError = error;
} finally {
  await runtime.dispose();
}
if (renderError !== undefined) throw renderError;
