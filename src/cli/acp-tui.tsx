#!/usr/bin/env node
import React from "react";
import { render } from "ink";

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { WorkflowCodingSession } from "../application/coding-session.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import { AcpSessionDriver } from "../integrations/acp-session.js";
import { METERED_PLACEHOLDER_KEY, createModelUsageProxy, meteredProviderSettings } from "../integrations/model-usage-proxy.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { WorkflowTui } from "../ui/tui.js";
import { resolveTuiWorkspace } from "./tui-args.js";

/**
 * The clean Workflow terminal surface over stock ACP: a contained agent (the
 * default spawn path; whole-agent Bubblewrap, fail-closed on policy-only
 * backends) with permission interception wired into Workflow authorize and the
 * session/update stream projected as events. Model traffic crosses the hub
 * metering proxy, so the agent env holds only a placeholder key and usage is
 * printed at exit. Run with:
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

// G1: all model traffic crosses the hub metering proxy; the contained env
// holds only a placeholder key, and the proxy records tokens/cost.
const provider = process.env.CLINE_PROVIDER ?? "openrouter";
const upstream = process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai";
const proxy = await createModelUsageProxy({ upstream, apiKey });
const providerSettings = meteredProviderSettings(proxy.url, provider);
const settingsPath = join(scratchHome, "providers.json");
writeFileSync(settingsPath, JSON.stringify(providerSettings), { encoding: "utf8", mode: 0o600 });

const driver = AcpSessionDriver.contained({
  containment: new LinuxBubblewrapContainment(),
  launch: {
    executable: process.execPath,
    script: clineBin,
    args: ["--acp", "--auto-approve", "false", ...(process.env.CLINE_MODEL ? ["--model", process.env.CLINE_MODEL] : [])],
    workspace,
    home: scratchHome,
    environment: {
      CLINE_API_KEY: METERED_PLACEHOLDER_KEY,
      CLINE_PROVIDER: provider,
      CLINE_PROVIDER_SETTINGS_PATH: settingsPath,
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
  try {
    await driver.dispose();
  } finally {
    await proxy.close();
    console.log("metering proxy metrics:", JSON.stringify(proxy.metrics(), null, 2));
  }
}
if (renderError !== undefined) throw renderError;
