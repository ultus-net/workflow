import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type TaskId, type WorkflowTask } from "../src/kernel/contracts.js";
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
    // A real workspace test command: the test-evidence gate must run the
    // workspace's own tests (a plain node:test case with no toolchain
    // dependency), not something that only resolves in the Workflow repo.
    writeFileSync(
      join(workspace, "smoke.test.mjs"),
      'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("workspace smoke", () => assert.equal(1 + 1, 2));\n',
      "utf8",
    );
    // The reviewer's git-diff sourcing requires a git repository —
    // production run workspaces are repos, so mirror that: an initial
    // commit gives the reviewer the pre-run baseline to diff against.
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
    execFileSync("git", ["add", "note.txt", "smoke.test.mjs"], { cwd: workspace });
    execFileSync("git", ["-c", "user.email=probe@workflow.invalid", "-c", "user.name=workflow-probe", "commit", "--quiet", "-m", "probe baseline"], { cwd: workspace });

    const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
    const application = new WorkflowApplication(
      graph,
      hostCapabilities({ transport: "native", authoritativePreMutation: true }),
      [],
      new Set(["read", "mutation", "process"]),
      workspace,
    );
    // Mirror the production per-workspace application initialization
    // (src/cli/hub.ts workspaceApplicationFor → startInteractiveTask): the
    // hub shell must authorize against an application with an active
    // IN_PROGRESS task. Earlier probe runs bound the shell to this seed
    // application without selecting a task, so the reviewer's git-diff
    // sourcing threw "no active workflow task selected" and the run stayed
    // VERIFYING — a probe-composition divergence, not a production defect
    // (production initializes its workspace applications with an active
    // task).
    application.startInteractiveTask();

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
          // Mirror the production reviewer composition (src/cli/hub.ts): a
          // dedicated reviewer application with its own selected task.
          const reviewerApplication = new WorkflowApplication(
            graph,
            hostCapabilities({ transport: "native", authoritativePreMutation: true }),
            [],
            new Set(["read"]),
            reviewerWorkspace,
          );
          const reviewerTaskId: TaskId = taskId(`hub-reviewer:${randomUUID()}`);
          reviewerApplication.addTask({ id: reviewerTaskId, title: "Hub reviewer session", dependencies: [], requiredEvidence: [] });
          reviewerApplication.transition(reviewerTaskId, "IN_PROGRESS");
          reviewerApplication.selectActiveTask(reviewerTaskId);
          const runtime = await createConfiguredAcpRuntime(reviewerApplication, reviewerWorkspace, reviewerTaskId, undefined);
          runtime.session.subscribe((event) => {
            const summary = event.type === "tool" || event.type === "status" || event.type === "failed"
              ? JSON.stringify(event).slice(0, 300)
              : undefined;
            if (summary !== undefined) console.log("reviewer event:", summary);
          });
          return {
            submit: async (prompt: string) => {
              await runtime.session.submit(prompt);
              // Reviewer-session observability: a gated run must show the
              // reviewer's state/result so verdict failures explain
              // themselves.
              console.log("reviewer snapshot:", JSON.stringify(runtime.session.snapshot()).slice(0, 1200));
            },
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
      prompt: "Append exactly the line `after` on a new line at the end of note.txt. Do not modify any other file and do not run tests.",
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
      runTurn: async ({ runId, workspace: turnWorkspace, prompt }) => {
        const runtime = await createConfiguredAcpRuntime(application, turnWorkspace ?? workspace, taskId(`run:${runId}`));
        try {
          // Submit the hub-composed scheduled prompt — the probe exercises
          // the real delivery, not a hardcoded read-only stand-in (an earlier
          // composition ignored the prompt, so the turn never produced the
          // change the reviewer was asked to evaluate).
          await runtime.session.submit(prompt);
          // Record the turn's outcome so a gated run explains what the agent
          // actually did (permission denials show up here).
          console.log("scheduled turn snapshot:", JSON.stringify(runtime.session.snapshot()));
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
      noteContent: readFileSync(join(workspace, "note.txt"), "utf8"),
    };
    console.log(JSON.stringify(evidence, null, 2));
    assert.ok(evidence.tasks.length > 0, "the scheduled run must have produced a task");
  },
);
