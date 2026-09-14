#!/usr/bin/env node
import React from "react";
import { render } from "ink";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { createCheckpointLedger } from "../pedagogy/checkpoints.js";
import { WorkflowTui } from "../ui/tui.js";
import { composeDriver, driverHasAuthoritativePreMutation, parseUniversalArgs, resolveDriverName } from "./driver-registry.js";
import { resolveTuiWorkspace } from "./tui-args.js";

const argv = process.argv.slice(2);
const args = parseUniversalArgs(argv);
const driverName = resolveDriverName(args.driver);
const workspace = resolveTuiWorkspace(argv, process.cwd());
const seed: WorkflowTask[] = [{
  id: taskId("interactive"),
  title: "Interactive coding session",
  state: "READY",
  dependencies: [],
  requiredEvidence: [],
}];
const application = new WorkflowApplication(
  new TaskGraph(seed),
  hostCapabilities({ transport: "native", authoritativePreMutation: driverHasAuthoritativePreMutation(driverName) }),
  [],
  new Set(["read", "mutation", "process", "network"]),
  workspace,
);
const composed = await composeDriver(driverName, application, workspace, {
  opencodeUrl: args.opencodeUrl ?? process.env.WORKFLOW_OPENCODE_URL ?? "http://127.0.0.1:4096",
});

let renderError: unknown;
try {
  const { waitUntilExit } = render(React.createElement(WorkflowTui, {
    application,
    session: composed.session,
    connectionLabel: `${composed.label} | standalone (local authority)`,
    onModeChange: (mode) => application.setPedagogyGate(createCheckpointLedger(mode)),
    ...(composed.setSessionStyle ? { onStyleChange: composed.setSessionStyle } : {}),
    ...(composed.sessionConfigOptions ? { sessionConfigOptions: composed.sessionConfigOptions } : {}),
    ...(composed.setSessionConfig ? { onSetSessionConfig: composed.setSessionConfig } : {}),
  }));
  await waitUntilExit();
} catch (error) {
  renderError = error;
} finally {
  await composed.dispose();
}
if (renderError !== undefined) throw renderError;
