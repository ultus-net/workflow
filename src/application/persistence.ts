import { open, readFile, rename, unlink } from "node:fs/promises";

import type { HostCapabilities } from "./host.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { WorkflowApplication } from "./workflow.js";

export interface PersistedWorkflow {
  readonly version: number;
  readonly state: ReturnType<WorkflowApplication["persistedState"]>;
}

export class WorkflowVersionConflict extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`workflow version conflict: expected ${expected}, found ${actual}`);
    this.name = "WorkflowVersionConflict";
  }
}

export class JsonWorkflowStore {
  constructor(readonly path: string) {}

  async load(host: HostCapabilities): Promise<{ application: WorkflowApplication; version: number }> {
    const persisted = await this.#read();
    const graph = TaskGraph.restore(persisted.state);
    const recoveryHistory = persisted.state.tasks
      .filter((task) => task.state === "IN_PROGRESS")
      .map((task) => ({ taskId: task.id, from: "IN_PROGRESS" as const, to: "FAILED" as const }));
    return {
      application: new WorkflowApplication(
        graph,
        host,
        [...persisted.state.history, ...recoveryHistory],
        new Set(persisted.state.allowedCapabilities ?? ["read", "mutation"]),
        persisted.state.workspaceRoot,
        persisted.state.codingSessionCorrelation,
      ),
      version: persisted.version,
    };
  }

  async create(application: WorkflowApplication): Promise<number> {
    return this.#withLock(async () => {
      try {
        await readFile(this.path, "utf8");
        throw new WorkflowVersionConflict(-1, (await this.#read()).version);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.#write({ version: 0, state: application.persistedState() });
      return 0;
    });
  }

  async save(application: WorkflowApplication, expectedVersion: number): Promise<number> {
    return this.#withLock(async () => {
      const current = await this.#read();
      if (current.version !== expectedVersion) throw new WorkflowVersionConflict(expectedVersion, current.version);
      const next = expectedVersion + 1;
      await this.#write({ version: next, state: application.persistedState() });
      return next;
    });
  }

  async #read(): Promise<PersistedWorkflow> {
    const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
    if (!isPersistedWorkflow(parsed)) throw new TypeError("invalid persisted workflow");
    return parsed;
  }

  async #write(value: PersistedWorkflow): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2), "utf8");
      await file.sync();
      await file.close();
      await rename(temporary, this.path);
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("workflow store is locked by another writer", { cause: error });
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

function isPersistedWorkflow(value: unknown): value is PersistedWorkflow {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 0) return false;
  if (typeof record.state !== "object" || record.state === null) return false;
  const state = record.state as Record<string, unknown>;
  if (!(
    Array.isArray(state.tasks) && state.tasks.every(isWorkflowTask) &&
    Array.isArray(state.evidence) && state.evidence.every(isEvidence) &&
    Array.isArray(state.history) && state.history.every(isTransitionRecord) &&
    Number.isSafeInteger(state.mutationEpoch) && (state.mutationEpoch as number) >= 0 &&
    (state.allowedCapabilities === undefined || (Array.isArray(state.allowedCapabilities) && state.allowedCapabilities.every(isToolCapability))) &&
    (state.workspaceRoot === undefined || (typeof state.workspaceRoot === "string" && state.workspaceRoot.startsWith("/"))) &&
    (state.codingSessionCorrelation === undefined || isNonEmptyString(state.codingSessionCorrelation))
  )) return false;
  const taskIds = new Set((state.tasks as Record<string, unknown>[]).map((task) => task.id));
  return taskIds.size === state.tasks.length &&
    isCoherentHistory(
      state.tasks as Record<string, unknown>[],
      state.history as Record<string, unknown>[],
    );
}

const TASK_STATES = new Set(["BLOCKED", "READY", "IN_PROGRESS", "VERIFYING", "VERIFIED", "FAILED"]);
const EVIDENCE_AUTHORITIES = new Set(["environment", "host", "mcp", "reviewer"]);
const TOOL_CAPABILITIES = new Set(["read", "mutation", "process", "spawn", "credentials", "network"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isToolCapability(value: unknown): value is import("./host.js").ToolCapability {
  return typeof value === "string" && TOOL_CAPABILITIES.has(value);
}

function isWorkflowTask(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return isNonEmptyString(task.id) && isNonEmptyString(task.title) && TASK_STATES.has(task.state as string) &&
    Array.isArray(task.dependencies) && task.dependencies.every(isNonEmptyString) &&
    Array.isArray(task.requiredEvidence) && task.requiredEvidence.every((requirement) => {
      if (typeof requirement !== "object" || requirement === null) return false;
      const record = requirement as Record<string, unknown>;
      return EVIDENCE_AUTHORITIES.has(record.authority as string) && isNonEmptyString(record.subject);
    });
}

function isEvidence(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return isNonEmptyString(evidence.id) && isNonEmptyString(evidence.observationId) &&
    EVIDENCE_AUTHORITIES.has(evidence.authority as string) && isNonEmptyString(evidence.subject) &&
    (evidence.result === "passed" || evidence.result === "failed") &&
    (evidence.freshness === "fresh" || evidence.freshness === "stale") &&
    Number.isSafeInteger(evidence.mutationEpoch) && (evidence.mutationEpoch as number) >= 0 &&
    typeof evidence.observedAt === "string" && !Number.isNaN(Date.parse(evidence.observedAt));
}

function isTransitionRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const transition = value as Record<string, unknown>;
  return isNonEmptyString(transition.taskId) && TASK_STATES.has(transition.from as string) && TASK_STATES.has(transition.to as string) &&
    isLegalHistoryTransition(transition.from as string, transition.to as string);
}

function isLegalHistoryTransition(from: string, to: string): boolean {
  return (from === "READY" && to === "IN_PROGRESS") ||
    (from === "IN_PROGRESS" && (to === "VERIFYING" || to === "FAILED")) ||
    (from === "VERIFYING" && (to === "VERIFIED" || to === "FAILED")) ||
    (from === "VERIFIED" && to === "VERIFYING") ||
    (from === "FAILED" && (to === "READY" || to === "BLOCKED"));
}

function isCoherentHistory(tasks: Record<string, unknown>[], history: Record<string, unknown>[]): boolean {
  const taskStates = new Map(tasks.map((task) => [task.id as string, task.state as string]));
  const dependencies = new Map(tasks.map((task) => [task.id as string, task.dependencies as string[]]));
  const tasksWithHistory = new Set(history.map((transition) => transition.taskId as string));
  const verified = new Set(
    tasks
      .filter((task) => task.state === "VERIFIED" && !tasksWithHistory.has(task.id as string))
      .map((task) => task.id as string),
  );
  const lastTransitions = new Map<string, Record<string, unknown>>();
  for (const transition of history) {
    const id = transition.taskId as string;
    if (!taskStates.has(id)) return false;
    const previous = lastTransitions.get(id);
    if (previous !== undefined && previous.to !== transition.from) return false;
    if (transition.from === "READY" && transition.to === "IN_PROGRESS" &&
      !(dependencies.get(id) ?? []).every((dependency) => verified.has(dependency))) return false;
    if (transition.to === "VERIFIED") verified.add(id);
    if (transition.from === "VERIFIED" && transition.to === "VERIFYING") verified.delete(id);
    lastTransitions.set(id, transition);
  }
  for (const [id, transition] of lastTransitions) {
    const current = taskStates.get(id);
    if (current !== transition.to) return false;
  }
  return true;
}
