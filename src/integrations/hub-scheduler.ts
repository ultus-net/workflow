import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import type { WorkflowRunController } from "./cline-tui-bridge.js";

/**
 * Plan Tasks C1/C2: hub-native scheduled runs and per-run budget enforcement.
 *
 * The scheduler owns no clocks in tests — `tick(now)` is deterministic. A due
 * schedule spawns a run (`/run/begin` semantics), drives one contained agent
 * turn through an injected seam, and finishes it (`/run/finish` semantics)
 * with `requiresReview` defaulting to true, so every scheduled run is
 * review-gated and (when wired) test-evidenced by construction. Fail-closed
 * rules: a crashed turn fails its run; a rejected finish gate leaves the run
 * VERIFYING (never a fabricated verdict); scheduler errors never mutate task
 * state.
 *
 * Budget enforcement (C2) reads metering-proxy metrics and cancels the turn
 * on the first violating event; the run then fails with the budget as the
 * blocking reason.
 */

export interface RunBudget {
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxTotalTokens?: number;
  readonly maxCostUsd?: number;
}

export interface UsageSnapshot {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export interface BudgetGuard {
  /** Wire the guard into the session's event stream. */
  attach(): void;
  /** Check one session event; cancels the turn on the first violation. */
  checkEvent(event: { readonly type: string }): void;
  /** The recorded violation reason, once one has occurred. */
  violation(): string | undefined;
}

export function budgetViolation(usage: UsageSnapshot, budget: RunBudget): string | undefined {
  if (budget.maxTotalTokens !== undefined && usage.totalTokens > budget.maxTotalTokens) {
    return `budget exceeded: total tokens ${usage.totalTokens} > cap ${budget.maxTotalTokens}`;
  }
  if (budget.maxInputTokens !== undefined && usage.promptTokens > budget.maxInputTokens) {
    return `budget exceeded: input tokens ${usage.promptTokens} > cap ${budget.maxInputTokens}`;
  }
  if (budget.maxOutputTokens !== undefined && usage.completionTokens > budget.maxOutputTokens) {
    return `budget exceeded: output tokens ${usage.completionTokens} > cap ${budget.maxOutputTokens}`;
  }
  if (budget.maxCostUsd !== undefined && usage.costUsd > budget.maxCostUsd) {
    return `budget exceeded: cost $${usage.costUsd.toFixed(4)} > cap $${budget.maxCostUsd.toFixed(4)}`;
  }
  return undefined;
}

export function createBudgetGuard(options: {
  readonly budget: RunBudget;
  readonly usageSnapshot: () => UsageSnapshot | undefined;
  readonly cancel: () => void | Promise<void>;
  readonly subscribe: (listener: (event: { readonly type: string }) => void) => () => void;
}): BudgetGuard {
  let violation: string | undefined;
  let cancelled = false;
  const checkEvent = (_event: { readonly type: string }): void => {
    void _event;
    if (violation !== undefined) return;
    const usage = options.usageSnapshot();
    if (usage === undefined) return;
    const reason = budgetViolation(usage, options.budget);
    if (reason === undefined) return;
    violation = reason;
    if (!cancelled) {
      cancelled = true;
      void Promise.resolve(options.cancel()).catch(() => undefined);
    }
  };
  return {
    attach() {
      options.subscribe(checkEvent);
    },
    checkEvent,
    violation: () => violation,
  };
}

// ── Cron parsing (5-field, no deps) ────────────────────────────────────────

const CRON_BOUNDS = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day-of-month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12 },
  { label: "day-of-week", min: 0, max: 6 },
] as const;

function parseCronField(spec: string, index: number): ReadonlySet<number> {
  const bounds = CRON_BOUNDS[index]!;
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    // An empty list part (e.g. "1,,2") is a typo, not a wildcard: fail closed.
    if (part.length === 0) throw new TypeError(`invalid cron ${bounds.label}: '${spec}'`);
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : cronNumber(stepPart, bounds);
    if (step < 1) throw new TypeError(`invalid cron ${bounds.label} step: '${spec}'`);
    let from: number;
    let to: number;
    if (rangePart === "*" || rangePart === undefined || rangePart === "") {
      from = bounds.min;
      to = bounds.max;
    } else if (rangePart.includes("-")) {
      const [rawFrom, rawTo] = rangePart.split("-");
      // A missing bound (e.g. "-5" or "5-") is malformed, never an implicit 0.
      if (rawFrom === undefined || rawFrom.length === 0 || rawTo === undefined || rawTo.length === 0) {
        throw new TypeError(`invalid cron ${bounds.label} range: '${spec}'`);
      }
      from = cronNumber(rawFrom, bounds);
      to = cronNumber(rawTo, bounds);
      if (from > to) throw new TypeError(`invalid cron ${bounds.label} range: '${spec}'`);
    } else {
      from = cronNumber(rangePart, bounds);
      to = from;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

function cronNumber(raw: string, bounds: (typeof CRON_BOUNDS)[number]): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new TypeError(`invalid cron ${bounds.label} value: '${raw}'`);
  }
  return value;
}

export function cronMatches(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new TypeError(`invalid cron expression (expected 5 fields): '${expression}'`);
  const minute = parseCronField(fields[0]!, 0);
  const hour = parseCronField(fields[1]!, 1);
  const dayOfMonth = parseCronField(fields[2]!, 2);
  const month = parseCronField(fields[3]!, 3);
  const dayOfWeek = parseCronField(fields[4]!, 4);
  if (!minute.has(date.getMinutes()) || !hour.has(date.getHours()) || !month.has(date.getMonth() + 1)) {
    return false;
  }
  // Vixie-cron day semantics: when both day-of-month and day-of-week are
  // restricted, either match fires (standard crontab behavior); when only
  // one is restricted, both must agree.
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";
  const matchesDom = dayOfMonth.has(date.getDate());
  const matchesDow = dayOfWeek.has(date.getDay());
  return domRestricted && dowRestricted
    ? matchesDom || matchesDow
    : matchesDom && matchesDow;
}

// ── Persisted schedule table ───────────────────────────────────────────────

export interface ScheduleDefinition {
  readonly id: string;
  readonly title: string;
  readonly cron: string;
  readonly prompt: string;
  readonly workspace?: string;
  readonly requiresReview?: boolean;
  readonly budget?: RunBudget;
}

export function loadSchedulesTable(path: string): readonly ScheduleDefinition[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // Only an absent table means "no schedules". Permission or type errors
    // must not silently disable scheduling.
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`invalid schedule table: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
    throw new TypeError("invalid schedule table: unsupported or missing version");
  }
  const schedules = (parsed as { schedules?: unknown }).schedules;
  if (!Array.isArray(schedules)) throw new TypeError("invalid schedule table: schedules must be an array");
  return schedules.map((entry) => requireSchedule(entry));
}

export function saveSchedulesTable(path: string, schedules: readonly ScheduleDefinition[]): void {
  const validated = schedules.map((entry) => requireSchedule(entry));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, schedules: validated }, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function requireSchedule(entry: unknown): ScheduleDefinition {
  if (typeof entry !== "object" || entry === null) throw new TypeError("invalid schedule table: entry is not an object");
  const record = entry as Record<string, unknown>;
  for (const key of ["id", "title", "cron", "prompt"] as const) {
    if (typeof record[key] !== "string" || (record[key] as string).trim().length === 0) {
      throw new TypeError(`invalid schedule table: ${key} must be a non-empty string`);
    }
  }
  if (record.workspace !== undefined && typeof record.workspace !== "string") {
    throw new TypeError("invalid schedule table: workspace must be a string");
  }
  if (record.requiresReview !== undefined && typeof record.requiresReview !== "boolean") {
    throw new TypeError("invalid schedule table: requiresReview must be a boolean");
  }
  cronMatches(record.cron as string, new Date(2026, 0, 1, 0, 0, 0, 0));
  if (record.budget !== undefined) requireBudget(record.budget);
  return entry as ScheduleDefinition;
}

function requireBudget(entry: unknown): void {
  if (typeof entry !== "object" || entry === null) throw new TypeError("invalid schedule table: budget must be an object");
  const budget = entry as Record<string, unknown>;
  for (const key of ["maxInputTokens", "maxOutputTokens", "maxTotalTokens", "maxCostUsd"] as const) {
    if (budget[key] === undefined) continue;
    if (typeof budget[key] !== "number" || !Number.isFinite(budget[key] as number) || (budget[key] as number) <= 0) {
      throw new TypeError(`invalid schedule table: budget ${key} must be a positive number`);
    }
  }
}

// ── Scheduler ──────────────────────────────────────────────────────────────

export interface HubScheduler {
  /** Evaluate every schedule at `now` (deterministic; no timers involved). */
  tick(now?: Date): Promise<void>;
  /** Start the wall-clock loop (one evaluation per minute, unref'd). */
  start(): void;
  stop(): void;
}

export function createHubScheduler(options: {
  readonly controller: WorkflowRunController;
  readonly schedules: () => Promise<readonly ScheduleDefinition[]> | readonly ScheduleDefinition[];
  readonly runTurn: (input: {
    readonly runId: string;
    readonly workspace: string | undefined;
    readonly prompt: string;
    readonly budget: RunBudget | undefined;
  }) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly recordBlockingReason?: (input: { readonly runId: string; readonly reason: string }) => void;
  readonly now?: () => Date;
  /**
   * Plan Task G5 wiring: advisory guidance prepended to every scheduled
   * prompt (honestly advisory — text, never a boundary). Absent means the
   * schedule's prompt reaches the turn unchanged.
   */
  readonly promptGuidance?: string;
}): HubScheduler {
  const log = options.log ?? (() => undefined);
  const lastFiredMinute = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;

  const fire = async (schedule: ScheduleDefinition): Promise<void> => {
    const runId = `schedule:${schedule.id}:${randomUUID()}`;
    try {
      await options.controller.begin({
        runId,
        title: schedule.title,
        ...(schedule.workspace === undefined ? {} : { workspace: schedule.workspace }),
        ...(schedule.requiresReview === false ? { requiresReview: false } : { requiresReview: true }),
      });
    } catch (error) {
      log(`scheduler '${schedule.id}': could not begin run: ${error instanceof Error ? error.message : String(error)}`);
      lastFiredMinute.delete(schedule.id);
      return;
    }
    try {
      await options.runTurn({
        runId,
        workspace: schedule.workspace,
        prompt: options.promptGuidance === undefined ? schedule.prompt : options.promptGuidance + schedule.prompt,
        budget: schedule.budget,
      });
    } catch (error) {
      // A crashed (or budget-aborted) turn genuinely failed: close the run
      // as failed with the reason surfaced.
      const reason = error instanceof Error ? error.message : String(error);
      log(`scheduler '${schedule.id}': run ${runId} failed: ${reason}`);
      options.recordBlockingReason?.({ runId, reason });
      try {
        await options.controller.finish({ runId, outcome: "failed" });
      } catch (finishError) {
        log(`scheduler '${schedule.id}': failed run ${runId} could not be closed: ${
          finishError instanceof Error ? finishError.message : String(finishError)
        }`);
      }
      return;
    }
    try {
      await options.controller.finish({ runId, outcome: "verified" });
    } catch (error) {
      // A rejected finish gate (review/test evidence) is not a run failure:
      // the run stays VERIFYING at the gate — the honest state — with the
      // blocking reason surfaced. Overriding it with finish("failed") would
      // fabricate an outcome the gates never issued.
      const reason = error instanceof Error ? error.message : String(error);
      log(`scheduler '${schedule.id}': run ${runId} blocked from verification: ${reason}`);
      options.recordBlockingReason?.({ runId, reason });
    }
  };

  const tick = async (now = (options.now ?? ((): Date => new Date()))()): Promise<void> => {
    let schedules: readonly ScheduleDefinition[];
    try {
      schedules = await options.schedules();
    } catch (error) {
      log(`scheduler: could not load schedules: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const minute = Math.floor(now.getTime() / 60_000);
    for (const schedule of schedules) {
      if (lastFiredMinute.get(schedule.id) === minute) continue;
      if (!cronMatches(schedule.cron, now)) continue;
      lastFiredMinute.set(schedule.id, minute);
      await fire(schedule);
    }
  };

  return {
    tick,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void tick().catch(() => undefined);
      }, 60_000);
      timer.unref();
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}