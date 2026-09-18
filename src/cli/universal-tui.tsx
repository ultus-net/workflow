#!/usr/bin/env node
import React from "react";
import { homedir } from "node:os";
import { render } from "ink";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { createTaskCommandPort } from "../application/task-commands.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { createCheckpointLedger } from "../pedagogy/checkpoints.js";
import { applySkillGating, resolveSkillsLevelMap } from "../pedagogy/skill-gating.js";
import { WorkflowTui } from "../ui/tui.js";
import { detectTerminalBackground } from "../ui/terminal-theme.js";
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
let renderError: unknown;
// W047 (G5): composition failures (missing agent binary, containment
// policy-only, config problems) surface as an actionable cause instead of
// a raw stack trace; the composed driver is disposed only once it exists.
let composed: Awaited<ReturnType<typeof composeDriver>> | undefined;
try {
  composed = await composeDriver(driverName, application, workspace, {
    opencodeUrl: args.opencodeUrl ?? process.env.WORKFLOW_OPENCODE_URL ?? "http://127.0.0.1:4096",
  });
  // Plan Task F2 surface wiring: the same operator levels.json skills-mcp
  // reads gates this surface's required-skill precondition. A malformed map
  // refuses startup (fail-closed, mirroring skills-mcp) rather than running
  // with silently missing gating — inside the try so the composed driver is
  // still disposed on that fatal path.
  const skillsLevelMap = resolveSkillsLevelMap(process.env.SKILLS_MCP_DIR, homedir());
  // Terminal-derived composer tint (OSC 11): must run before Ink owns stdin.
  const composerBackground = await detectTerminalBackground();
  const { waitUntilExit } = render(React.createElement(WorkflowTui, {
    application,
    session: composed.session,
    assistantLabel: composed.label,
    // W046 parity: the standalone surface owns a real application, so its
    // task palette gets the port too (create/activate/retry through the
    // same application commands as acp-tui).
    taskCommands: createTaskCommandPort(application),
    connectionLabel: `${composed.label} | standalone (local authority)`,
    // Mode switching installs the checkpoint ledger AND re-binds the mode's
    // required-skill set to the active task (a mode with no required skills
    // clears the precondition).
    onModeChange: (mode) => {
      application.setPedagogyGate(createCheckpointLedger(mode));
      applySkillGating(application, mode, skillsLevelMap);
    },
    ...(composed.setSessionStyle ? { onStyleChange: composed.setSessionStyle } : {}),
    ...(composed.sessionConfigOptions ? { sessionConfigOptions: composed.sessionConfigOptions } : {}),
    ...(composed.setSessionConfig ? { onSetSessionConfig: composed.setSessionConfig } : {}),
    // W044: metering-proxy usage surfaces on every driver that records it.
    ...(composed.usage ? { usage: composed.usage } : {}),
    ...(composerBackground === undefined ? {} : { composerBackground }),
  }));
  await waitUntilExit();
} catch (error) {
  if (composed === undefined) {
    console.error(`failed to start the composed ${driverName} driver: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  renderError = error;
} finally {
  await composed?.dispose();
}
if (renderError !== undefined) throw renderError;
