import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { LoopIterationRecord, LoopOutcome } from "./self-improvement-loop.js";

/**
 * W073 trigger surface: the hub-owned self-improvement loop registry. The
 * registry owns loop lifecycle (start / status / cancel) so an operator
 * surface — the admin CLI, the hub API, later the web UI — has one honest
 * place to project and control loops. It composes the W073 loop through an
 * injected `LoopRunner` (the production runner is a composition-time seam).
 *
 * Trust boundary (P1-1, adversarial review — stated precisely): starting a
 * loop is gated behind the verifier credential at the hub route layer, so the
 * ordinary surface token cannot switch on an autonomous mutation loop. The
 * registry itself performs no authentication; the boundary is the route, and
 * its strength is bounded by who can read `verifier.json` (see THREAT_MODEL
 * 2026-09-19 §1).
 *
 * Cancel is cooperative and boundary-scoped: `isCancelled` is consulted by the
 * runner, which maps it to the loop's `shouldStop` predicate — the in-flight
 * candidate always completes its gate (commit or discard) before the loop
 * stops. Nothing is aborted mid-mutation.
 */

export interface SelfImprovementSpec {
  /** Absolute path to the repository the loop may change. */
  readonly workspace: string;
  /** Human-defined statement of what "better" means. */
  readonly objective: string;
  readonly requiresReview?: boolean;
  readonly maxIterations: number;
  readonly maxConsecutiveRejections?: number;
  readonly budgetUsd?: number;
  readonly direction?: "higher" | "lower";
  readonly baselineScore?: number;
}

export interface LoopRunControls {
  readonly onIteration: (record: LoopIterationRecord) => void;
  readonly isCancelled: () => boolean;
}

/** The seam the registry drives; production composition wires the W073 loop. */
export type LoopRunner = (
  spec: SelfImprovementSpec,
  controls: LoopRunControls,
) => Promise<LoopOutcome>;

export type LoopState = "running" | "completed" | "stopped" | "cancelled";

export interface LoopRecord {
  readonly id: string;
  readonly spec: SelfImprovementSpec;
  readonly state: LoopState;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly cancelRequested: boolean;
  readonly iterations: readonly LoopIterationRecord[];
  readonly outcome?: LoopOutcome;
  readonly lastError?: string;
}

interface MutableLoopRecord {
  id: string;
  workspaceKey: string;
  spec: SelfImprovementSpec;
  state: LoopState;
  startedAt: string;
  finishedAt?: string;
  cancelRequested: boolean;
  iterations: LoopIterationRecord[];
  outcome?: LoopOutcome;
  lastError?: string;
}

export interface SelfImprovementRegistry {
  start(spec: SelfImprovementSpec): LoopRecord;
  status(): readonly LoopRecord[];
  get(id: string): LoopRecord | undefined;
  cancel(input: { readonly id?: string; readonly workspace?: string }): boolean;
}

export function createSelfImprovementRegistry(options: {
  readonly runLoop: LoopRunner;
  readonly now?: () => Date;
  readonly maxRecords?: number;
}): SelfImprovementRegistry {
  const now = options.now ?? ((): Date => new Date());
  const maxRecords = options.maxRecords ?? 64;
  const records = new Map<string, MutableLoopRecord>();

  const project = (record: MutableLoopRecord): LoopRecord => ({
    id: record.id,
    spec: record.spec,
    state: record.state,
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    cancelRequested: record.cancelRequested,
    iterations: [...record.iterations],
    ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  });

  const requireSpec = (spec: SelfImprovementSpec): void => {
    if (typeof spec !== "object" || spec === null) throw new TypeError("invalid loop spec: not an object");
    if (!isAbsolute(spec.workspace)) throw new TypeError(`loop spec workspace must be absolute: ${spec.workspace}`);
    if (typeof spec.objective !== "string" || spec.objective.trim().length === 0) {
      throw new TypeError("loop spec objective must be a non-empty string");
    }
    if (!Number.isSafeInteger(spec.maxIterations) || spec.maxIterations <= 0) {
      throw new TypeError("loop spec maxIterations must be a positive integer");
    }
    if (
      spec.maxConsecutiveRejections !== undefined &&
      (!Number.isSafeInteger(spec.maxConsecutiveRejections) || spec.maxConsecutiveRejections <= 0)
    ) {
      throw new TypeError("loop spec maxConsecutiveRejections must be a positive integer");
    }
    if (spec.budgetUsd !== undefined && (!Number.isFinite(spec.budgetUsd) || spec.budgetUsd <= 0)) {
      throw new TypeError("loop spec budgetUsd must be a positive number");
    }
    if (spec.direction !== undefined && spec.direction !== "higher" && spec.direction !== "lower") {
      throw new TypeError("loop spec direction must be 'higher' or 'lower'");
    }
    if (spec.baselineScore !== undefined && !Number.isFinite(spec.baselineScore)) {
      throw new TypeError("loop spec baselineScore must be a finite number");
    }
  };

  const workspaceKey = (workspace: string): string => {
    try {
      return realpathSync(workspace);
    } catch {
      return workspace;
    }
  };

  const activeKey = (key: string): MutableLoopRecord | undefined =>
    [...records.values()].find((record) => record.state === "running" && record.workspaceKey === key);

  const evictOldestFinished = (): void => {
    const finished = [...records.values()].filter((record) => record.state !== "running");
    while (finished.length + [...records.values()].filter((r) => r.state === "running").length > maxRecords) {
      const oldest = finished.shift();
      if (oldest === undefined) break;
      records.delete(oldest.id);
    }
  };

  return {
    start(spec: SelfImprovementSpec): LoopRecord {
      requireSpec(spec);
      const key = workspaceKey(spec.workspace);
      const existing = activeKey(key);
      if (existing !== undefined) {
        throw new TypeError(`a self-improvement loop is already running for workspace ${spec.workspace} (${existing.id})`);
      }
      const record: MutableLoopRecord = {
        id: `rsi-loop:${randomUUID()}`,
        workspaceKey: key,
        spec: { ...spec },
        state: "running",
        startedAt: now().toISOString(),
        cancelRequested: false,
        iterations: [],
      };
      records.set(record.id, record);

      const controls: LoopRunControls = {
        onIteration: (entry) => {
          record.iterations.push(entry);
        },
        isCancelled: () => record.cancelRequested,
      };
      void (async () => {
        try {
          const outcome = await options.runLoop(record.spec, controls);
          record.outcome = outcome;
          // P3 (adversarial review): label `cancelled` only for the loop's
          // actual cancel outcome. A loose `/cancel/` match would mislabel a
          // "cancellation check failed" stop as a successful operator cancel;
          // the W073 loop's cancel outcome reason is this exact string.
          const cancelAcknowledged = outcome.reason === "cancelled by operator";
          record.state = outcome.status === "completed"
            ? "completed"
            : record.cancelRequested && cancelAcknowledged
              ? "cancelled"
              : "stopped";
        } catch (error) {
          // A crashed runner is a stopped loop with the reason surfaced —
          // never a silent restart, never a fabricated outcome.
          record.state = "stopped";
          record.lastError = error instanceof Error ? error.message : String(error);
        }
        record.finishedAt = now().toISOString();
        evictOldestFinished();
      })();
      return project(record);
    },

    status(): readonly LoopRecord[] {
      return [...records.values()].map(project);
    },

    get(id: string): LoopRecord | undefined {
      const record = records.get(id);
      return record === undefined ? undefined : project(record);
    },

    cancel(input: { readonly id?: string; readonly workspace?: string }): boolean {
      let record: MutableLoopRecord | undefined;
      if (typeof input.id === "string" && input.id.length > 0) {
        record = records.get(input.id);
      } else if (typeof input.workspace === "string" && input.workspace.length > 0) {
        record = activeKey(workspaceKey(input.workspace));
      }
      if (record === undefined || record.state !== "running") return false;
      record.cancelRequested = true;
      return true;
    },
  };
}
