import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * W199 / durability plan §4.2: a wait that survives a restart.
 *
 * A durable timer is a row with a `wakeAt`, drained by the scheduler that
 * already exists. `hub-scheduler.ts` fires recurring schedules via
 * `nextCronMatch` (`:144-186`); a one-shot timer is the same loop with one less
 * field. This module adds NO second clock: `due(now)` is deterministic and the
 * caller passes `now`, matching the scheduler's "owns no clocks in tests"
 * discipline (`hub-scheduler.ts:11-13`).
 *
 * Ownership stays with the scheduler: `tick(now)` drains due timers after cron
 * matches. Persistence rides the same atomic temp+rename shape as
 * `saveSchedulesTable` (`hub-scheduler.ts:239-244`).
 *
 * This is the piece that answers the care requirements: a wait until 03:00, an
 * acknowledgment that arrives hours later, a retry after a reboot.
 */

export interface DurableTimer {
  /** Idempotency key for the fire action; a fired timer is never re-fired. */
  readonly id: string;
  readonly runId: string;
  /** ISO instant: the timer is due at or after this time. */
  readonly wakeAt: string;
  /** What to resume with (e.g. `{ reminderId }`). */
  readonly payload: unknown;
  /** Set on fire. Present means the timer has fired and must not fire again. */
  readonly firedAt?: string;
}

export interface DurableTimerTable {
  /** Register a timer, persisting before returning. Idempotent on `id`. */
  add(timer: DurableTimer): void;
  /** Due, unfired timers at `now`, oldest `wakeAt` first. Deterministic. */
  due(now: Date): readonly DurableTimer[];
  /** Mark fired. Idempotent: a second call for the same id is a no-op. */
  markFired(id: string, at: Date): void;
  /** Every timer, fired or not, for audit. */
  all(): readonly DurableTimer[];
}

function parseInstant(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`invalid durable timer: ${field} is not an ISO instant: '${value}'`);
  return date;
}

export function requireTimer(entry: unknown): DurableTimer {
  if (typeof entry !== "object" || entry === null) throw new TypeError("invalid durable timer: entry is not an object");
  const record = entry as Record<string, unknown>;
  for (const field of ["id", "runId", "wakeAt"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).trim().length === 0) {
      throw new TypeError(`invalid durable timer: ${field} must be a non-empty string`);
    }
  }
  parseInstant(record.wakeAt as string, "wakeAt");
  if (record.firedAt !== undefined) {
    if (typeof record.firedAt !== "string") throw new TypeError("invalid durable timer: firedAt must be a string");
    parseInstant(record.firedAt, "firedAt");
  }
  if (!("payload" in record)) throw new TypeError("invalid durable timer: payload is required");
  return entry as DurableTimer;
}

export function loadTimersTable(path: string): readonly DurableTimer[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // Only an absent table means "no timers". Permission or type errors must
    // not silently cancel every pending wait.
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`invalid timer table: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
    throw new TypeError("invalid timer table: unsupported or missing version");
  }
  const timers = (parsed as { timers?: unknown }).timers;
  if (!Array.isArray(timers)) throw new TypeError("invalid timer table: timers must be an array");
  return timers.map((entry) => requireTimer(entry));
}

export function saveTimersTable(path: string, timers: readonly DurableTimer[]): void {
  const validated = timers.map((entry) => requireTimer(entry));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, timers: validated }, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * In-memory timer table with optional persistence. The table is the owner of
 * "what is waiting"; the caller owns the clock and decides what a fired timer
 * resumes.
 */
export function createDurableTimerTable(options: { readonly path?: string; readonly timers?: readonly DurableTimer[] } = {}): DurableTimerTable {
  const timers = new Map<string, DurableTimer>();
  const persist = (): void => {
    if (options.path !== undefined) saveTimersTable(options.path, [...timers.values()]);
  };
  for (const timer of options.path === undefined ? options.timers ?? [] : loadTimersTable(options.path)) {
    const validated = requireTimer(timer);
    // A duplicate id in the source is a corrupt table: fail closed rather than
    // silently dropping one of two conflicting waits.
    if (timers.has(validated.id)) throw new TypeError(`invalid timer table: duplicate timer id '${validated.id}'`);
    timers.set(validated.id, validated);
  }

  return {
    add(timer: DurableTimer): void {
      const validated = requireTimer(timer);
      const existing = timers.get(validated.id);
      if (existing !== undefined) {
        // Idempotent add: the same id with the same wakeAt and runId is a
        // replay of the registration; a different one is a programming error.
        if (existing.wakeAt !== validated.wakeAt || existing.runId !== validated.runId) {
          throw new TypeError(`durable timer '${validated.id}' already registered with a different wakeAt/runId`);
        }
        return;
      }
      timers.set(validated.id, validated);
      persist();
    },
    due(now: Date): readonly DurableTimer[] {
      const instant = now.getTime();
      return [...timers.values()]
        .filter((timer) => timer.firedAt === undefined && parseInstant(timer.wakeAt, "wakeAt").getTime() <= instant)
        .sort((a, b) => parseInstant(a.wakeAt, "wakeAt").getTime() - parseInstant(b.wakeAt, "wakeAt").getTime());
    },
    markFired(id: string, at: Date): void {
      const timer = timers.get(id);
      if (timer === undefined) throw new TypeError(`unknown durable timer '${id}'`);
      if (timer.firedAt !== undefined) return;
      timers.set(id, { ...timer, firedAt: at.toISOString() });
      persist();
    },
    all(): readonly DurableTimer[] {
      return [...timers.values()];
    },
  };
}
