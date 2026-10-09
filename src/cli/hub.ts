#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { createEvidenceContentStore } from "../integrations/evidence-content-store.js";
import { fetchBoardTasksFromEnv } from "../integrations/azure-devops-provider.js";
import { boardProviderFromEnv, createBoardReadCache, fetchBoardTask, fetchIssueCrossReferences, fetchWorkProductState } from "../integrations/task-provider.js";
import { createProviderReadLedger, fetchIssueDetail, recordProviderReads } from "../integrations/issue-detail.js";
import { shellExecutorFor } from "../integrations/run-controller.js";
import { loadCredentialDefinitions } from "../integrations/credential-config.js";
import { createCredentialBroker } from "../integrations/credentials.js";
import { resolveSecretStore } from "../integrations/secret-store.js";
import { createDefaultToolboxGuardProvider } from "../integrations/mcp-toolbox-guard.js";
import { hubPromptGuidanceFromEnv } from "../integrations/prompt-guidance.js";
import { createReviewerFactory, createRunTestRunner, reviewerRunTaskId } from "../integrations/hub-run-gates.js";
import { createJsonReviewProvenanceStore } from "../integrations/review-provenance-store.js";
import { createConfiguredAcpRuntime, type WorkflowAcpRuntime } from "../integrations/acp-runtime.js";
import { canonicalWorkspace } from "../integrations/run-registry.js";
import { TaskUsageAttributor, laneTaskUsageSink } from "../integrations/task-usage.js";
import {
  createBudgetGuard,
  createHubScheduler,
  type BudgetGuard,
} from "../integrations/hub-scheduler.js";
import { createScheduleRegistry } from "../integrations/schedule-registry.js";
import { createProjectRegistry } from "../integrations/project-registry.js";
import { createSelfImprovementRegistry } from "../integrations/self-improvement-registry.js";
import { createEgressPolicyRevisionStore } from "../integrations/egress-policy-revisions.js";
import { azureJobsDispatchFromEnv, createAzureJobsDispatch } from "../integrations/azure-jobs-dispatch.js";
import {
  createAzureJobsIngest,
  createDispatchRecordRegistry,
  createRecordingEnqueue,
} from "../integrations/azure-jobs-record.js";
import { validateAzureJobMessage } from "../integrations/azure-jobs-schema.js";
import { loadEgressPolicyFile } from "../integrations/egress-policy-file.js";
import { credentialBindingFingerprint, upstreamCredentialBinding } from "../integrations/egress-binding.js";
import type { CredentialEndpoint } from "../integrations/credentials.js";
import type { EgressPolicy } from "../integrations/egress-policy.js";
import type { EgressDenialEvent, ProxyPayloadPolicy } from "../integrations/model-usage-proxy.js";
import {
  createAgentDrivenRunLoop,
  beginProposalTurnTask,
  beginKernelSessionTask,
  createContainedGitRunner,
  RSI_PROPOSAL_CAPABILITIES,
  type AgentTurnRunner,
} from "../integrations/self-improvement-agent.js";
import { createAuthorityGate } from "../integrations/self-improvement-loop.js";
import { createWorkflowHub, type WorkflowHubSchedulerHandles } from "../integrations/workflow-hub.js";
import { PermissionBroker } from "../ui/permission-broker.js";
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
  console.log("  state: ~/.workflow (env: WORKFLOW_HUB_PROVENANCE, WORKFLOW_HUB_SCHEDULES, WORKFLOW_HUB_PROJECTS)");
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

// P6 (issue #285): the hub process's SAME-PROCESS broker. The hub serves its
// pending/answer path on the hub HTTP bridge (`/api/permission`), and every
// containment seat the hub composes (the /bash route and the shells below)
// passes `broker.askHold()` to `shellExecutorFor`, so a guard `ask` held by a
// seat that runs in THIS process is answerable — not the 120s park-then-deny.
// The broker is in-process only; no cross-process plumbing is invented. The
// plugin (an external agent-host process) composes its own broker via
// `createWorkflowOpenCodePluginRoot`.
const permissionBroker = new PermissionBroker();

// W182 (NVIDIA adoption wave A7): the hub-scoped durable egress policy revision
// store. A proxy egress denial parks a redacted pending rule; an operator
// approval re-checks current policy + providers at merge time and merges a
// durable revision persisted under the hub's data dir. Revisions survive a hub
// restart (same `generation`) but reset when the backing session/sandbox is
// recreated (a new `WORKFLOW_EGRESS_GENERATION`).
//
// W184 ACTIVATION: the baseline policy is the operator's W183 file
// (`WORKFLOW_EGRESS_POLICY_FILE`, validated fail-closed by `loadEgressPolicyFile`).
// The `policyVersion` the store's fingerprint reports is the store's LIVE
// composed version (baseline + merged revisions), so a merge between an ask and
// its answer moves it and invalidates the stale park in-process; the
// `providerFingerprint` is the credential bindings + upstream, resolved at hub
// start (a credential-file change invalidates across a restart). W180's
// `egress_policy` denial now routes through W182's shared event, so an
// approvable `no_matching_rule` deny parks end-to-end and an approval merges a
// real rule the next proxy composition consults. Absent a policy file the tier
// stays dark (byte-identical).
const egressUpstream = process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai";
const egressBaselinePolicy: EgressPolicy = loadEgressPolicyFile() ?? { version: 0, rules: [] };
const egressGeneration = process.env.WORKFLOW_EGRESS_GENERATION?.trim() || "default";
const egressRevisionsPath = process.env.WORKFLOW_HUB_EGRESS_REVISIONS ?? join(homedir(), ".workflow", "egress-revisions.json");
// A value-free provider digest: the credential bindings + the upstream host.
// Resolved from the definitions loaded at hub start, so a credential-file
// change invalidates a stale park across a hub restart, not in-process (the
// bindings the proxies actually carry are likewise startup-loaded).
const egressProviderFingerprint = (): string => `${credentialBindingFingerprint(credentialDefinitions)}|upstream:${egressUpstream}`;
const egressApprovals = createEgressPolicyRevisionStore({
  path: egressRevisionsPath,
  baseline: egressBaselinePolicy,
  generation: egressGeneration,
  // The store is referenced lazily: `fingerprint` is called only at merge time,
  // after this binding is assigned, so the live composed policy version is read
  // (a merge grows it; a credential change moves the provider digest).
  fingerprint: () => ({
    policyVersion: egressApprovals.currentPolicy().version ?? 0,
    providerFingerprint: egressProviderFingerprint(),
  }),
});
// C1 deploy plan §2.c (D1/D3): the Azure job-dispatch client, classified from
// env at startup. Off (no WORKFLOW_AZURE_JOBS=1) → undefined (capability
// withheld); on but missing/malformed → this throws here, fail-closed (never a
// silently guardless dispatch lane). The queue/account URLs carry no secret.
const azureJobsDispatchEnv = azureJobsDispatchFromEnv(process.env);
if (azureJobsDispatchEnv.kind === "unconfigured" && (process.env.WORKFLOW_AZURE_JOBS ?? "").trim() === "1") {
  throw new Error(
    `azure job dispatch requires ${azureJobsDispatchEnv.missing.join(", ")} (WORKFLOW_AZURE_JOBS=1)`,
  );
}
const azureJobsDispatch =
  azureJobsDispatchEnv.kind === "configured"
    ? createAzureJobsDispatch({
        queueUrl: azureJobsDispatchEnv.queueUrl,
        accountUrl: azureJobsDispatchEnv.accountUrl,
        evidenceContainer: azureJobsDispatchEnv.evidenceContainer,
      })
    : undefined;
// C1 deploy plan §2.c (the return leg): the dispatch RECORD registry + the
// `validateDispatch(taskId)` ingest closure. The registry holds what each
// dispatched job declared (the coverage denominator), written by the recording
// enqueue wrapper below. Absent when the capability is off → both routes 404.
const dispatchRecordRegistry = azureJobsDispatchEnv.kind === "configured" ? createDispatchRecordRegistry() : undefined;
const dispatchAzureJob = azureJobsDispatch === undefined || dispatchRecordRegistry === undefined
  ? undefined
  : createRecordingEnqueue({
      registry: dispatchRecordRegistry,
      enqueue: azureJobsDispatch.enqueue,
      validate: (message) => validateAzureJobMessage(message),
    });
const validateDispatch = azureJobsDispatchEnv.kind === "configured" && dispatchRecordRegistry !== undefined
  ? createAzureJobsIngest({
      registry: dispatchRecordRegistry,
      accountUrl: azureJobsDispatchEnv.accountUrl,
    })
  : undefined;
// W184: the per-turn W180 payload policy, read FRESH at each runtime composition
// so a revision merged by the operator is consulted by the next turn's proxy.
// Absent rules (no file, no revisions) leaves the tier dark.
const hubEgressPayloadPolicy = (): ProxyPayloadPolicy | undefined => {
  const policy = egressApprovals.currentPolicy();
  return policy.rules.length === 0 ? undefined : { egressPolicy: policy };
};
// W184: the gate-2 credential binding for the proxy origin, resolved from the
// operator's credential definitions. Empty → absent (gate 2 stays inactive).
const hubCredentialEndpoints = upstreamCredentialBinding(egressUpstream, credentialDefinitions);
const onEgressDenied = (event: EgressDenialEvent): void => {
  egressApprovals.recordDenial({
    policy: event.policy,
    reason: event.reason,
    host: event.host,
    ...(event.port === undefined ? {} : { port: event.port }),
    ...(event.method === undefined ? {} : { method: event.method }),
    pathname: event.pathname,
  });
};
const hubEgressOptions = (): {
  readonly onEgressDenied: (event: EgressDenialEvent) => void;
  readonly payloadPolicy: ProxyPayloadPolicy | undefined;
  readonly credentialEndpoints?: readonly CredentialEndpoint[];
} => ({
  onEgressDenied,
  payloadPolicy: hubEgressPayloadPolicy(),
  ...(hubCredentialEndpoints.length === 0 ? {} : { credentialEndpoints: hubCredentialEndpoints }),
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
  shellExecutorFor(workspaceApplicationFor(cwd), undefined, writableWorkspace, guard, undefined, permissionBroker.askHold())(command, cwd, undefined);

// Review provenance (W041) journals every hub review decision in hub state —
// never inside a reviewed workspace, where it would mutate the very
// fingerprint the records are bound to. WORKFLOW_HUB_PROVENANCE overrides.
// W177: ONE store instance shared by the writer (the reviewer factory) and
// the reader (the audit lane the /snapshot audit block relays) — the reader
// sees exactly what the reviews append, never a second binding of the path.
const reviewProvenancePath = process.env.WORKFLOW_HUB_PROVENANCE ?? join(homedir(), ".workflow", "review-provenance.jsonl");
const reviewProvenanceStore = createJsonReviewProvenanceStore(reviewProvenancePath);

const reviewerFactory = createReviewerFactory({
  shell: containedShell(false),
  provenanceStore: reviewProvenanceStore,
  createRuntime: async ({ workspace: reviewerWorkspace, recordTaskUsage, reviewerRunId }) => {
    const reviewerApplication = new WorkflowApplication(
      graph,
      hostCapabilities({ transport: "native", authoritativePreMutation: true }),
      [],
      new Set(["read"]),
      reviewerWorkspace,
    );
    const reviewerTask = beginKernelSessionTask(reviewerApplication, { idPrefix: "hub-reviewer", title: "Hub reviewer session" });
    // W111 (issue #283): the runtime's active-task correlation is the reviewer
    // RUN's canonical task (`run:<reviewerRunId>`), not the reviewer session
    // task (`hub-reviewer:<id>`). The delta a completed reviewer turn publishes
    // then joins the reviewer run in the per-task view (`taskUsageForRun` keys
    // on `run:<id>`); the session task stays the #134 lifecycle bookkeeping
    // task only. Both are IN_PROGRESS in the shared graph when the boundary is
    // read.
    const reviewerRunCorrelationTaskId = reviewerRunTaskId(reviewerRunId);
    // W111 (issue #283): the hub composition root holds the run registry, so
    // the reviewer lane's ACP runtime supplies the driver-side attribution sink
    // — each COMPLETED reviewer turn publishes its per-task boundary delta into
    // the same journal the scheduler and RSI lanes write. The sink's pointer is
    // the runtime's existing lazy correlation (the reviewer run task, IN_PROGRESS
    // for the review's whole lifetime), read at boundary time, never inferred.
    // `usage` is deferred: the runtime exists by turn boundary.
    const runtime: WorkflowAcpRuntime = await createConfiguredAcpRuntime(reviewerApplication, reviewerWorkspace, reviewerRunCorrelationTaskId, undefined, guard, {
      taskUsage: laneTaskUsageSink(() => runtime.metrics?.(), (delta) => recordTaskUsage(delta)),
      ...hubEgressOptions(),
    }).catch((error: unknown) => {
      // #134: a runtime that never came up still opened its kernel task —
      // close it failed so the shared graph never carries an IN_PROGRESS
      // hub-reviewer task.
      try {
        reviewerTask.fail();
      } catch {
        // already terminal
      }
      throw error;
    });
    // W045: record the reviewer runtime's budget mechanism like every other
    // hub-composed runtime. The tail of the factory is guarded: anything
    // throwing here (the budget-mechanism read, a future line) would leak the
    // opened kernel task IN_PROGRESS with no closer (the round-1 review's P3).
    try {
      console.log(`hub reviewer session budget mechanism: ${runtime.budgetMechanism}`);
      return {
        submit: (prompt: string) => runtime.session.submit(prompt),
        snapshot: () => runtime.session.snapshot(),
        dispose: () => runtime.dispose(),
        // #134: the reviewer session's kernel task mirrors the session —
        // completed when review() returns, failed when it throws or the
        // runtime never came up. Terminal-safe: a repeated endTask (e.g. a
        // completed task whose run later failed) is a no-op, never a throw.
        endTask: (outcome: "completed" | "failed") => {
          try {
            if (outcome === "completed") reviewerTask.complete();
            else reviewerTask.fail();
          } catch {
            // already terminal — the session lifecycle must not throw here
          }
        },
      };
    } catch (error) {
      try {
        reviewerTask.fail();
      } catch {
        // already terminal
      }
      throw error;
    }
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
// W164: the project container's persisted table — the same seat as the
// schedule table (WORKFLOW_HUB_PROJECTS overrides the path). An absent or
// empty table means no projects; the routes still answer.
const projectsPath = process.env.WORKFLOW_HUB_PROJECTS ?? join(homedir(), ".workflow", "projects.json");
const projectRegistry = createProjectRegistry({ path: projectsPath });
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
    // read + process + spawn: the bounded proposal turn explores the repo
    // (shell/grep) and may delegate exploration to a subagent (opencode's
    // `task` tool classifies as spawn). Every call still crosses kernel
    // authorization and the guard dispatcher; the grant only stops the
    // fail-closed capability-withheld denial that opencode v2 escalates into
    // a whole-step abort ("The user declined this tool call" -> "Step
    // interrupted" — proven live via opencode.db, 2026-09-26).
    bound = new WorkflowApplication(graph, application.host, [], RSI_PROPOSAL_CAPABILITIES, canonical);
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
  // The runtime MUST be bound to the REAL proposal task: the permission
  // resolver resolves every tool call's taskId against the kernel graph and
  // denies fail-closed on an unknown id (`UNKNOWN_TASK` — workflow.ts:227), so
  // a phantom session-local binding (`rsi-<kind>:<uuid>`) denies the agent's
  // first tool call and opencode v2 aborts the whole step over it ("The user
  // declined this tool call" -> "Step interrupted" — proven live via
  // opencode.db, 2026-09-26). The proposal task is IN_PROGRESS for the turn's
  // whole lifetime (beginProposalTurnTask), so tool calls resolve.
  const turnTaskId: TaskId = input.runId === undefined
    ? proposalTurn!.taskId
    : taskId(`run:${input.runId}`);
  // W111 (issue #283): this hub composition root holds the run registry, so the
  // RSI lane's ACP runtime supplies the driver-side attribution sink — each
  // COMPLETED turn publishes its per-task boundary delta into the same journal
  // the scheduler lane writes (`handles.recordTaskUsage`). The schedule lane
  // deliberately passes no driver sink (it wires its own finally, no double
  // count); this lane has no such finally, so the driver seam is the honest
  // composition. `usage` is deferred: the runtime exists by turn boundary.
  const runtime = await createConfiguredAcpRuntime(turnApplication, input.workspace, turnTaskId, undefined, guard, {
    taskUsage: laneTaskUsageSink(() => runtime.metrics?.(), (delta) => handles.recordTaskUsage(delta)),
    ...hubEgressOptions(),
  });
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
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreateTokens: usage.cacheCreateTokens,
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
      const runtime = await createConfiguredAcpRuntime(runApplication, turnWorkspace, runTaskId, undefined, guard, { ...hubEgressOptions() });
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
      // W111 (issue #283, Q1 decided): the per-task attribution boundary hook.
      // The pointer is the run application's own `run:<id>` task, read AT
      // boundary time via `activeTaskId()` (never inferred); a throwing read
      // (the run task is no longer IN_PROGRESS) records the explicit
      // unattributed absence. Baseline at turn start; only a completed turn
      // publishes a delta (`failed`/`cancelled` publish nothing).
      const taskUsage = new TaskUsageAttributor({
        usage: () => runtime.metrics?.(),
        readTaskId: () => runApplication.activeTaskId(),
        record: (delta) => handles.recordTaskUsage(delta),
      });
      taskUsage.begin();
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
              cacheReadTokens: usage.cacheReadTokens,
              cacheCreateTokens: usage.cacheCreateTokens,
            },
          });
        }
        // W111: publish the per-task delta for a completed turn only; the
        // snapshot is read before dispose. The pointer read happens inside
        // `end` at this boundary moment.
        taskUsage.end(runtime.session.snapshot().state === "completed");
        await runtime.dispose();
      }
    },
  });
  return scheduler;
};

// W167: the hub's provider-read ledger — the ONE record behind the board's
// liveness pills. Every provider read below is wrapped so the hub records its
// own read outcomes at read time (a failed read's verbatim reason rides the
// record); an unconfigured hub performs no read and records nothing.
const providerReadLedger = createProviderReadLedger();

// W163: the hub-side board-read cache — overlapping web tabs share one
// upstream provider read: an entry serves within the TTL, a stale entry
// revalidates with If-None-Match (a 304 serves the cached board as a hit),
// and an entry past the TTL is never served.
const boardReadCache = createBoardReadCache();

let hub: Awaited<ReturnType<typeof createWorkflowHub>>;
try {
  hub = await createWorkflowHub(application, {
    graph,
    guard,
    ...(teamTaskVerificationCommand === undefined ? {} : { teamTaskVerificationCommand }),
    ...(testRunner === undefined ? {} : { testRunner }),
    // W158: the bounded evidence-content store — the hub exposes the
    // /evidence-content read route and the test-runner capture records
    // content on the evidence the verification consumed.
    contentStore: createEvidenceContentStore(),
    // W161/W168: the external-task board's read closure — env-classified at
    // hub start across BOTH provider lanes (GitHub:
    // WORKFLOW_GITHUB_REPO/WORKFLOW_GITHUB_TOKEN; Azure DevOps:
    // WORKFLOW_AZURE_DEVOPS_ORG/WORKFLOW_AZURE_DEVOPS_PROJECT/
    // WORKFLOW_AZURE_DEVOPS_TOKEN), fetched per read, bounded, and
    // credential-free on the wire. Both lanes fully configured is an honest
    // ambiguity error — the hub never silently picks one. W167 wraps it with
    // recordProviderReads so the hub records its own read outcome (the
    // liveness pills' only source); the detail read joins the same ledger —
    // a read performed for ANY route updates the record. An unconfigured hub
    // still serves the routes; the payloads name the missing declaration and
    // the ledger records nothing (the ambiguity error's verbatim reason rides
    // the pill tooltip — no pill fabricates freshness).
    readBoardTasks: recordProviderReads(providerReadLedger, () => fetchBoardTasksFromEnv(process.env, fetch, boardReadCache)),
    delegateBoardTask: recordProviderReads(providerReadLedger, (issue: number) => fetchBoardTask(boardProviderFromEnv(process.env), issue)),
    // W165: the board's pull-request-state read closure — the same env-classified
    // provider, one bounded read per linked reference. It stays UNwrapped: its
    // own `as of` fact carries its freshness on the payload, and the liveness
    // ledger describes the BOARD reads the pills render beside.
    readWorkProductState: (issue: number) => fetchWorkProductState(boardProviderFromEnv(process.env), issue),
    // W171: the provider-owned discovery read — the linked issue's timeline
    // cross-references ride the SAME ledger (a discovery read is a provider
    // read; the pills stay truthful).
    discoverIssueCrossReferences: recordProviderReads(providerReadLedger, (issue: number) => fetchIssueCrossReferences(boardProviderFromEnv(process.env), issue)),
    readIssueDetail: recordProviderReads(providerReadLedger, (issue: number) => fetchIssueDetail(boardProviderFromEnv(process.env), issue)),
    providerReadState: () => providerReadLedger.current(),
    // W177: the audit lane's provenance reader — the same shared store the
    // reviewer factory journals through.
    reviewProvenance: () => reviewProvenanceStore.records(),
    // P6 (issue #285): compose the same-process broker so the hub serves
    // /api/permission and its containment lanes hold answerable asks.
    permissionBroker,
    // W182 (A7): compose the durable egress policy revision store so the hub
    // serves /egress/pending and /egress/answer and the proxy denial sink parks
    // redacted pending rules.
    egressApprovals,
    // C1 deploy plan §2.c (D1/D3): the Azure job-dispatch enqueue closure.
    // Opt-in via WORKFLOW_AZURE_JOBS=1; when on, a missing/malformed queue
    // declaration throws here at startup (fail-closed, never best-effort).
    // When off, the capability is withheld and the route 404s.
    ...(dispatchAzureJob === undefined ? {} : { dispatchAzureJob }),
    ...(validateDispatch === undefined ? {} : { validateDispatch }),
    schedulerFactory,
    schedules: scheduleRegistry,
    projects: projectRegistry,
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
