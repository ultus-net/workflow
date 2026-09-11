import type { HostCapabilities, ProposedToolAction, ToolCapability } from "../adapters/host.js";
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

  setCodingSessionCorrelation(sessionId: string): void {
    if (sessionId.trim().length === 0) throw new TypeError("coding session correlation must be non-empty");
    this.#codingSessionCorrelation = sessionId;
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
    return { kind: "allow" };
  }

  transition(taskId: TaskId, requested: TaskState): TransitionResult {
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
