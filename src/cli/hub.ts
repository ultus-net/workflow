#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { shellExecutorFor } from "../integrations/run-controller.js";
import { loadCredentialDefinitions } from "../integrations/credential-config.js";
import { createCredentialBroker } from "../integrations/credentials.js";
import { createSecretServiceStore } from "../integrations/secret-service.js";
import { createDefaultToolboxGuardProvider } from "../integrations/mcp-toolbox-guard.js";
import { advisoryGuidanceFromEnv } from "../integrations/prompt-guidance.js";
import { createReviewerFactory, createRunTestRunner } from "../integrations/hub-run-gates.js";
import { createConfiguredAcpRuntime } from "../integrations/acp-runtime.js";
import { canonicalWorkspace } from "../integrations/run-registry.js";
import {
  createBudgetGuard,
  createHubScheduler,
  loadSchedulesTable,
  type BudgetGuard,
} from "../integrations/hub-scheduler.js";
import { createWorkflowHub, type WorkflowHubSchedulerHandles } from "../integrations/workflow-hub.js";
import { taskId, type TaskId } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";

/**
 * Long-running Workflow authority daemon. Any Cline surface resolves the hub
 * through the discovery file written under `<data-dir>/hub/discovery.json`.
 * See `docs/HUB.md`.
 */
const workspace = process.cwd();
const graph = new TaskGraph([
  {
    id: taskId("interactive"),
    title: "Interactive coding session",
    state: "READY",
    dependencies: [],
    requiredEvidence: [],
  },
]);
const application = new WorkflowApplication(
  graph,
  hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  [],
  new Set(["read", "mutation", "process"]),
  workspace,
);

const requestLogPath = process.env.WORKFLOW_HUB_REQUEST_LOG;
const teamTaskVerifyEnv = process.env.WORKFLOW_TEAM_TASK_VERIFY_COMMAND?.trim();
const teamTaskVerificationCommand = process.env.WORKFLOW_TEAM_TASK_VERIFY_COMMAND === undefined
  ? "true"
  : (teamTaskVerifyEnv && teamTaskVerifyEnv.length > 0 ? teamTaskVerifyEnv : undefined);

// Credential custody (control-plane credentials pass): the guard receives its
// stdio-env credentials through the broker — secret:// references only, never
// values in this process's config.
const credentialDefinitions = loadCredentialDefinitions();
const credentialBroker = createCredentialBroker(createSecretServiceStore(), credentialDefinitions);
const guardBindings = credentialDefinitions.flatMap((definition) =>
  definition.allowedConsumers.includes("mcp:workflow-guard")
    ? definition.allowedPurposes.flatMap((purpose) => purpose.startsWith("stdio-env:")
      ? [{ variable: purpose.slice("stdio-env:".length), reference: `secret://${definition.id}` }]
      : [])
    : [],
);
// Plan Task G2: the guard dispatcher is part of the enforcement stack, not an
// optional extra. If it cannot start, the hub refuses to run — a silently
// guardless authority would issue permissive decisions no operator asked for.
// "No hub, no mutations" stays true by failing the hub itself closed. The
// credential composition rides along; a broker failure is a startup failure.
const guard = await createDefaultToolboxGuardProvider({
  credentialBroker,
  credentialBindings: guardBindings,
  workspace,
});

// Hub-owned run gates (plan Tasks A2/D1): the reviewer is a contained ACP
// agent authorized read-only against its own session task; diff sourcing and
// test execution go through the same contained shell as the /bash route.
// Everything fails closed at review time (e.g. missing CLINE_API_KEY
// surfaces as a blocking reason, never a silent pass).
const workspaceApplications = new Map<string, WorkflowApplication>();
const workspaceApplicationFor = (target: string): WorkflowApplication => {
  // Same canonicalization discipline as the run registry, now literally the
  // same helper: raw declared paths never create a second application for
  // the same directory, and invalid declarations fail closed instead of
  // silently binding authorization to an unintended directory.
  const canonical = canonicalWorkspace(target);
  let bound = workspaceApplications.get(canonical);
  if (bound === undefined) {
    bound = new WorkflowApplication(graph, application.host, [], new Set(["read", "mutation", "process"]), canonical);
    bound.startInteractiveTask();
    workspaceApplications.set(canonical, bound);
  }
  return bound;
};
const containedShell = (writableWorkspace: boolean) => (command: string, cwd: string) =>
  shellExecutorFor(workspaceApplicationFor(cwd), undefined, writableWorkspace, guard)(command, cwd, undefined);

// Review provenance (W041) journals every hub review decision in hub state —
// never inside a reviewed workspace, where it would mutate the very
// fingerprint the records are bound to. WORKFLOW_HUB_PROVENANCE overrides.
const reviewProvenancePath = process.env.WORKFLOW_HUB_PROVENANCE ?? join(homedir(), ".workflow", "review-provenance.jsonl");

const reviewerFactory = createReviewerFactory({
  shell: containedShell(false),
  provenancePath: reviewProvenancePath,
  createRuntime: async ({ workspace: reviewerWorkspace }) => {
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
    const runtime = await createConfiguredAcpRuntime(reviewerApplication, reviewerWorkspace, reviewerTaskId, undefined, guard);
    // W045: record the reviewer runtime's budget mechanism like every other
    // hub-composed runtime.
    console.log(`hub reviewer session budget mechanism: ${runtime.budgetMechanism}`);
    return {
      submit: (prompt: string) => runtime.session.submit(prompt),
      snapshot: () => runtime.session.snapshot(),
      dispose: () => runtime.dispose(),
    };
  },
});

// Test evidence is only required when a real verification command is
// configured — the "true" default must never rubber-stamp a test gate.
const testRunner = teamTaskVerificationCommand !== undefined && teamTaskVerificationCommand !== "true"
  ? createRunTestRunner({ command: teamTaskVerificationCommand, shell: containedShell(true) })
  : undefined;

// Plan Task C1/C2: the hub-native scheduler. The table lives under the data
// dir (WORKFLOW_HUB_SCHEDULES overrides the path); an absent or empty table
// means no scheduled runs. Every fired run is review-gated by default and
// budget-enforced from metering-proxy metrics (plan C2).
const schedulesPath = process.env.WORKFLOW_HUB_SCHEDULES ?? join(homedir(), ".workflow", "scheduler.json");
const schedules = loadSchedulesTable(schedulesPath);
// Plan Task G5 wiring: the hub composes scheduled prompts, so the operator's
// advisory guidance (WORKFLOW_ADVISORY_STYLE / WORKFLOW_ADVISORY_NOTES) is
// prepended to every scheduled turn — honestly advisory prompt text.
const promptGuidance = advisoryGuidanceFromEnv(process.env);
const schedulerFactory = schedules.length === 0 ? undefined : (handles: WorkflowHubSchedulerHandles) =>
  createHubScheduler({
    controller: handles.controller,
    recordBlockingReason: handles.recordBlockingReason,
    schedules: () => schedules,
    log: (message) => console.log(message),
    ...(promptGuidance === undefined ? {} : { promptGuidance }),
    runTurn: async ({ runId, workspace, prompt, budget }) => {
      const runApplication = handles.resolve(workspace, runId);
      const runTaskId: TaskId = taskId(`run:${runId}`);
      const turnWorkspace = workspace ?? process.cwd();
      const runtime = await createConfiguredAcpRuntime(runApplication, turnWorkspace, runTaskId, undefined, guard);
      // W045: record which interactive budget enforcement mechanism this
      // scheduled run's runtime carries (local guard vs the OpenRouter
      // per-key backstop) alongside the schedule's own run budget.
      console.log(`run ${runId} session budget mechanism: ${runtime.budgetMechanism}`);
      let budgetGuard: BudgetGuard | undefined;
      try {
        if (budget !== undefined) {
          budgetGuard = createBudgetGuard({
            budget,
            usageSnapshot: () => runtime.metrics?.(),
            cancel: () => runtime.session.cancel(),
            subscribe: (listener) => runtime.session.subscribe(listener),
          });
          budgetGuard.attach();
        }
        await runtime.session.submit(prompt);
        const violation = budgetGuard?.violation();
        if (violation !== undefined) throw new Error(violation);
        // Plan Task G5: journal the turn's completion claim with whether the
        // kernel had verified the run at that moment (observability-only).
        const snapshot = runtime.session.snapshot();
        if (snapshot.state === "completed") {
          handles.recordCompletionClaim({ runId, claim: snapshot.result });
        }
      } finally {
        // W044 (open clause): record the turn's metering-proxy totals for
        // hub-attached monitors (per-session usage aggregation) BEFORE the
        // runtime dies with its proxy.
        const usage = runtime.metrics?.();
        if (usage !== undefined) {
          handles.recordRunUsage({
            runId,
            usage: {
              requests: usage.requests,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              costUsd: usage.costUsd,
            },
          });
        }
        await runtime.dispose();
      }
    },
  });

let hub: Awaited<ReturnType<typeof createWorkflowHub>>;
try {
  hub = await createWorkflowHub(application, {
    graph,
    guard,
    ...(teamTaskVerificationCommand === undefined ? {} : { teamTaskVerificationCommand }),
    ...(testRunner === undefined ? {} : { testRunner }),
    ...(schedulerFactory === undefined ? {} : { schedulerFactory }),
    reviewerFactory,
    ...(requestLogPath === undefined ? {} : {
      observeRequest: (path) => appendFileSync(requestLogPath, `${path}\n`, { mode: 0o600 }),
    }),
  });
} catch (error) {
  // W044 resource hygiene: the guard child starts BEFORE the hub composition,
  // so a failed startup (e.g. losing the single-instance lock to an already
  // running hub) must still reap its own guard — a lock-loser hub may never
  // leave a guardless-spawned MCP child behind.
  await guard.close();
  throw error;
}
console.log(`Workflow hub listening at ${hub.url}`);
console.log(`Discovery file: ${hub.discoveryPath}`);

await new Promise<void>((resolveShutdown) => {
  const shutdown = () => resolveShutdown();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});
await hub.close();
await guard.close();
