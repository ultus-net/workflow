/**
 * W150 (the Paperclip borrow wave 1): the operator posture strip and unified
 * decision inbox's PROJECTION function. Pure: it reads hub/registry-owned
 * state and produces counts plus the merged decision list; it mutates
 * nothing, owns no canonical state, and synthesizes no attribution — every
 * row's actor and authority come from the record kind it was built from.
 *
 * Data sources (the spec's "data projected" list):
 * - run-gate state: the kernel snapshot's run tasks (ids `run:<id>` and
 *   `schedule:<scheduleId>:<uuid>`) plus the run registry's gate
 *   observability (recorded review outcomes, blocking reasons).
 * - budget incidents: per-session W045 budget-guard state (mechanism, tier).
 * - orphaned runs: recover-or-discard candidates (durable-state attestation).
 * - schedules: the schedule registry's definitions.
 *
 * Fail-closed degraded state: when a registry's input is ABSENT the
 * projection does NOT fabricate a zero — it names the absent registry in
 * `degraded` so the strip can render an honest "state unavailable" mark, and
 * emits no decision rows for data it was never given.
 *
 * The scheduled-run origin is registry-structural: the scheduler fires runs
 * with ids `schedule:<scheduleId>:<uuid>` (hub-scheduler.ts), so lineage and
 * failed-schedule grouping are computed from the registry ids alone — never
 * from timestamps or UI-side heuristics.
 */

export type OperatorDecisionKind = "review" | "budget" | "orphan" | "schedule";

export interface PostureRunTask {
  /** The kernel task id — `run:<id>` or the schedule-origin `schedule:<scheduleId>:<uuid>`. */
  readonly id: string;
  readonly title: string;
  /** The kernel state (IN_PROGRESS / VERIFYING / VERIFIED / FAILED / BLOCKED). */
  readonly state: string;
}

export interface PostureBudgetIncident {
  readonly sessionId: string;
  readonly title?: string;
  /** The tier that was crossed (W045 warn tier, or the sticky abort-tier violation). */
  readonly tier: "warn" | "abort";
  readonly mechanism?: string;
  readonly reason?: string;
}

export interface PostureOrphan {
  readonly runId: string;
  readonly reason: string;
}

export interface OperatorPostureInput {
  /** Kernel snapshot run tasks (run:* and schedule:* ids). Required — no graph, no posture. */
  readonly runTasks: readonly PostureRunTask[];
  readonly reviewOutcomes?: ReadonlyMap<string, { readonly verdict: string; readonly summary: string }>;
  readonly blockingReasons?: ReadonlyMap<string, string>;
  readonly budgetIncidents?: readonly PostureBudgetIncident[];
  readonly orphans?: readonly PostureOrphan[];
  readonly schedules?: readonly { readonly id: string; readonly title: string }[];
}

export interface OperatorDecisionRow {
  readonly kind: OperatorDecisionKind;
  /** Attribution from the record: which surface produced this row. */
  readonly actor: "agent" | "reviewer" | "budget guard" | "system" | "scheduler";
  /** The authority basis the row stands on — never invented. */
  readonly authority: string;
  readonly summary: string;
  /** A link INTO an existing panel; the inbox renders links, never new write routes. */
  readonly action: { readonly label: string; readonly target: string };
}

export interface OperatorPosture {
  readonly counts: {
    readonly awaitingReview: number;
    readonly budgetIncidents: number;
    readonly orphanedRuns: number;
    readonly failedSchedules: number;
  };
  /** Absent registries named so the strip can render "state unavailable" instead of a fabricated zero. */
  readonly degraded: readonly string[];
  readonly decisions: readonly OperatorDecisionRow[];
}

const isGateRunId = (id: string): boolean => id.startsWith("run:") || id.startsWith("schedule:");

export function operatorPosture(input: OperatorPostureInput): OperatorPosture {
  const degraded: string[] = [];
  if (input.reviewOutcomes === undefined || input.blockingReasons === undefined) degraded.push("run-gate observability");
  if (input.budgetIncidents === undefined) degraded.push("per-session budget state");
  if (input.orphans === undefined) degraded.push("orphaned-run detection");
  if (input.schedules === undefined) degraded.push("schedule registry");

  const gateRunTasks = input.runTasks.filter((task) => isGateRunId(task.id));

  // Awaiting review: a run parked in VERIFYING (its work finished into the
  // gate) with no recorded review verdict. A run that already carries an
  // outcome, or that never reached the gate, is not awaiting anything.
  const awaitingReview = gateRunTasks.filter(
    (task) => task.state === "VERIFYING" && !(input.reviewOutcomes?.has(task.id) ?? false),
  );

  // Failed schedules: FAILED runs fired BY a schedule, grouped by the
  // originating schedule id parsed from the registry id — one count per
  // schedule, however many of its runs failed. The SCHEDULE-origin id shape
  // is three segments (`schedule:<id>:<uuid>`, hub-scheduler.ts); reviewer
  // runs (`schedule:hub-reviewer-<uuid>`, one colon) are NOT schedule origins
  // and must never group into this count.
  const failedScheduleIds = new Set<string>();
  for (const task of gateRunTasks) {
    if (task.state !== "FAILED" || !/^schedule:[^:]+:[^:]+$/.test(task.id)) continue;
    const scheduleId = task.id.split(":")[1] ?? "";
    if (scheduleId !== "") failedScheduleIds.add(scheduleId);
  }

  const decisions: OperatorDecisionRow[] = [];
  for (const task of awaitingReview) {
    decisions.push({
      kind: "review",
      actor: "agent",
      authority: "run review gate (requiresReview)",
      summary: `${task.title} finished into the review gate — awaiting a verdict`,
      action: { label: "Open run", target: `#run:${task.id}` },
    });
  }
  for (const [runId, reason] of input.blockingReasons ?? []) {
    if (!isGateRunId(runId)) continue;
    const task = gateRunTasks.find((candidate) => candidate.id === runId);
    decisions.push({
      kind: "review",
      actor: "reviewer",
      authority: "recorded review decision",
      summary: `${task?.title ?? runId} blocked by the review gate: ${reason}`,
      action: { label: "Inspect", target: `#run:${runId}` },
    });
  }
  for (const incident of input.budgetIncidents ?? []) {
    decisions.push({
      kind: "budget",
      actor: "budget guard",
      authority: `session budget (W045${incident.mechanism === undefined ? "" : `: ${incident.mechanism}`})`,
      summary: `session ${incident.title ?? incident.sessionId} crossed the ${incident.tier} tier${incident.reason === undefined ? "" : `: ${incident.reason}`}`,
      action: { label: "Open session", target: `#session:${incident.sessionId}` },
    });
  }
  for (const orphan of input.orphans ?? []) {
    decisions.push({
      kind: "orphan",
      actor: "system",
      authority: "orphaned-run detection (recover-or-discard, fail-closed)",
      summary: `orphaned run ${orphan.runId}: ${orphan.reason}`,
      action: { label: "Recover or discard", target: `#run:${orphan.runId}` },
    });
  }
  for (const scheduleId of failedScheduleIds) {
    const scheduleTitle = input.schedules?.find((schedule) => schedule.id === scheduleId)?.title ?? scheduleId;
    decisions.push({
      kind: "schedule",
      actor: "scheduler",
      authority: "schedule registry last outcome",
      summary: `schedule ${scheduleTitle}'s latest fired run failed`,
      action: { label: "Open schedules", target: "#schedules" },
    });
  }

  return {
    counts: {
      awaitingReview: awaitingReview.length,
      budgetIncidents: (input.budgetIncidents ?? []).length,
      orphanedRuns: (input.orphans ?? []).length,
      failedSchedules: failedScheduleIds.size,
    },
    degraded,
    decisions,
  };
}

/**
 * W153 (borrow wave 4's registry slice): per-schedule lineage computed from
 * the registries alone. Caused runs join on the registry id prefix (never on
 * timestamps); the last outcome is the LAST matching run task in the
 * snapshot's insertion order (the graph's own append order); a deleted
 * schedule's runs stay attributed to a tombstoned origin rather than
 * dangling.
 */
export interface ScheduleLineage {
  readonly scheduleId: string;
  readonly title: string;
  readonly causedRuns: number;
  readonly lastOutcome: "verified" | "failed" | "in-progress" | "unrun";
  /** True when the run exists in the registry but the schedule no longer does (deleted schedule). */
  readonly tombstoned: boolean;
}

export function scheduleLineage(input: {
  readonly schedules: readonly { readonly id: string; readonly title: string }[];
  readonly runTasks: readonly PostureRunTask[];
}): ScheduleLineage[] {
  const runsByOrigin = new Map<string, PostureRunTask[]>();
  for (const task of input.runTasks) {
    // Three-segment schedule-origin ids only (schedule:<id>:<uuid>);
    // reviewer runs (schedule:hub-reviewer-<uuid>) are not schedule origins.
    if (!/^schedule:[^:]+:[^:]+$/.test(task.id)) continue;
    const scheduleId = task.id.split(":")[1] ?? "";
    if (scheduleId === "") continue;
    const runs = runsByOrigin.get(scheduleId) ?? [];
    runs.push(task);
    runsByOrigin.set(scheduleId, runs);
  }
  const ids = new Set<string>([...input.schedules.map((schedule) => schedule.id), ...runsByOrigin.keys()]);
  return [...ids].map((scheduleId) => {
    const runs = runsByOrigin.get(scheduleId) ?? [];
    const last = runs[runs.length - 1];
    const known = input.schedules.find((schedule) => schedule.id === scheduleId);
    const lastOutcome: ScheduleLineage["lastOutcome"] =
      last === undefined ? "unrun" : last.state === "VERIFIED" ? "verified" : last.state === "FAILED" ? "failed" : "in-progress";
    return {
      scheduleId,
      title: known?.title ?? scheduleId,
      causedRuns: runs.length,
      lastOutcome,
      tombstoned: known === undefined,
    };
  });
}