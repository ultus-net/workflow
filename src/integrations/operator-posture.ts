/**
 * W150 (the Paperclip borrow wave 1): the operator posture strip and unified
 * decision inbox's PROJECTION function. Pure: it reads hub/registry-owned
 * state and produces counts plus the merged decision list; it mutates
 * nothing, owns no canonical state, and synthesizes no attribution.
 *
 * ID CONTRACT (the round-1 review's P1 — kernel ids never reach this
 * function): the caller (the hub's /snapshot handler) filters the kernel
 * snapshot to run tasks (`run:<rawRunId>` / `run:schedule:<scheduleId>:<uuid>`)
 * and strips the `run:` prefix, so this function sees RAW run ids — the same
 * id space the run registry's gate-observability maps are keyed by
 * (reviewOutcomes, blockingReasons at run-registry.ts). Everything joins on
 * raw run ids; nothing else.
 *
 * Data sources (the spec's "data projected" list):
 * - run-gate state: raw-id run tasks plus the registry's recorded review
 *   outcomes and blocking reasons.
 * - budget incidents: per-session W045 budget-guard state (mechanism, tier).
 * - orphaned runs: recover-or-discard candidates (durable-state attestation).
 * - schedules: the schedule registry's definitions (titles only — counts do
 *   not depend on it).
 *
 * Fail-closed degraded state: when a registry's input is ABSENT the count it
 * feeds is `null` — the strip renders an honest "—" (state unavailable), NOT
 * a fabricated zero — and the projection emits no decision rows for data it
 * was never given. `failedSchedules` is the exception: it needs only the
 * run tasks (the kernel graph), so it is always a number; a missing schedule
 * registry degrades decision-row TITLES (the registry id is shown instead),
 * never the count.
 *
 * The scheduled-run origin is registry-structural: the scheduler fires runs
 * with ids `schedule:<scheduleId>:<uuid>` (hub-scheduler.ts), so lineage and
 * failed-schedule grouping are computed from the raw run ids alone — never
 * from timestamps or UI-side heuristics. The REVIEWER's runs
 * (`schedule:hub-reviewer-<uuid>`, two segments) share the prefix but are
 * not schedule origins and are excluded by the three-segment shape.
 */

export type OperatorDecisionKind = "review" | "budget" | "orphan" | "schedule";

export interface PostureRunTask {
  /** The RAW run id (no `run:` kernel prefix): `author-1`, a uuid, or the schedule-origin `schedule:<id>:<uuid>`. */
  readonly runId: string;
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
  /** Raw-id run tasks. Required — no graph, no posture. */
  readonly runTasks: readonly PostureRunTask[];
  readonly reviewOutcomes?: ReadonlyMap<string, { readonly verdict: string; readonly summary: string }>;
  readonly blockingReasons?: ReadonlyMap<string, string>;
  readonly budgetIncidents?: readonly PostureBudgetIncident[];
  readonly orphans?: readonly PostureOrphan[];
  readonly schedules?: readonly { readonly id: string; readonly title: string }[];
}

export interface OperatorDecisionRow {
  readonly kind: OperatorDecisionKind;
  /** Attribution from the record kind — the gate maps carry multiple record families, so each row says where it came from. */
  readonly actor: "agent" | "system" | "budget guard" | "scheduler";
  /** The authority basis the row stands on — never invented. */
  readonly authority: string;
  readonly summary: string;
  /** A link INTO an existing panel; the inbox renders links, never new write routes. */
  readonly action: { readonly label: string; readonly target: string };
}

export interface OperatorPosture {
  readonly counts: {
    /** Null means the feeding registry was ABSENT — render "state unavailable", never a fabricated zero. */
    readonly awaitingReview: number | null;
    readonly budgetIncidents: number | null;
    readonly orphanedRuns: number | null;
    /** Always a number: derivable from the kernel graph's run tasks alone. */
    readonly failedSchedules: number;
  };
  /** Absent registries named so the strip can explain the "—" marks and the degraded rows. */
  readonly degraded: readonly string[];
  readonly decisions: readonly OperatorDecisionRow[];
}

/** The scheduler-origin run id shape: three segments, `schedule:<id>:<uuid>`. */
const SCHEDULE_ORIGIN = /^schedule:[^:]+:[^:]+$/;

export function operatorPosture(input: OperatorPostureInput): OperatorPosture {
  const degraded: string[] = [];
  if (input.reviewOutcomes === undefined || input.blockingReasons === undefined) degraded.push("run-gate observability");
  if (input.budgetIncidents === undefined) degraded.push("per-session budget state");
  if (input.orphans === undefined) degraded.push("orphaned-run detection");
  if (input.schedules === undefined) degraded.push("schedule registry");

  // Awaiting review: a run parked in VERIFYING (its work finished into the
  // gate) with no recorded review verdict — joined on RAW run ids. Runs that
  // already carry an outcome, or that never reached the gate, are not
  // awaiting anything.
  const awaitingReview = input.reviewOutcomes === undefined || input.blockingReasons === undefined
    ? null
    : input.runTasks.filter(
        (task) => task.state === "VERIFYING" && !input.reviewOutcomes!.has(task.runId),
      ).length;

  // Failed schedules: FAILED runs fired BY a schedule, grouped by the
  // originating schedule id parsed from the RAW run id — one count per
  // schedule, however many of its runs failed.
  const failedScheduleIds = new Set<string>();
  for (const task of input.runTasks) {
    if (task.state !== "FAILED" || !SCHEDULE_ORIGIN.test(task.runId)) continue;
    const scheduleId = task.runId.split(":")[1] ?? "";
    if (scheduleId !== "") failedScheduleIds.add(scheduleId);
  }

  const decisions: OperatorDecisionRow[] = [];
  if (awaitingReview !== null) {
    for (const task of input.runTasks) {
      if (task.state !== "VERIFYING" || input.reviewOutcomes!.has(task.runId)) continue;
      decisions.push({
        kind: "review",
        actor: "agent",
        authority: "run review gate (requiresReview)",
        summary: `${task.title} finished into the review gate — awaiting a verdict`,
        action: { label: "Open run", target: `#run:${task.runId}` },
      });
    }
  }
  for (const [runId, reason] of input.blockingReasons ?? []) {
    const task = input.runTasks.find((candidate) => candidate.runId === runId);
    decisions.push({
      kind: "review",
      // The blocking-reason map carries EVERY gate family's failures
      // (reviewer verdicts, scheduler failures, test-runner rejections) — the
      // row says so instead of claiming a reviewer said it.
      actor: "system",
      authority: "recorded blocking reason (run registry)",
      summary: `${task?.title ?? runId} blocked: ${reason}`,
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
      awaitingReview,
      budgetIncidents: input.budgetIncidents === undefined ? null : input.budgetIncidents.length,
      orphanedRuns: input.orphans === undefined ? null : input.orphans.length,
      failedSchedules: failedScheduleIds.size,
    },
    degraded,
    decisions,
  };
}

/**
 * W153 (borrow wave 4's registry slice): per-schedule lineage computed from
 * the registries alone. Caused runs join on the RAW run id's schedule-origin
 * prefix (never on timestamps); the last outcome is the LAST matching run
 * task in the snapshot's insertion order (the graph's own append order); a
 * deleted schedule's runs stay attributed to a tombstoned origin rather than
 * dangling. Reviewer runs are excluded by the three-segment shape.
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
    if (!SCHEDULE_ORIGIN.test(task.runId)) continue;
    const scheduleId = task.runId.split(":")[1] ?? "";
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