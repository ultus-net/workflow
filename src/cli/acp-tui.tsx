#!/usr/bin/env node
import React from "react";
import { render } from "ink";

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { WorkflowCodingSession } from "../application/coding-session.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import { AcpSessionDriver } from "../integrations/acp-session.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { WorkflowTui } from "../ui/tui.js";
import { resolveTuiWorkspace } from "./tui-args.js";

/**
 * The clean Workflow terminal surface over stock ACP: a contained agent (the
 * default spawn path; whole-agent Bubblewrap, fail-closed on policy-only
 * backends) with permission interception wired into Workflow authorize and the
 * session/update stream projected as events. Run with:
 *   npm run tui:acp [--workspace <path>]
 * Set WORKFLOW_ACP_RESUME=<sessionId> to resume a persisted session.
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

// Persistent scratch HOME (0700 since session transcripts live here) makes
// session/load resume work across launches.
const scratchHome = resolve(homedir(), ".workflow", "acp-home");
mkdirSync(scratchHome, { recursive: true, mode: 0o700 });

const clineBin = realpathSync(execFileSync("/usr/bin/which", ["cline"], { encoding: "utf8" }).trim());
let apiKey = process.env.CLINE_API_KEY;
if (apiKey === undefined) {
  try {
    apiKey = readFileSync(resolve(homedir(), ".config", "workflow", "cline-api-key"), "utf8").trim();
  } catch {
    // Friendly failure rather than a raw ENOENT when the fallback file is absent.
  }
}
if (!apiKey) throw new Error("acp surface requires CLINE_API_KEY or ~/.config/workflow/cline-api-key");

const driver = AcpSessionDriver.contained({
  containment: new LinuxBubblewrapContainment(),
  launch: {
    executable: process.execPath,
    script: clineBin,
    args: ["--acp", "--auto-approve", "false", ...(process.env.CLINE_MODEL ? ["--model", process.env.CLINE_MODEL] : [])],
    workspace,
    home: scratchHome,
    environment: {
      CLINE_API_KEY: apiKey,
      CLINE_PROVIDER: process.env.CLINE_PROVIDER ?? "openrouter",
    },
  },
  authorize: application,
  workspace,
  workspaceSessionId: `acp-${randomBytes(4).toString("hex")}`,
  taskId: sessionTask.id,
  ...(process.env.WORKFLOW_ACP_RESUME ? { resumeFrom: process.env.WORKFLOW_ACP_RESUME } : {}),
});
const session = new WorkflowCodingSession(driver);

const { waitUntilExit } = render(
  React.createElement(WorkflowTui, { application, session }),
);
let renderError: unknown;
try {
  await waitUntilExit();
} catch (error) {
  renderError = error;
} finally {
  await driver.dispose();
}
if (renderError !== undefined) throw renderError;
