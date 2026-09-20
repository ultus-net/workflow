import {
  loadSchedulesTable,
  saveSchedulesTable,
  type ScheduleDefinition,
} from "./hub-scheduler.js";

/**
 * W074: the operator-owned scheduled-task registry. It is the single live
 * authority over the persisted schedule table (`~/.workflow/scheduler.json` by
 * default): the running scheduler reads `list()` on every tick, so UI/API edits
 * take effect without a hub restart, and every write is validated and persisted
 * before it is admitted in memory (a failed write leaves the in-memory table
 * untouched — fail closed).
 *
 * `runNow` is attached after the scheduler exists (the scheduler reads this
 * registry, so the dependency is one-directional); operators trigger a schedule
 * through it. The trigger boundary is the hub route's verifier credential
 * (P1-1, adversarial review), not this module — see THREAT_MODEL 2026-09-19 §1.
 */

export interface ScheduleRegistry {
  list(): readonly ScheduleDefinition[];
  get(id: string): ScheduleDefinition | undefined;
  /** Create or replace a schedule by id. Persists before admitting. */
  save(definition: ScheduleDefinition): readonly ScheduleDefinition[];
  remove(id: string): readonly ScheduleDefinition[];
  /** Fire a schedule immediately (operator run-now). False when unknown or no runner is attached. */
  runNow(id: string): Promise<boolean>;
  /** Attach the scheduler's trigger seam once the scheduler is constructed. */
  attachRunner(runNow: (id: string) => Promise<boolean>): void;
}

export function createScheduleRegistry(options: {
  readonly path: string;
  readonly runNow?: (id: string) => Promise<boolean>;
}): ScheduleRegistry {
  let schedules: ScheduleDefinition[] = [...loadSchedulesTable(options.path)];
  let runner = options.runNow;

  const persist = (next: readonly ScheduleDefinition[]): void => {
    // saveSchedulesTable validates every entry and writes atomically; on any
    // failure it throws before the in-memory table changes.
    saveSchedulesTable(options.path, next);
    schedules = [...next];
  };

  return {
    list(): readonly ScheduleDefinition[] {
      return [...schedules];
    },
    get(id: string): ScheduleDefinition | undefined {
      return schedules.find((entry) => entry.id === id);
    },
    save(definition: ScheduleDefinition): readonly ScheduleDefinition[] {
      const existing = schedules.findIndex((entry) => entry.id === definition.id);
      const next = existing === -1
        ? [...schedules, definition]
        : schedules.map((entry, index) => (index === existing ? definition : entry));
      persist(next);
      return [...schedules];
    },
    remove(id: string): readonly ScheduleDefinition[] {
      persist(schedules.filter((entry) => entry.id !== id));
      return [...schedules];
    },
    async runNow(id: string): Promise<boolean> {
      if (runner === undefined) return false;
      return runner(id);
    },
    attachRunner(runNow: (id: string) => Promise<boolean>): void {
      runner = runNow;
    },
  };
}
