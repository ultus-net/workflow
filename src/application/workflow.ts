import type { HostCapabilities, ProposedToolAction, ToolCapability } from "./host.js";
import { NO_ACTIVE_TASK_ID } from "./task-commands.js";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { evaluateTaskGraphInvariants } from "../kernel/invariants.js";
import type {
  Evidence,
  EvidenceRequirement,
  PolicyDecision,
  StepId,
  TaskId,
  TaskState,
  TransitionResult,
  WorkflowStep,
  WorkflowTask,
} from "../kernel/contracts.js";
import { TaskGraph, isRunComplete, type StepTransitionResult } from "../kernel/task-graph.js";
import { mutationGate, verifyingGate, type CheckpointLedger } from "../pedagogy/checkpoints.js";
import { PolicyFailureTracker } from "./policy-failure-tracker.js";
import { FileClaimLedger } from "./file-claim-ledger.js";
import { MutationBudget } from "./mutation-budget.js";

export interface WorkflowTaskProjection {
  readonly id: TaskId;
  readonly title: string;
  readonly state: TaskState;
  readonly blockers: readonly TaskId[];
}

export interface WorkflowSnapshot {
  readonly enforcementLevel: HostCapabilities["enforcementLevel"];
  readonly transport: HostCapabilities["transport"];
  readonly mutationEpoch: number;
  readonly tasks: readonly WorkflowTaskProjection[];
  readonly evidence: readonly Evidence[];
  readonly history: readonly { readonly taskId: TaskId; readonly from: TaskState; readonly to: TaskState }[];
}

export class WorkflowApplication {
  readonly #history: { taskId: TaskId; from: TaskState; to: TaskState }[] = [];
  readonly #graph: TaskGraph;
  #activeTaskId?: TaskId;
  #codingSessionCorrelation?: string;
  #pedagogyGate: CheckpointLedger | undefined;
  readonly #capabilities: Set<ToolCapability>;
  // Plan Task F3: skill delivery preconditions. A read_skill observation is a
  // PRECONDITION for mutating actions, never `requiredEvidence` — a
  // model-initiated tool call must not self-certify task verification. The
  // journal maps skill -> the task that read it; per-task freshness means a
  // new task must re-read its required skills.
  readonly #taskRequiredSkills = new Map<TaskId, readonly string[]>();
  readonly #skillReads = new Map<string, TaskId>();
  readonly #policyFailures = new PolicyFailureTracker();
  readonly #fileClaims = new FileClaimLedger();
  readonly #mutationBudget = new MutationBudget();

  constructor(
    graph: TaskGraph,
    readonly host: HostCapabilities,
    history: readonly { readonly taskId: TaskId; from: TaskState; to: TaskState }[] = [],
    allowedCapabilities: ReadonlySet<ToolCapability> = new Set<ToolCapability>(["read", "mutation"]),
    readonly workspaceRoot?: string,
    codingSessionCorrelation?: string,
  ) {
    if (workspaceRoot !== undefined && !isAbsolute(workspaceRoot)) {
      throw new TypeError("workspace root must be an absolute path");
    }
    this.#graph = graph;
    this.#capabilities = new Set(allowedCapabilities);
    this.#history.push(...history);
    if (codingSessionCorrelation !== undefined) this.#codingSessionCorrelation = codingSessionCorrelation;
  }

  get allowedCapabilities(): ReadonlySet<ToolCapability> {
    return this.#capabilities;
  }

  /** Records a completed tool outcome so a session's failure breaker resets. */
  recordToolOutcome(sessionId: string, outcome: "succeeded" | "failed" | "denied", tool = "unknown", reason = ""): void {
    if (outcome === "succeeded") this.#policyFailures.recordSuccess(sessionId);
    else this.#policyFailures.recordFailure({ sessionId, tool, reason });
  }

  policyFailureCount(sessionId: string): number {
    return this.#policyFailures.count(sessionId);
  }

  clearPolicyFailures(sessionId: string): void {
    this.#policyFailures.clear(sessionId);
  }

  /** Record a successful read before an edit/write can use it in a host that
   * enables Policy-1 read fingerprints. */
  recordReadFingerprint(fingerprint: import("./host.js").ReadFingerprint): void {
    this.#fileClaims.recordRead(fingerprint);
  }

  claimFiles(sessionId: string, paths: readonly string[]): boolean {
    return this.#fileClaims.claim(sessionId, paths);
  }

  releaseFileClaims(sessionId: string): void {
    this.#fileClaims.release(sessionId);
  }

  registerSubagentSession(sessionId: string, parentId?: string): void {
    this.#mutationBudget.register(sessionId, parentId);
  }

  mutationBudgetRemaining(sessionId: string): number {
    return this.#mutationBudget.remaining(sessionId);
  }

  /**
   * Runtime capability reconfiguration for operator surfaces. Toggling a
   * capability off denies every gated action that needs it from that point
   * on; toggling on re-admits actions already passing the other policies.
   */
  setCapability(capability: ToolCapability, enabled: boolean): void {
    if (enabled) {
      this.#capabilities.add(capability);
    } else {
      this.#capabilities.delete(capability);
    }
  }

  get codingSessionCorrelation(): string | undefined {
    return this.#codingSessionCorrelation;
  }

  setPedagogyGate(ledger: CheckpointLedger | undefined): void {
    this.#pedagogyGate = ledger;
  }

  setCodingSessionCorrelation(sessionId: string): void {
    if (sessionId.trim().length === 0) throw new TypeError("coding session correlation must be non-empty");
    this.#codingSessionCorrelation = sessionId;
  }

  /**
   * Plan Task F3: declare the skills a task must have delivered (via
   * `read_skill`) before its mutations will be authorized. The kernel stays
   * prompt/skill-free — this is an application-layer precondition.
   */
  setTaskRequiredSkills(taskId: TaskId, skills: readonly string[]): void {
    this.#graph.get(taskId);
    const unique = [...new Set(skills)];
    for (const skill of unique) {
      if (skill.trim().length === 0) throw new TypeError("required skill names must be non-empty");
    }
    if (unique.length === 0) {
      this.#taskRequiredSkills.delete(taskId);
      return;
    }
    this.#taskRequiredSkills.set(taskId, unique);
  }

  /** Records that the session delivered a skill's content (read_skill call). */
  recordSkillRead(skill: string, taskId?: TaskId): void {
    const target = taskId ?? this.#activeTaskId;
    if (target === undefined) throw new TypeError("skill read recorded with no active task");
    this.#graph.get(target);
    if (skill.trim().length === 0) throw new TypeError("skill name must be non-empty");
    this.#skillReads.set(skill, target);
  }

  /** Public authority boundary: every denial feeds the application-owned
   * circuit breaker, matching the plugin's repeated-failure behavior. */
  authorize(action: ProposedToolAction): PolicyDecision {
    const decision = this.#authorize(action);
    const breakerCodes = new Set(["WORKSPACE_PATH_DENIED", "STALE_OR_MISSING_READ", "NO_ACTIVE_STEP", "TASK_NOT_IN_PROGRESS"]);
    if (decision.kind === "deny" && action.mutating && decision.code !== "POLICY_CIRCUIT_BREAKER" && breakerCodes.has(decision.code)) {
      // Only repeated mutation-policy violations open the breaker; capability
      // configuration, skill delivery, and pedagogy prompts are not retries of
      // the destructive-policy class and must not freeze a session.
      this.#policyFailures.recordFailure({ sessionId: action.sessionId, tool: action.tool, reason: decision.code });
    }
    return decision;
  }

  #authorize(action: ProposedToolAction): PolicyDecision {
    if (action.mutating && this.#policyFailures.isOpen(action.sessionId)) {
      return {
        kind: "deny",
        code: "POLICY_CIRCUIT_BREAKER",
        reason: `session ${action.sessionId} has repeated policy failures; operator intervention is required`,
      };
    }
    const capability = action.capability ?? (action.mutating ? "mutation" : "read");
    const requiredCapabilities = new Set([capability, ...(action.requiredCapabilities ?? [])]);
    const withheld = [...requiredCapabilities].find((required) => !this.allowedCapabilities.has(required));
    if (withheld !== undefined) {
      return {
        kind: "deny",
        code: "CAPABILITY_WITHHELD",
        reason: `capability ${withheld} is not available to this workflow`,
      };
    }
    if (this.workspaceRoot !== undefined) {
      for (const subject of action.subjects) {
        if (!pathWithinWorkspace(this.workspaceRoot, subject)) {
          return {
            kind: "deny",
            code: "WORKSPACE_PATH_DENIED",
            reason: `path ${subject} is outside authorized workspace ${this.workspaceRoot}`,
          };
        }
      }
    }
    if (!action.mutating) return { kind: "allow" };

    if (this.host.requireReadFingerprint) {
      const fingerprints = action.readFingerprints ?? [];
      const missing = action.subjects.filter((path) => {
        const fingerprint = fingerprints.find((entry) => entry.path === path);
        return fingerprint === undefined || !this.#fileClaims.matchesCurrent(path, fingerprint);
      });
      if (missing.length > 0) {
        return { kind: "deny", code: "STALE_OR_MISSING_READ", reason: `fresh read required before mutation: ${missing.join(", ")}` };
      }
    }

    let task;
    try {
      task = this.#graph.get(action.taskId);
    } catch {
      return { kind: "deny", code: "UNKNOWN_TASK", reason: `unknown task: ${action.taskId}` };
    }
    if (task.state !== "IN_PROGRESS") {
      return {
        kind: "deny",
        code: "TASK_NOT_IN_PROGRESS",
        reason: `task ${task.id} is ${task.state}, not IN_PROGRESS`,
      };
    }
    // Ledger invariant I-1 (conditional migration): once a task declares a
    // step ledger, mutations require an in-progress step. Tasks without a
    // ledger keep the legacy active-task behavior until the bridge enables one.
    if (this.#graph.stepsFor(task.id).length > 0 && this.#graph.activeStepId(task.id) === undefined) {
      return {
        kind: "deny",
        code: "NO_ACTIVE_STEP",
        reason: `task ${task.id} has a step ledger but no step IN_PROGRESS; start a step before mutating`,
      };
    }
    const pendingCheckpoint = this.#pedagogyGate === undefined ? undefined : mutationGate(this.#pedagogyGate, task.id);
    if (pendingCheckpoint !== undefined) {
      return {
        kind: "deny",
        code: "CHECKPOINT_PENDING",
        reason: `task ${task.id} has a pending ${pendingCheckpoint.kind} checkpoint: ${pendingCheckpoint.summary}`,
      };
    }
    // Plan Task F3: skill delivery precondition. Every required skill must
    // have been delivered (read_skill) for THIS task — a different task's
    // read does not carry over. Delivery is enforced; adherence is not (the
    // model may still ignore the content — only environment evidence and
    // reviews judge outcomes).
    const requiredSkills = this.#taskRequiredSkills.get(task.id);
    if (requiredSkills !== undefined) {
      const undelivered = requiredSkills.filter((skill) => this.#skillReads.get(skill) !== task.id);
      if (undelivered.length > 0) {
        return {
          kind: "deny",
          code: "SKILL_DELIVERY_REQUIRED",
          reason: `task ${task.id} requires skill delivery via read_skill before mutations: ${undelivered.join(", ")}`,
        };
      }
    }
    if (!this.#mutationBudget.consume(action.sessionId)) {
      return { kind: "deny", code: "MUTATION_BUDGET_EXHAUSTED", reason: `session ${action.sessionId} and its descendants exhausted the mutation budget` };
    }
    return { kind: "allow" };
  }

  transition(taskId: TaskId, requested: TaskState): TransitionResult {
    if (requested === "VERIFYING" && this.#pedagogyGate !== undefined) {
      const pendingInspection = verifyingGate(this.#pedagogyGate, taskId);
      if (pendingInspection !== undefined) {
        const task = this.#graph.get(taskId);
        return {
          kind: "rejected",
          code: "CHECKPOINT_PENDING",
          reason: `task ${taskId} has a pending inspection checkpoint: ${pendingInspection.summary}`,
          taskId,
          from: task.state,
          requested,
        };
      }
    }
    const result = this.#graph.transition(taskId, requested);
    if (result.kind === "accepted") this.#history.push(result.transition);
    return result;
  }

  retryFailedTask(taskId: TaskId): TransitionResult {
    const task = this.#graph.get(taskId);
    const dependenciesReady = task.dependencies.every((dependency) => this.#graph.get(dependency).state === "VERIFIED");
    return this.transition(taskId, dependenciesReady ? "READY" : "BLOCKED");
  }

  addTask(task: Omit<WorkflowTask, "state">): void {
    // W046: the active-task correlation's fail-closed sentinel must never be
    // a creatable task — reserving it at the application seam covers every
    // creation path (port, web API, hub flows) so a live IN_PROGRESS task
    // named "no-active-task" can never turn the no-active deny into an allow.
    if (task.id === NO_ACTIVE_TASK_ID) {
      throw new Error(`task id ${JSON.stringify(NO_ACTIVE_TASK_ID)} is reserved for the fail-closed active-task correlation`);
    }
    this.#graph.addTask({ ...task, state: "BLOCKED" });
  }

  addDependency(taskId: TaskId, dependencyId: TaskId): void {
    this.#graph.addDependency(taskId, dependencyId);
  }

  /** Bridges a native host todo update into the canonical active task. Agent
   * completion is never self-certifying: evidence-bound completeStep remains
   * authoritative even when the host says a todo is completed. */
  mirrorNativeTodos(entries: readonly { readonly id?: string; readonly content: string; readonly status: "pending" | "in_progress" | "completed" | "cancelled" }[]): readonly WorkflowStep[] {
    const task = this.activeTaskId();
    const steps = this.#graph.defineSteps(task, entries.map((entry) => ({
      ...(entry.id === undefined ? {} : { id: entry.id }),
      content: entry.content,
      requiredEvidence: [{ authority: "environment" as const, subject: `step:${entry.id ?? entry.content}` }],
    })));
    for (const entry of entries) {
      if (entry.status !== "in_progress") continue;
      const step = entry.id === undefined ? undefined : steps.find((candidate) => candidate.id === entry.id);
      if (step?.state === "PENDING") this.#graph.startStep(step.id);
    }
    return this.#graph.stepsFor(task);
  }

  /** Defines/replaces a task's canonical step ledger (I-2 enforced in the kernel). */
  defineTaskSteps(
    taskId: TaskId,
    proposed: readonly { readonly id?: string; readonly content: string; readonly requiredEvidence?: readonly EvidenceRequirement[] }[],
  ): readonly WorkflowStep[] {
    return this.#graph.defineSteps(taskId, proposed);
  }

  taskSteps(taskId: TaskId): readonly WorkflowStep[] {
    return this.#graph.stepsFor(taskId);
  }

  startTaskStep(id: StepId): StepTransitionResult {
    return this.#graph.startStep(id);
  }

  completeTaskStep(id: StepId): StepTransitionResult {
    return this.#graph.completeStep(id);
  }

  cancelTaskStep(id: StepId): StepTransitionResult {
    return this.#graph.cancelStep(id);
  }

  activeStepId(taskId: TaskId): StepId | undefined {
    return this.#graph.activeStepId(taskId);
  }

  /** Canonical run-completion predicate (all tasks VERIFIED). */
  isRunComplete(): boolean {
    return isRunComplete(this.#graph.tasks());
  }

  selectActiveTask(taskId: TaskId): void {
    const task = this.#graph.get(taskId);
    if (task.state !== "IN_PROGRESS") {
      throw new TypeError(`cannot select task ${task.id} in ${task.state}`);
    }
    this.#activeTaskId = taskId;
  }

  startInteractiveTask(): TaskId {
    if (this.#activeTaskId !== undefined) return this.activeTaskId();

    const inProgress = this.#graph.tasks().filter(({ state }) => state === "IN_PROGRESS");
    if (inProgress.length === 1) {
      this.selectActiveTask(inProgress[0]!.id);
      return inProgress[0]!.id;
    }
    if (inProgress.length > 1) throw new TypeError("multiple IN_PROGRESS tasks require an explicit active task selection");

    const ready = this.#graph.tasks().filter(({ state }) => state === "READY");
    if (ready.length !== 1) {
      if (ready.length === 0) throw new TypeError("no READY workflow task available for interactive coding");
      throw new TypeError("multiple READY tasks require an explicit active task selection");
    }
    const selected = ready[0]!.id;
    const transition = this.transition(selected, "IN_PROGRESS");
    if (transition.kind !== "accepted") throw new TypeError(`cannot start interactive task ${selected}`);
    this.selectActiveTask(selected);
    return selected;
  }

  activeTaskId(): TaskId {
    if (this.#activeTaskId === undefined) throw new TypeError("no active workflow task selected");
    const task = this.#graph.get(this.#activeTaskId);
    if (task.state !== "IN_PROGRESS") throw new TypeError(`active task ${task.id} is ${task.state}`);
    return task.id;
  }

  recordEvidence(evidence: Evidence): void {
    this.#graph.recordEvidence(evidence);
  }

  recordMutation(subjects: readonly string[]): void {
    this.#history.push(...this.#graph.recordMutation(subjects));
  }

  snapshot(): WorkflowSnapshot {
    return {
      enforcementLevel: this.host.enforcementLevel,
      transport: this.host.transport,
      mutationEpoch: this.#graph.mutationEpoch,
      tasks: this.#graph.tasks().map((task) => ({
        id: task.id,
        title: task.title,
        state: task.state,
        blockers: task.dependencies.filter((dependency) => this.#graph.get(dependency).state !== "VERIFIED"),
      })),
      evidence: this.#graph.evidence(),
      history: [...this.#history],
    };
  }

  /** W107 (amux C2): kernel-evaluated invariant rows with their judged
   * populations. The evaluation lives in the kernel (pure state
   * inspection); this surface relays it — the UI never self-derives
   * agreement from client-observed state. */
  invariants() {
    return {
      invariants: evaluateTaskGraphInvariants({ tasks: this.#graph.tasks(), evidence: this.#graph.evidence() }),
      mutationEpoch: this.#graph.mutationEpoch,
    };
  }

  persistedState() {
    return {
      ...this.#graph.persistedState(),
      history: [...this.#history],
      allowedCapabilities: [...this.allowedCapabilities],
      workspaceRoot: this.workspaceRoot,
      codingSessionCorrelation: this.#codingSessionCorrelation,
    };
  }
}

function pathWithinWorkspace(workspaceRoot: string, subject: string): boolean {
  if (subject.length === 0) return false;
  const root = canonicalExistingPath(resolve(workspaceRoot));
  const candidate = resolve(workspaceRoot, subject);
  if (root === undefined) return false;
  if (!isWithin(root, candidate)) return false;
  const canonicalCandidate = canonicalExistingPath(candidate);
  return canonicalCandidate !== undefined && isWithin(root, canonicalCandidate);
}

function canonicalExistingPath(path: string, seenSymlinks = new Set<string>()): string | undefined {
  let existing = path;
  while (true) {
    try {
      const stat = lstatSync(existing);
      if (stat.isSymbolicLink()) {
        if (seenSymlinks.has(existing)) return undefined;
        seenSymlinks.add(existing);
        const target = resolve(dirname(existing), readlinkSync(existing));
        return canonicalExistingPath(resolve(target, relative(existing, path)), seenSymlinks);
      }
      return resolve(realpathSync(existing), relative(existing, path));
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return undefined;
      existing = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
}
