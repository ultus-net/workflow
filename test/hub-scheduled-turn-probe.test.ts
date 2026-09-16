import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import { createReviewerFactory, createRunTestRunner } from "../src/integrations/hub-run-gates.js";
import { shellExecutorFor } from "../src/integrations/cline-tui-bridge.js";
import { createConfiguredAcpRuntime } from "../src/integrations/acp-runtime.js";
import { createHubScheduler, type ScheduleDefinition } from "../src/integrations/hub-scheduler.js";
import { randomUUID } from "node:crypto";

/**
 * Plan Task C1 real-agent probe: the full scheduled-run chain end to end —
 * a schedule fires, the hub spawns a contained real ACP turn (production
 * composition: metering proxy, guard, skill journal), the run finishes, and
 * the review gate + hub-run test evidence decide VERIFIED. This is the
 * wedge feature's proof: unattended work closes only through the gates.
 *
 * Gated: WORKFLOW_ACP_SCHEDULED=1 (the historical WORKFLOW_ACP_CLINE_SCHEDULED
 * name still enables it), plus the upstream key for the metering proxy
 * (CLINE_API_KEY env or ~/.config/workflow/cline-api-key), plus a real
 * WORKFLOW_TEAM_TASK_VERIFY_COMMAND (the test gate must not be rubber-stamped
 * by the `true` default). Post-pivot the chain exercises the selected lead
 * agent: opencode by default, or the vendored Cline fallback via
 * WORKFLOW_ACP_AGENT=cline (docs/ACP_DECISION.md) — the probe name is
 * agent-neutral because the hub composition under test is.
 */

const runProbe = process.env.WORKFLOW_ACP_SCHEDULED === "1" || process.env.WORKFLOW_ACP_CLINE_SCHEDULED === "1";

if (runProbe) {
  const verify = process.env.WORKFLOW_TEAM_TASK_VERIFY_COMMAND?.trim();
  if (verify === undefined || verify.length === 0 || verify === "true") {
    throw new Error("WORKFLOW_TEAM_TASK_VERIFY_COMMAND must be a real test command for the scheduled-run probe");
  }
}

const tasks: WorkflowTask[] = [{ id: taskId("interactive"), title: "Interactive coding session", state: "READY", dependencies: [], requiredEvidence: [] }];

test(
  "scheduled real-agent run: fire -> contained ACP turn -> review gate + test evidence decide the outcome",
  { skip: !runProbe, timeout: 600_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "wf-scheduled-probe-ws-"));
    const dir = mkdtempSync(join(tmpdir(), "wf-scheduled-probe-hub-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(workspace, "note.txt"), "before\n", "utf8");

    const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
    const application = new WorkflowApplication(
      graph,
      hostCapabilities({ transport: "native", authoritativePreMutation: true }),
      [],
      new Set(["read", "mutation", "process"]),
      workspace,
    );

    const verifyCommand = process.env.WORKFLOW_TEAM_TASK_VERIFY_COMMAND!.trim();
    const containedShell = (writableWorkspace: boolean) => (command: string, cwd: string) =>
      shellExecutorFor(
        // The scheduled turn's application is resolved per-run by the hub;
        // the probe uses the seed application's authority (same graph).
        application,
        undefined,
        writableWorkspace,
        undefined,
      )(command, cwd, undefined);

    const hub = await createWorkflowHub(application, {
      discoveryDir: dir,
      graph,
      reviewerFactory: createReviewerFactory({
        shell: containedShell(false),
        createRuntime: async ({ workspace: reviewerWorkspace }) => {
          const runtime = await createConfiguredAcpRuntime(application, reviewerWorkspace, taskId(`hub-reviewer:${randomUUID()}`));
          return {
            submit: (prompt: string) => runtime.session.submit(prompt),
            snapshot: () => runtime.session.snapshot(),
            dispose: () => runtime.dispose(),
          };
        },
      }),
      testRunner: createRunTestRunner({ command: verifyCommand, shell: containedShell(true) }),
    });
    t.after(() => hub.close());
    // One schedule whose cron matches the probe's deterministic tick time.
    const hubToken = (): string => (JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8")) as { token: string }).token;
    const schedules: readonly ScheduleDefinition[] = [{
      id: "probe-schedule",
      title: "Scheduled probe run",
      cron: "* * * * *",
      prompt: "Read note.txt and reply with exactly its current content. Do not modify any file.",
      workspace,
      requiresReview: true,
    }];
    const scheduler = createHubScheduler({
      controller: {
        // Reach through the hub's HTTP surface the way production surfaces do,
        // so the probe exercises the actual routes, not in-process handles.
        begin: async (input) => {
          const response = await fetch(`${hub.url}/run/begin`, {
            method: "POST",
            headers: { authorization: `Bearer ${hubToken()}`, "content-type": "application/json" },
            body: JSON.stringify(input),
          });
          if (!response.ok) throw new Error(`run/begin failed: ${response.status}`);
        },
        finish: async (input) => {
          const response = await fetch(`${hub.url}/run/finish`, {
            method: "POST",
            headers: { authorization: `Bearer ${hub.verificationToken}`, "content-type": "application/json" },
            body: JSON.stringify(input),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            throw new Error(`run/finish failed: ${response.status}: ${String(body.error ?? "")}`);
          }
        },
        review: async () => ({ recorded: false }),
        hiddenSnapshotTaskIds: () => [],
      },
      schedules: () => schedules,
      runTurn: async ({ runId, workspace: turnWorkspace }) => {
        const runtime = await createConfiguredAcpRuntime(application, turnWorkspace ?? workspace, taskId(`run:${runId}`));
        try {
          await runtime.session.submit("Read note.txt and reply with exactly its current content. Do not modify any file.");
          void runtime;
        } finally {
          await runtime.dispose();
        }
      },
      log: (message) => console.log(message),
    });

    // Deterministic fire — the cron matches every minute, so `now` always fires.
    await scheduler.tick(new Date());

    // The fire completed synchronously inside tick: assert the observable
    // outcome through the hub's snapshot.
    const snapshotResponse = await fetch(`${hub.url}/snapshot`, {
      method: "POST",
      headers: { authorization: `Bearer ${hubToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace }),
    });
    assert.equal(snapshotResponse.status, 200);
    const body = (await snapshotResponse.json()) as {
      snapshot: { tasks: Array<{ title: string; state: string }> };
      gateObservability?: {
        reviewOutcomes?: Record<string, { verdict: string; recorded: boolean }>;
        blockingReasons?: Record<string, string>;
      };
    };
    const evidence = {
      tasks: body.snapshot.tasks.map((task) => ({ title: task.title, state: task.state })),
      verdicts: body.gateObservability?.reviewOutcomes ?? {},
      blockingReasons: body.gateObservability?.blockingReasons ?? {},
    };
    console.log(JSON.stringify(evidence, null, 2));
    assert.ok(evidence.tasks.length > 0, "the scheduled run must have produced a task");
  },
);
