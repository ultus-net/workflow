#!/usr/bin/env node
import React from "react";
import { render } from "ink";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { activeTaskCorrelation } from "../application/task-commands.js";
import { createConfiguredAcpRuntime } from "../integrations/acp-runtime.js";
import { laneTaskUsageSink } from "../integrations/task-usage.js";
import { createSurfaceUsageSessionPost } from "../integrations/surface-usage-client.js";
import { createReviewFollowUpsClient, createReviewFollowUpsSource, UNAVAILABLE_REVIEW_FOLLOW_UPS, type OpenReviewFollowUps } from "../integrations/review-followups.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { WorkflowTui } from "../ui/tui.js";
import { detectTerminalBackground } from "../ui/terminal-theme.js";
import { createCheckpointLedger } from "../pedagogy/checkpoints.js";
import { applySkillGating, resolveSkillsLevelMap } from "../pedagogy/skill-gating.js";
import { resolveTuiWorkspace } from "./tui-args.js";
import { resolveWorkflowHub, terminateOwnedHub } from "./hub-client.js";
import type { ChildProcess } from "node:child_process";
import { createHubSnapshotSource } from "./hub-snapshot.js";

/**
 * The Workflow monitoring TUI: task graph, live session activity, and the
 * log-enriched transcript. Hub-first: when the Workflow hub is reachable the
 * task panel projects the hub's canonical state (`/snapshot`), so the monitor
 * observes the same authority as every other surface. Without a hub it falls
 * back to a standalone local authority with the demo seed, labelled
 * "standalone (no hub)" in the mode bar.
 */
// W129: the help contract — resolve help and exit before the review-followup
// client spawn or resolveWorkflowHub (which can AUTO-SPAWN the hub).
if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
  console.log("workflow-monitor — the Workflow monitoring TUI (hub-first; standalone fallback)");
  console.log("  --cwd <dir>  workspace (default: cwd)");
  console.log("  --help       print this help");
  process.exit(0);
}
const workspace = resolveTuiWorkspace(process.argv.slice(2), process.cwd());

// Advisory: open review follow-ups (P2/P3 debt from adversarial reviews),
// shown in the Activity panel. A missing server is an unconsultable ledger, so
// the panel says so instead of rendering silence as "0 open".
const reviewServer = resolve(fileURLToPath(import.meta.url), "../../../mcp-toolbox/apps/review-accountability-mcp/dist/server.js");
const followUpsClient = existsSync(reviewServer)
  ? await createReviewFollowUpsClient({ serverScript: reviewServer, workspaceRoot: workspace }).catch(() => undefined)
  : undefined;
// The 8-item window is a cap, not the debt total: the ledger's own truncation
// flag rides along so the panel can render "8+ open" instead of "8 open".
const followUpsSource = followUpsClient === undefined
  ? undefined
  : createReviewFollowUpsSource(followUpsClient, 8);
// One read before the first frame so the panel never opens on a flash of
// "unavailable"; after that the launcher polls and the TUI re-reads, so debt
// recorded (or resolved) mid-session reaches the panel live.
await followUpsSource?.refresh();
const readFollowUps = (): OpenReviewFollowUps => followUpsSource?.current() ?? UNAVAILABLE_REVIEW_FOLLOW_UPS;

// W044 resource hygiene: a monitor launch that auto-spawns the hub owns that
// hub and must terminate it on exit; a probed-and-reused hub stays running.
let ownedHub: ChildProcess | undefined;
const terminateOwned = () => terminateOwnedHub(ownedHub);
process.on("exit", terminateOwned);
process.once("SIGTERM", () => {
  terminateOwned();
  process.exit(143);
});
process.once("SIGHUP", () => {
  terminateOwned();
  process.exit(129);
});

const hub = await resolveWorkflowHub({ onSpawned: (child) => { ownedHub = child; } }).catch(() => undefined);

if (hub !== undefined) {
  const source = createHubSnapshotSource(hub, workspace);
  await source.refresh().catch(() => undefined);
  // One cadence for both polled reads: the hub snapshot (canonical state + gate
  // observability) and the review-follow-up ledger.
  const refreshTimer = setInterval(() => {
    void source.refresh().catch(() => undefined);
    void followUpsSource?.refresh();
  }, 1_000);
  refreshTimer.unref();
  const { waitUntilExit } = render(
    React.createElement(WorkflowTui, {
      application: source,
      reviewFollowUps: readFollowUps,
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
  // W126: the mode bar installs the initial mode's gate on mount (tui.tsx's
  // mount effect calls onModeChange unconditionally), and applySkillGating
  // reads the active task — but the standalone fallback never starts a
  // session, so nothing ever activated one: the fallback died on first
  // render with "no active workflow task selected" (the crash the W126
  // compiled-bin sweep caught — the operator's hub is always running, so
  // this path was never exercised live). Start the demo seed's interactive
  // task before rendering, the same activation a session start would do.
  application.startInteractiveTask();

  // Standalone (no hub): compose the host-neutral ACP runtime, the same
  // authority path the hub-hosted surfaces use. P4 topology Option A2 (issue
  // #283): this surface-local ACP turn CAN compute a boundary delta, so it is
  // wired to the hub-bound cross-process sink (mint + counters-only post; it
  // fails closed when no hub is reachable — the standalone case). The
  // HUB-REACHABLE path above is a pure monitor over the hub's /snapshot and
  // runs no ACP runtime of its own, so it has NO surface-local boundary to
  // publish (named, not invented).
  const usageHolder: { runtime?: Awaited<ReturnType<typeof createConfiguredAcpRuntime>> } = {};
  const runtime = await createConfiguredAcpRuntime(application, workspace, activeTaskCorrelation(application), undefined, undefined, {
    taskUsage: laneTaskUsageSink(() => usageHolder.runtime?.metrics?.(), createSurfaceUsageSessionPost()),
  });
  usageHolder.runtime = runtime;

  // Plan Task F2 surface wiring: same operator levels.json as skills-mcp; a
  // malformed map refuses startup (fail-closed) rather than running ungated.
  const skillsLevelMap = resolveSkillsLevelMap(process.env.SKILLS_MCP_DIR, homedir());

  // Terminal-derived composer tint (OSC 11): must run before Ink owns stdin.
  const composerBackground = await detectTerminalBackground();

  // Standalone (no hub): the ledger still polls, so a follow-up recorded while
  // the monitor runs reaches the Activity panel here too.
  const followUpsTimer = setInterval(() => void followUpsSource?.refresh(), 1_000);
  followUpsTimer.unref();

  const { waitUntilExit } = render(
    React.createElement(WorkflowTui, {
      application,
      session: runtime.session,
      reviewFollowUps: readFollowUps,
      connectionLabel: "standalone (no hub)",
      // The mode bar installs the pedagogy gate on the application; changing mode
      // re-creates the checkpoint ledger for the new mode AND re-binds the mode's
      // required-skill set to the active task. Leaves no gate when the mode itself
      // gates nothing (autonomous) and clears the skill precondition the same way.
      onModeChange: (mode) => {
        application.setPedagogyGate(createCheckpointLedger(mode));
        applySkillGating(application, mode, skillsLevelMap);
      },
      ...(composerBackground === undefined ? {} : { composerBackground }),
    }),
  );
  await waitUntilExit();
  clearInterval(followUpsTimer);
  await runtime.dispose();
  await followUpsClient?.close();
}
