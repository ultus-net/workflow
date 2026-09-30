import type { ModelUsageMetrics } from "./model-usage-proxy.js";

/**
 * W111 per-task attribution: the boundary arithmetic, extracted pure and
 * side-effect free (the `UsageTurnTracker` pattern, `src/ui/usage.ts:34-58`)
 * so it is unit-testable without a live proxy. This module owns only the
 * DETERMINISTIC mechanism the design brief decided
 * (`docs/W111_ATTRIBUTION_DESIGN_BRIEF.md` §2.3): baseline at turn start,
 * delta = current − baseline per field floored at zero, the active-task
 * pointer read at boundary time, and the recorded absence when that read
 * throws. The host lanes that CALL it are a separate, still-open decision
 * (brief §5: the task→run mapping policy, concurrency/family granularity,
 * restart baseline semantics, the server-topology plumbing) — this module
 * neither chooses a lane nor infers a task.
 */

/**
 * The additive recorded shape, mirroring `RunUsageSummary`
 * (`src/integrations/run-registry.ts:43-58`) field for field, including the
 * P12 cache components (`cacheReadTokens`/`cacheCreateTokens`). Plain record:
 * the `/snapshot` payload is JSON.
 */
export interface TaskUsageSummary {
  /**
   * The kernel TaskId read at boundary time, or `UNATTRIBUTED_TASK_ID` when
   * the active-task pointer was absent. The pointer is NEVER inferred from
   * prompt text, a run title, a worktree, or a recent transition.
   */
  readonly taskId: string;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  /** P12: rides the delta; the OpenAI lane's cached reads stay at their measured zero (the recorded lane asymmetry). */
  readonly cacheReadTokens: number;
  /** P12: rides the delta. */
  readonly cacheCreateTokens: number;
  readonly recordedAt: string;
}

/**
 * The explicit unattributed marker. `application.activeTaskId()`
 * (`src/application/workflow.ts:412-417`) throws when no task is active or
 * the active task is not `IN_PROGRESS`; the design records that absence
 * rather than guessing a task, so unattributed spend stays stated instead of
 * silently folded into an arbitrary task (the amux under-attribution lesson).
 */
export const UNATTRIBUTED_TASK_ID = "unattributed";

/**
 * Reads the active-task pointer at boundary time, never inferring. A throwing
 * read (no active task / active task not IN_PROGRESS) becomes the recorded
 * absence marker; a non-throwing read is returned verbatim.
 */
export function resolveActiveTaskId(read: () => string): string {
  try {
    return read();
  } catch {
    return UNATTRIBUTED_TASK_ID;
  }
}

/**
 * The delta arithmetic, floored at zero (the `Math.max(0, …)` the
 * `UsageTurnTracker` precedent uses, `src/ui/usage.ts:50-51`). Returns
 * `undefined` when either the baseline or the current reading is absent —
 * no baseline means no honest delta.
 */
export function taskUsageDelta(
  baseline: ModelUsageMetrics | undefined,
  current: ModelUsageMetrics | undefined,
  taskId: string,
): Omit<TaskUsageSummary, "recordedAt"> | undefined {
  if (baseline === undefined || current === undefined) return undefined;
  return {
    taskId,
    requests: Math.max(0, current.requests - baseline.requests),
    promptTokens: Math.max(0, current.promptTokens - baseline.promptTokens),
    completionTokens: Math.max(0, current.completionTokens - baseline.completionTokens),
    totalTokens: Math.max(0, current.totalTokens - baseline.totalTokens),
    costUsd: Math.max(0, current.costUsd - baseline.costUsd),
    cacheReadTokens: Math.max(0, current.cacheReadTokens - baseline.cacheReadTokens),
    cacheCreateTokens: Math.max(0, current.cacheCreateTokens - baseline.cacheCreateTokens),
  };
}

/**
 * The boundary tracker. Callers supply the turn-start reading to `begin` and
 * the turn-end reading to `complete`; only a COMPLETED turn publishes a
 * delta — a `failed`/`cancelled` turn passes no current reading (or uses
 * `observe`'s state machine), exactly mirroring `UsageTurnTracker`'s honesty
 * rule (`src/ui/usage.ts:47-55`).
 */
export class TaskUsageTracker {
  #baseline: ModelUsageMetrics | undefined;

  /** Turn start: capture the cumulative baseline. */
  begin(current: ModelUsageMetrics | undefined): void {
    this.#baseline = current;
  }

  /**
   * Turn end: compute the delta against the captured baseline. A turn with no
   * baseline, or a non-completed ending expressed by passing `undefined`
   * current, publishes nothing. The active-task pointer is read HERE (boundary
   * time), never earlier.
   */
  complete(
    current: ModelUsageMetrics | undefined,
    readTaskId: () => string,
  ): Omit<TaskUsageSummary, "recordedAt"> | undefined {
    const baseline = this.#baseline;
    this.#baseline = undefined;
    if (baseline === undefined || current === undefined) return undefined;
    return taskUsageDelta(baseline, current, resolveActiveTaskId(readTaskId));
  }

  /**
   * State-machine edge mirroring `UsageTurnTracker.observe`
   * (`src/ui/usage.ts:43-56`): a transition INTO "running" baselines; INTO
   * "completed" publishes the delta; "failed"/"cancelled" clear the baseline
   * and publish nothing. Returns the delta only at a completed edge so it can
   * be recorded verbatim.
   */
  observe(
    sessionState: string | undefined,
    current: ModelUsageMetrics | undefined,
    readTaskId: () => string,
  ): Omit<TaskUsageSummary, "recordedAt"> | undefined {
    if (current === undefined) return undefined;
    if (sessionState === "running") {
      if (this.#baseline === undefined) this.#baseline = current;
      return undefined;
    }
    if (this.#baseline === undefined) return undefined;
    const baseline = this.#baseline;
    this.#baseline = undefined;
    if (sessionState !== "completed") return undefined;
    return taskUsageDelta(baseline, current, resolveActiveTaskId(readTaskId));
  }
}

/**
 * The host-lane seam: the three operations a turn-boundary hook needs from its
 * lane. The lane supplies where the cumulative metering reading comes from, how
 * to read the active-task pointer (at boundary time), and where to publish a
 * recorded delta. It is deliberately narrow so both lanes (the ACP session's
 * `start()` turn and the hub scheduler's `runTurn` finally) compose the SAME
 * boundary arithmetic instead of each re-implementing it.
 */
export interface TaskUsageSink {
  /** The cumulative metering reading at call time; `undefined` when the lane is unmetered. */
  usage(): ModelUsageMetrics | undefined;
  /** The active-task pointer read AT boundary time. May throw (no active task) — recorded as the absence. */
  readTaskId(): string;
  /** Publish a completed turn's delta (never called for `failed`/`cancelled`). */
  record(delta: Omit<TaskUsageSummary, "recordedAt">): void;
}

/**
 * Compose the driver-side sink a host lane supplies to
 * `AcpRuntimeOptions.taskUsage` (`src/integrations/acp-runtime.ts`): read the
 * lane's cumulative metering reading and publish a recorded delta to the lane's
 * journal writer. The `usage` closure is DEFERRED — a composition root builds
 * the sink before the runtime exists, so the reading is taken lazily at the
 * turn boundary. Pure composition; no IO of its own.
 */
export function laneTaskUsageSink(
  usage: () => ModelUsageMetrics | undefined,
  record: (delta: Omit<TaskUsageSummary, "recordedAt">) => void,
): { readonly usage: () => ModelUsageMetrics | undefined; readonly record: (delta: Omit<TaskUsageSummary, "recordedAt">) => void } {
  return { usage, record };
}

/**
 * W111 / P4 topology Option A1 (issue #283): a cross-process surface
 * observation. A process-separated interactive surface computes its own
 * boundary delta (the same `TaskUsageAttributor` arithmetic) and posts it to
 * the hub's observability-only `/usage/record` route. Because the surface is
 * the recorder, the task id it carries is NOT hub-authoritative attribution —
 * it is a surface OBSERVATION, labelled with the `recordedBy` provenance stamp
 * and kept in its own journal, never merged into the canonical `taskUsage`
 * rollups (the W153 client-never-supplies-attribution principle,
 * `docs/P4_TOPOLOGY_SPLIT_BRIEF.md` §2.1 A1). The hub validates the stamp's
 * `surface:` prefix so a client cannot claim another authority class.
 */
export interface SurfaceUsageObservation extends Omit<TaskUsageSummary, "recordedAt"> {
  /**
   * The surface provenance stamp, e.g. `surface:web-service`. The hub requires
   * a non-empty `surface:` prefix (a client cannot claim a `hub`-class label);
   * the attribution stays a labelled observation, never canonical.
   */
  readonly recordedBy: string;
}

/**
 * The recorded form of a surface observation: the posted delta plus the
 * registry-appended `recordedAt` (the hub stamps it at journal time, exactly
 * like the canonical `TaskUsageSummary`). Plain record: `/snapshot` is JSON.
 */
export interface SurfaceUsageSummary extends SurfaceUsageObservation {
  readonly recordedAt: string;
}

/**
 * Compose the cross-process sink a process-separated surface supplies to
 * `AcpRuntimeOptions.taskUsage`: the SAME deferred reading and completed-only
 * rule as `laneTaskUsageSink`, but every recorded delta is STAMPED with the
 * surface's `recordedBy` provenance and handed to `post`, which relays it to
 * the hub's observability-only route. The stamp is added here, at the surface,
 * so the hub never has to trust an unstamped body. Pure composition; the
 * transport (`post`) fails closed on its own.
 */
export function surfaceUsageSink(
  usage: () => ModelUsageMetrics | undefined,
  recordedBy: string,
  post: (observation: SurfaceUsageObservation) => void,
): { readonly usage: () => ModelUsageMetrics | undefined; readonly record: (delta: Omit<TaskUsageSummary, "recordedAt">) => void } {
  return laneTaskUsageSink(usage, (delta) => post({ ...delta, recordedBy }));
}

/**
 * The lane-side boundary hook: `begin()` at turn start captures the cumulative
 * baseline, `end(completed)` at turn end publishes the delta through the sink's
 * `record`. ONLY a completed turn publishes — `end(false)` passes no current
 * reading, so the tracker clears the baseline and records nothing (the
 * `failed`/`cancelled` honesty rule, `src/ui/usage.ts:47-55`). `begin`/`end`
 * are called per turn, so a lane that reuses one hook across turns never leaks
 * a baseline. Pure control flow over `TaskUsageTracker`; no IO of its own.
 */
export class TaskUsageAttributor {
  readonly #sink: TaskUsageSink;
  readonly #tracker = new TaskUsageTracker();

  constructor(sink: TaskUsageSink) {
    this.#sink = sink;
  }

  /** Turn start: capture the cumulative baseline from the lane's metering reading. */
  begin(): void {
    this.#tracker.begin(this.#sink.usage());
  }

  /**
   * Turn end. The pointer is read HERE (boundary time) only for a completed
   * turn; a `failed`/`cancelled` turn (`completed` false) passes no current
   * reading and publishes nothing. Returns the published delta when one was
   * recorded (for callers/tests), `undefined` otherwise.
   */
  end(completed: boolean): Omit<TaskUsageSummary, "recordedAt"> | undefined {
    const delta = this.#tracker.complete(
      completed ? this.#sink.usage() : undefined,
      () => this.#sink.readTaskId(),
    );
    if (delta !== undefined) this.#sink.record(delta);
    return delta;
  }
}
