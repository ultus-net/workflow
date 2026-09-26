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
import { resolveSecretStore } from "../integrations/secret-store.js";
import { createDefaultToolboxGuardProvider } from "../integrations/mcp-toolbox-guard.js";
import { hubPromptGuidanceFromEnv } from "../integrations/prompt-guidance.js";
import { createReviewerFactory, createRunTestRunner } from "../integrations/hub-run-gates.js";
import { createConfiguredAcpRuntime } from "../integrations/acp-runtime.js";
import { canonicalWorkspace } from "../integrations/run-registry.js";
import {
  createBudgetGuard,
  createHubScheduler,
  type BudgetGuard,
} from "../integrations/hub-scheduler.js";
import { createScheduleRegistry } from "../integrations/schedule-registry.js";
import { createSelfImprovementRegistry } from "../integrations/self-improvement-registry.js";
import {
  createAgentDrivenRunLoop,
  beginProposalTurnTask,
  createContainedGitRunner,
  type AgentTurnRunner,
} from "../integrations/self-improvement-agent.js";
import { createAuthorityGate } from "../integrations/self-improvement-loop.js";
import { createWorkflowHub, type WorkflowHubSchedulerHandles } from "../integrations/workflow-hub.js";
import { taskId, type TaskId } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";

/**
 * Long-running Workflow authority daemon. Any Cline surface resolves the hub
 * through the discovery file written under `<data-dir>/hub/discovery.json`.
 * See `docs/HUB.md`.
 */
// W129: the help contract — this module is a daemon that otherwise starts on
// ANY argv; resolve help and exit before the first composition statement.
if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
  console.log("workflow-hub — the Workflow authority daemon (one hub, one journal)");
  console.log("  state: ~/.workflow (env: WORKFLOW_HUB_PROVENANCE, WORKFLOW_HUB_SCHEDULES)");
  console.log("  --help  print this help");
  process.exit(0);
}
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
const credentialBroker = createCredentialBroker(resolveSecretStore(), credentialDefinitions);
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
// Everything fails closed at review time (e.g. a missing upstream key
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

// Plan Task C1/C2: the hub-native scheduler, now W074-managed. The table
// lives under the data dir (WORKFLOW_HUB_SCHEDULES overrides the path) and is
// owned by the live schedule registry, so operator edits take effect without a
// hub restart. An absent or empty table means no scheduled runs.
const schedulesPath = process.env.WORKFLOW_HUB_SCHEDULES ?? join(homedir(), ".workflow", "scheduler.json");
const scheduleRegistry = createScheduleRegistry({ path: schedulesPath });
// Plan Task G5 + W077 wiring: the hub composes scheduled prompts, so the
// orientation block (W077 — static, versioned, no interpolation; the agent
// learns the hub exists and which tools to reach for) and the operator's
// advisory guidance (WORKFLOW_ADVISORY_STYLE / WORKFLOW_ADVISORY_NOTES) are
// prepended to every scheduled turn — honestly advisory prompt text.
const promptGuidance = hubPromptGuidanceFromEnv(process.env);

// Checkpoint F: the self-improvement loop's agent seams. `WORKFLOW_RSI_AGENT`
// is strict-parsed like WORKFLOW_ACP_AGENT: unset or "1" composes the
// production loop from real agent turns; "0" keeps the old fail-closed stub
// (explicit opt-out); anything else refuses to start the hub rather than
// silently enabling a loop. Prompt templates and the measure command are
// operator seams (host agent-config surfaces may own them):
// WORKFLOW_RSI_PROPOSAL_PROMPT / WORKFLOW_RSI_APPLY_PROMPT replace the module
// defaults, WORKFLOW_RSI_MEASURE_COMMAND scores candidates (prints one
// number), WORKFLOW_RSI_GIT_AUTHOR_NAME/EMAIL set the loop's commit identity
// (the containment sandbox clears the environment, so global gitconfig is
// unreachable and the identity rides on `git -c` flags).
const rsiAgentEnv = process.env.WORKFLOW_RSI_AGENT?.trim();
if (rsiAgentEnv !== undefined && rsiAgentEnv !== "0" && rsiAgentEnv !== "1") {
  throw new Error(`WORKFLOW_RSI_AGENT must be "0" or "1" (got ${JSON.stringify(rsiAgentEnv)})`);
}
const rsiAgentDisabled = rsiAgentEnv === "0";
const rsiProposalPromptTemplate = process.env.WORKFLOW_RSI_PROPOSAL_PROMPT?.trim();
const rsiApplyPromptTemplate = process.env.WORKFLOW_RSI_APPLY_PROMPT?.trim();
const rsiMeasureCommand = process.env.WORKFLOW_RSI_MEASURE_COMMAND?.trim();
const rsiAuthorName = process.env.WORKFLOW_RSI_GIT_AUTHOR_NAME?.trim() ?? "Workflow Self-Improvement Loop";
const rsiAuthorEmail = process.env.WORKFLOW_RSI_GIT_AUTHOR_EMAIL?.trim() ?? "[EMAIL]";

// Proposal turns run before any run exists; they get a read-only application
// bound to the loop workspace (the reviewer-factory pattern). One per
// workspace, reused across the loop's iterations.
const rsiProposalApplications = new Map<string, WorkflowApplication>();
const rsiProposalApplicationFor = (target: string): WorkflowApplication => {
  const canonical = canonicalWorkspace(target);
  let bound = rsiProposalApplications.get(canonical);
  if (bound === undefined) {
    bound = new WorkflowApplication(graph, application.host, [], new Set(["read"]), canonical);
    // The proposal turn's task is opened per turn (beginProposalTurnTask in
    // rsiAgentTurn) and closed when the turn ends — never parked IN_PROGRESS
    // on the shared kernel graph across turns.
    rsiProposalApplications.set(canonical, bound);
  }
  return bound;
};

const rsiAgentTurn = (handles: WorkflowHubSchedulerHandles): AgentTurnRunner => async (input) => {
  const turnApplication = input.runId === undefined
    ? rsiProposalApplicationFor(input.workspace)
    : handles.resolve(input.workspace, input.runId);
  // Proposal turns open their own bookkeeping task and MUST close it when the
  // turn ends (complete on success, failed on error): a task left IN_PROGRESS
  // on the shared kernel graph collides with the run begin's own task and
  // fails the loop closed at iters=0 (lesson 98dd6a33, 2026-09-26).
  const proposalTurn = input.runId === undefined ? beginProposalTurnTask(turnApplication) : undefined;
  const turnTaskId: TaskId = input.runId === undefined
    ? proposalTurn!.taskId
    : taskId(`run:${input.runId}`);
  const runtime = await createConfiguredAcpRuntime(turnApplication, input.workspace, turnTaskId, undefined, guard);
  console.log(`rsi ${input.kind} turn budget mechanism: ${runtime.budgetMechanism}`);
  try {
    await runtime.session.submit(input.prompt);
    const snapshot = runtime.session.snapshot();
    if (snapshot.state !== "completed" || typeof snapshot.result !== "string") {
      const reason = snapshot.state === "failed" && typeof snapshot.reason === "string" ? `: ${snapshot.reason}` : "";
      throw new Error(`rsi ${input.kind} turn did not complete (state: ${snapshot.state}${reason})`);
    }
    if (proposalTurn !== undefined) proposalTurn.complete();
    const usage = runtime.metrics?.();
    return { result: snapshot.result, costUsd: usage?.costUsd ?? 0 };
  } catch (error) {
    if (proposalTurn !== undefined) {
      try {
        proposalTurn.fail();
      } catch {
        // the task may already be terminal (e.g. the turn failed after
        // completion was recorded) — the original error must not be masked
      }
    }
    throw error;
  } finally {
    // Failed turns still spent money: the run-usage ledger records whatever
    // the metering proxy saw even when the turn did not complete (the loop's
    // budget supplier only counts successful turns — recorded residual), and
    // the runtime dies with its proxy, so this must happen before dispose.
    const usage = runtime.metrics?.();
    if (input.runId !== undefined && usage !== undefined) {
      handles.recordRunUsage({
        runId: input.runId,
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
};

const selfImprovementFactory = (handles: WorkflowHubSchedulerHandles) =>
  createSelfImprovementRegistry({
    runLoop: rsiAgentDisabled
      ? async () => {
        throw new Error("self-improvement agent wiring is disabled on this hub (WORKFLOW_RSI_AGENT=0)");
      }
      : createAgentDrivenRunLoop({
        authority: createAuthorityGate(handles.controller),
        turn: rsiAgentTurn(handles),
        gitRun: createContainedGitRunner({ shell: containedShell(true), authorName: rsiAuthorName, authorEmail: rsiAuthorEmail }),
        ...(rsiMeasureCommand === undefined ? {} : { measure: { shell: containedShell(true), command: rsiMeasureCommand } }),
        ...(promptGuidance === undefined ? {} : { promptPrefix: promptGuidance }),
        ...(rsiProposalPromptTemplate === undefined ? {} : { proposalPromptTemplate: rsiProposalPromptTemplate }),
        ...(rsiApplyPromptTemplate === undefined ? {} : { applyPromptTemplate: rsiApplyPromptTemplate }),
      }),
  });

const schedulerFactory = (handles: WorkflowHubSchedulerHandles) => {
  const scheduler = createHubScheduler({
    controller: handles.controller,
    recordBlockingReason: handles.recordBlockingReason,
    // Live read: registry edits are visible to the very next tick.
    schedules: () => scheduleRegistry.list(),
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
      // Iteration 21: collect the turn's advisory reasoning-claim findings so
      // the run registry can surface them (observability-only).
      const reasoningClaimFindings: string[] = [];
      const unsubscribeReasoningClaims = runtime.session.subscribe((event) => {
        if (event.type === "reasoning-claim") reasoningClaimFindings.push(event.sentence);
      });
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
        unsubscribeReasoningClaims();
        handles.noteReasoningClaimMonitor({ runId });
        for (const sentence of reasoningClaimFindings) {
          handles.recordReasoningClaim({ runId, sentence });
        }
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
  return scheduler;
};

let hub: Awaited<ReturnType<typeof createWorkflowHub>>;
try {
  hub = await createWorkflowHub(application, {
    graph,
    guard,
    ...(teamTaskVerificationCommand === undefined ? {} : { teamTaskVerificationCommand }),
    ...(testRunner === undefined ? {} : { testRunner }),
    schedulerFactory,
    schedules: scheduleRegistry,
    // W073 trigger surface / Checkpoint F: the registry is composed lazily
    // against the run-registry handles so the production loop (agent proposal
    // source + agent applier + measure) drives the real controller. With
    // WORKFLOW_RSI_AGENT=0 the runner stays fail-closed (explicit opt-out) —
    // it refuses with that message rather than pretending a loop ran;
    // /rsi/start surfaces the error as a client error.
    selfImprovementFactory,
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
  // Idempotent teardown (launcher-loop LESS-0001): a process-group signal —
  // a terminal Ctrl+C, a terminal close/SSH hangup as SIGHUP, or a systemd
  // KillMode=control-group stop — reaches this child directly AND again via
  // the launcher's forward. `process.once`
  // restores the default disposition after the first delivery, so the second
  // signal hard-kills the process mid-close, skipping the discovery/lock
  // unlink below and orphaning the guard child. A guarded `on` makes repeat
  // deliveries no-ops so the first shutdown always runs to completion.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    resolveShutdown();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
});
await hub.close();
await guard.close();
