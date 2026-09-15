import type { HostCapabilities, ProposedToolAction, ToolCapability } from "./host.js";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  Evidence,
  PolicyDecision,
  TaskId,
  TaskState,
  TransitionResult,
  WorkflowTask,
} from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { mutationGate, verifyingGate, type CheckpointLedger } from "../pedagogy/checkpoints.js";

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
  // Plan Task F3: skill delivery preconditions. A read_skill observation is a
  // PRECONDITION for mutating actions, never `requiredEvidence` — a
  // model-initiated tool call must not self-certify task verification. The
  // journal maps skill -> the task that read it; per-task freshness means a
  // new task must re-read its required skills.
  readonly #taskRequiredSkills = new Map<TaskId, readonly string[]>();
  readonly #skillReads = new Map<string, TaskId>();

  constructor(
    graph: TaskGraph,
    readonly host: HostCapabilities,
    history: readonly { readonly taskId: TaskId; readonly from: TaskState; readonly to: TaskState }[] = [],
    readonly allowedCapabilities: ReadonlySet<ToolCapability> = new Set<ToolCapability>(["read", "mutation"]),
    readonly workspaceRoot?: string,
    codingSessionCorrelation?: string,
  ) {
    if (workspaceRoot !== undefined && !isAbsolute(workspaceRoot)) {
      throw new TypeError("workspace root must be an absolute path");
    }
    this.#graph = graph;
    this.#history.push(...history);
    if (codingSessionCorrelation !== undefined) this.#codingSessionCorrelation = codingSessionCorrelation;
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

  authorize(action: ProposedToolAction): PolicyDecision {
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
    this.#graph.addTask({ ...task, state: "BLOCKED" });
  }

  addDependency(taskId: TaskId, dependencyId: TaskId): void {
    this.#graph.addDependency(taskId, dependencyId);
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
