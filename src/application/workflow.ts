import type { HostCapabilities, ProposedToolAction, ToolCapability } from "../adapters/host.js";
import type {
  Evidence,
  PolicyDecision,
  TaskId,
  TaskState,
  TransitionResult,
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

  constructor(
    graph: TaskGraph,
    readonly host: HostCapabilities,
    history: readonly { readonly taskId: TaskId; readonly from: TaskState; readonly to: TaskState }[] = [],
    readonly allowedCapabilities: ReadonlySet<ToolCapability> = new Set<ToolCapability>(["read", "mutation"]),
  ) {
    this.#graph = graph;
    this.#history.push(...history);
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
    return { ...this.#graph.persistedState(), history: [...this.#history] };
  }
}
