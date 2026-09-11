import type {
  Evidence,
  EvidenceRequirement,
  TaskId,
  TaskState,
  TransitionRecord,
  TransitionResult,
  WorkflowTask,
} from "./contracts.js";

const LEGAL_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  BLOCKED: [],
  READY: ["IN_PROGRESS"],
  IN_PROGRESS: ["VERIFYING", "FAILED"],
  VERIFYING: ["VERIFIED", "FAILED"],
  VERIFIED: [],
  FAILED: [],
};

export class TaskGraph {
  readonly #tasks = new Map<TaskId, WorkflowTask>();
  readonly #evidence: Evidence[] = [];
  #mutationEpoch = 0;

  constructor(tasks: readonly WorkflowTask[]) {
    for (const task of tasks) {
      if (this.#tasks.has(task.id)) {
        throw new TypeError(`duplicate task: ${task.id}`);
      }
      this.#tasks.set(task.id, { ...task, dependencies: [...task.dependencies] });
    }

    this.#validateDependencies();
    this.#assertAcyclic();
    this.#recomputeReadiness();
  }

  static restore(input: {
    readonly tasks: readonly WorkflowTask[];
    readonly evidence: readonly Evidence[];
    readonly mutationEpoch: number;
  }): TaskGraph {
    if (!Number.isSafeInteger(input.mutationEpoch) || input.mutationEpoch < 0) {
      throw new TypeError("invalid persisted mutation epoch");
    }
    const persistedStates = new Map(input.tasks.map((task) => [task.id, task.state]));
    for (const task of input.tasks) {
      if (task.state !== "READY" && task.state !== "BLOCKED") continue;
      const shouldBeReady = task.dependencies.every((dependency) => persistedStates.get(dependency) === "VERIFIED");
      if ((task.state === "READY") !== shouldBeReady) {
        throw new TypeError(`persisted task ${task.id} has inconsistent dependency readiness`);
      }
    }
    const graph = new TaskGraph(input.tasks.map((task) => ({
      ...task,
      state: task.state === "IN_PROGRESS" ? "FAILED" : task.state,
    })));
    graph.#mutationEpoch = input.mutationEpoch;
    for (const evidence of input.evidence) {
      if (evidence.mutationEpoch > input.mutationEpoch) throw new TypeError("persisted evidence is from a future mutation epoch");
      graph.#evidence.push({ ...evidence });
    }
    for (const task of graph.#tasks.values()) {
      if (task.state === "VERIFIED" && !task.requiredEvidence.every((requirement) => graph.#hasEvidence(requirement))) {
        throw new TypeError(`persisted verified task ${task.id} does not have fresh passing evidence for every requirement`);
      }
    }
    return graph;
  }

  persistedState(): { readonly tasks: readonly WorkflowTask[]; readonly evidence: readonly Evidence[]; readonly mutationEpoch: number } {
    return {
      tasks: this.tasks(),
      evidence: this.evidence(),
      mutationEpoch: this.#mutationEpoch,
    };
  }

  get(id: TaskId): WorkflowTask {
    const task = this.#tasks.get(id);
    if (task === undefined) {
      throw new TypeError(`unknown task: ${id}`);
    }
    return task;
  }

  tasks(): readonly WorkflowTask[] {
    return [...this.#tasks.values()];
  }

  get mutationEpoch(): number {
    return this.#mutationEpoch;
  }

  evidenceFor(subject: string): readonly Evidence[] {
    return this.#evidence.filter((evidence) => evidence.subject === subject);
  }

  evidence(): readonly Evidence[] {
    return [...this.#evidence];
  }

  recordEvidence(evidence: Evidence): void {
    if (evidence.mutationEpoch !== this.#mutationEpoch) {
      throw new TypeError("evidence does not observe the current mutation epoch");
    }
    this.#evidence.push(evidence);
  }

  recordMutation(subjects: readonly string[]): readonly TransitionRecord[] {
    this.#mutationEpoch += 1;
    const transitions: TransitionRecord[] = [];
    const affected = new Set(subjects);
    for (let index = 0; index < this.#evidence.length; index += 1) {
      const evidence = this.#evidence[index];
      if (evidence !== undefined && affected.has(evidence.subject) && evidence.freshness === "fresh") {
        this.#evidence[index] = { ...evidence, freshness: "stale" };
      }
    }

    for (const [id, task] of this.#tasks) {
      if (task.state === "VERIFIED" && task.requiredEvidence.some((requirement) => affected.has(requirement.subject))) {
        this.#tasks.set(id, { ...task, state: "VERIFYING" });
        transitions.push({ taskId: id, from: "VERIFIED", to: "VERIFYING" });
      }
    }
    this.#recomputeReadiness();
    return transitions;
  }

  transition(id: TaskId, requested: TaskState): TransitionResult {
    const task = this.get(id);
    if (!LEGAL_TRANSITIONS[task.state].includes(requested)) {
      return {
        kind: "rejected",
        code: "ILLEGAL_TRANSITION",
        reason: `cannot transition ${task.id} from ${task.state} to ${requested}`,
        taskId: task.id,
        from: task.state,
        requested,
      };
    }

    if (requested === "VERIFIED" && !task.requiredEvidence.every((requirement) => this.#hasEvidence(requirement))) {
      return {
        kind: "rejected",
        code: "EVIDENCE_REQUIRED",
        reason: `task ${task.id} does not have fresh passing evidence for every requirement`,
        taskId: task.id,
        from: task.state,
        requested,
      };
    }

    const from = task.state;
    this.#tasks.set(id, { ...task, state: requested });
    this.#recomputeReadiness();
    return { kind: "accepted", transition: { taskId: id, from, to: requested } };
  }

  #hasEvidence(requirement: EvidenceRequirement): boolean {
    return this.#evidence.some(
      (evidence) =>
        evidence.authority === requirement.authority &&
        evidence.subject === requirement.subject &&
        evidence.result === "passed" &&
        evidence.freshness === "fresh",
    );
  }

  addDependency(taskId: TaskId, dependencyId: TaskId): void {
    const task = this.get(taskId);
    this.get(dependencyId);
    if (taskId === dependencyId) {
      throw new TypeError(`task ${taskId} cannot depend on itself`);
    }
    if (task.state !== "READY" && task.state !== "BLOCKED") {
      throw new TypeError(`cannot change dependencies for task in ${task.state}`);
    }
    if (task.dependencies.includes(dependencyId)) {
      return;
    }

    const previous = task;
    this.#tasks.set(taskId, { ...task, dependencies: [...task.dependencies, dependencyId] });
    try {
      this.#assertAcyclic();
    } catch (error) {
      this.#tasks.set(taskId, previous);
      throw error;
    }
    this.#recomputeReadiness();
  }

  #validateDependencies(): void {
    for (const task of this.#tasks.values()) {
      for (const dependency of task.dependencies) {
        if (dependency === task.id) {
          throw new TypeError(`task ${task.id} cannot depend on itself`);
        }
        if (!this.#tasks.has(dependency)) {
          throw new TypeError(`task ${task.id} has missing dependency ${dependency}`);
        }
      }
    }
  }

  #assertAcyclic(): void {
    const visiting = new Set<TaskId>();
    const visited = new Set<TaskId>();

    const visit = (id: TaskId): void => {
      if (visiting.has(id)) {
        throw new TypeError(`dependency cycle includes task ${id}`);
      }
      if (visited.has(id)) {
        return;
      }
      visiting.add(id);
      for (const dependency of this.get(id).dependencies) {
        visit(dependency);
      }
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of this.#tasks.keys()) {
      visit(id);
    }
  }

  #recomputeReadiness(): void {
    for (const [id, task] of this.#tasks) {
      if (task.state !== "READY" && task.state !== "BLOCKED") {
        continue;
      }
      const ready = task.dependencies.every(
        (dependency) => this.get(dependency).state === "VERIFIED",
      );
      const state: TaskState = ready ? "READY" : "BLOCKED";
      if (task.state !== state) {
        this.#tasks.set(id, { ...task, state });
      }
    }
  }
}
