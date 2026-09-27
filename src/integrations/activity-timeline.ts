/**
 * W152 (the Paperclip borrow wave 3): the unified activity timeline's
 * PROJECTION function. Pure: it reads hub/kernel-owned records and produces
 * one feed; it mutates nothing, owns no canonical state, and synthesizes no
 * attribution.
 *
 * ATTRIBUTION CONTRACT (the spec's kernel-boundary rule, verified
 * 2026-09-27): the kernel's `TransitionRecord` carries only
 * `{taskId, from, to}` (src/kernel/contracts.ts:72-76) — no actor, no
 * authority, no time. Kernel-transition rows therefore render the EXPLICIT
 * "unattributed" state (actor and authority both "unattributed", `at` null)
 * rather than a guess; the record change that would let them name more is
 * W157 (docs/ledger/W157-*.md), not this slice. Every other row's actor and
 * authority come from its RECORD KIND — the same rule the W150 posture
 * projection established (the row says where the attribution came from; the
 * gate maps carry multiple families, so the kind is named). `at` is the
 * record's own time when it carries one (completion claims, run usage) and
 * null where the record is timeless (kernel transitions, review verdicts,
 * blocking reasons, run origins, budget incidents) — the view renders
 * timeless rows in the feed's order, never a fabricated time.
 *
 * ID CONTRACT (the W150 precedent): the kernel snapshot's `run:` prefix is
 * stripped at the caller's boundary, so registry joins (review outcomes,
 * blocking reasons, claims, usage, origins) see RAW run ids; kernel
 * transition rows keep their full kernel ids for the task-title join (the
 * tasks list carries kernel ids). A reviewer run's raw id family
 * (`schedule:hub-reviewer-<uuid>`) is named in the row, not re-derived here.
 *
 * Degraded state: when a registry's input is ABSENT the projection emits no
 * rows for it and names the absence — never a fabricated feed.
 *
 * Retention: the hub composes its applications in-memory (no
 * JsonWorkflowStore is wired in src/cli/hub.ts), so the transition log and
 * the registry's bounded (64-entry) gate journals reset when the hub process
 * restarts. The returned `retention` statement says exactly that and the
 * panel must copy it verbatim.
 */

export interface TimelineInput {
  /**
   * The kernel's transition log, IN KERNEL ORDER (the graph's mutation
   * order). W157: a record MAY carry its caller-supplied attribution — the
   * row consumes it verbatim; a record without one renders the explicit
   * unattributed state (absence stays legal).
   */
  readonly transitions: readonly { readonly taskId: string; readonly from: string; readonly to: string; readonly attribution?: { readonly actor: string; readonly authority: string; readonly observedAt: string } }[];
  /** Task titles for the kernel-id join; a missing task renders its id (registry truth, not a fabricated title). */
  readonly tasks: readonly { readonly id: string; readonly title: string }[];
  readonly reviewOutcomes?: ReadonlyMap<string, { readonly reviewerRunId: string; readonly verdict: string; readonly recorded: boolean; readonly summary: string; readonly parseFailure?: string }>;
  readonly blockingReasons?: ReadonlyMap<string, string>;
  readonly completionClaims?: ReadonlyMap<string, { readonly runId: string; readonly claim: string; readonly verifiedAtClaim: boolean; readonly observedAt: string }>;
  readonly runUsage?: ReadonlyMap<string, { readonly recordedAt: string; readonly totalTokens: number; readonly costUsd: number; readonly cacheReadTokens?: number; readonly cacheCreateTokens?: number }>;
  readonly runOrigins?: ReadonlyMap<string, { readonly kind: "schedule"; readonly scheduleId: string }>;
  readonly schedules?: readonly { readonly id: string; readonly title: string }[];
  readonly budgetIncidents?: readonly { readonly sessionId: string; readonly title?: string; readonly tier: string; readonly mechanism?: string; readonly reason?: string }[];
}

export interface TimelineRow {
  readonly kind: "transition" | "review" | "gate" | "claim" | "usage" | "origin" | "budget";
  /** The actor from the record kind — the literal "unattributed" when the record carries none. */
  readonly actor: string;
  /** The authority basis from the record kind — the literal "unattributed" when the record carries none. */
  readonly authority: string;
  readonly summary: string;
  /** The record's own time; null when the record is timeless (the view never fabricates one). */
  readonly at: string | null;
}

export interface ActivityTimeline {
  readonly rows: readonly TimelineRow[];
  /** The named absences (absent registries produce no rows and are named). */
  readonly degraded: readonly string[];
  /** The retention statement — the panel copies it verbatim (criterion 3). */
  readonly retention: string;
}

const UNATTRIBUTED = "unattributed";
export const TIMELINE_RETENTION = "in-memory only: the hub's transition log and the run registry's bounded (64-entry) gate journals reset when the hub process restarts; this feed never claims a permanent record";

export function activityTimeline(input: TimelineInput): ActivityTimeline {
  const degraded: string[] = [];
  if (input.reviewOutcomes === undefined || input.blockingReasons === undefined) degraded.push("run-gate observability");
  if (input.completionClaims === undefined) degraded.push("completion-claims journal");
  if (input.runUsage === undefined) degraded.push("per-run usage records");
  if (input.runOrigins === undefined) degraded.push("run origin records");
  if (input.budgetIncidents === undefined) degraded.push("per-session budget state");

  const titleFor = (taskId: string): string => input.tasks.find((task) => task.id === taskId)?.title ?? taskId;

  const rows: TimelineRow[] = [];

  // Kernel transitions, in the log's own order. W157: a record's caller-
  // supplied attribution is consumed verbatim (the run lane, the operator
  // commands, and the invalidation demotions stamp what they know); a record
  // without one renders the explicit unattributed state instead of a guess.
  for (const transition of input.transitions) {
    const attribution = transition.attribution;
    rows.push({
      kind: "transition",
      actor: attribution?.actor ?? UNATTRIBUTED,
      authority: attribution?.authority ?? UNATTRIBUTED,
      summary: `${titleFor(transition.taskId)}: ${transition.from} → ${transition.to}`,
      at: attribution?.observedAt ?? null,
    });
  }

  // Review verdicts: the record is the reviewer's verdict, so the actor is
  // the reviewer family and the authority is the gate's record — named, not
  // inferred from anything outside the record.
  for (const [runId, outcome] of input.reviewOutcomes ?? []) {
    rows.push({
      kind: "review",
      actor: "agent (reviewer)",
      authority: outcome.recorded ? "review-gate verdict record (admitted)" : "review-gate verdict record (not admitted)",
      summary: `run ${runId}: review ${outcome.verdict} — ${outcome.summary}${outcome.parseFailure === undefined ? "" : ` (parse failure: ${outcome.parseFailure})`}`,
      at: null,
    });
  }

  // Blocking reasons: the gate's failure records — the actor is the system
  // gate, whatever family recorded it (the W150 rule: the kind is the GATE's).
  for (const [runId, reason] of input.blockingReasons ?? []) {
    rows.push({
      kind: "gate",
      actor: "system",
      authority: "recorded blocking reason (run registry)",
      summary: `run ${runId} blocked: ${reason}`,
      at: null,
    });
  }

  // Completion-claims journal: advisory observations with their own time.
  for (const [runId, claim] of input.completionClaims ?? []) {
    rows.push({
      kind: "claim",
      actor: "agent",
      authority: `completion-claims journal (verified at claim: ${claim.verifiedAtClaim ? "yes" : "no"})`,
      summary: `run ${runId} claimed completion: ${claim.claim}`,
      at: claim.observedAt,
    });
  }

  // Per-run usage: the metering proxy's recorded totals, with their time.
  // P12: the cache components render only when the record carries nonzero
  // mass (a measured zero on the OpenAI lane is noise, not an absence).
  for (const [runId, usage] of input.runUsage ?? []) {
    const cacheSegment = (usage.cacheReadTokens ?? 0) > 0 || (usage.cacheCreateTokens ?? 0) > 0
      ? ` (cache: ${usage.cacheReadTokens ?? 0} read, ${usage.cacheCreateTokens ?? 0} created)`
      : "";
    rows.push({
      kind: "usage",
      actor: "system",
      authority: "metering-proxy usage record",
      summary: `run ${runId} usage: ${usage.totalTokens} tokens, $${usage.costUsd.toFixed(4)}${cacheSegment}`,
      at: usage.recordedAt,
    });
  }

  // Run origins: the scheduler's begin-time attribution (W153's RunOrigin
  // record) — the row names the schedule and the run it caused.
  for (const [runId, origin] of input.runOrigins ?? []) {
    const scheduleTitle = input.schedules?.find((schedule) => schedule.id === origin.scheduleId)?.title ?? origin.scheduleId;
    rows.push({
      kind: "origin",
      actor: "scheduler",
      authority: `run origin record (${origin.kind}: ${origin.scheduleId})`,
      summary: `schedule ${scheduleTitle} fired run ${runId}`,
      at: null,
    });
  }

  // Budget incidents: the W045 guard's per-session crossings, with the
  // posture projection's authority attribution.
  for (const incident of input.budgetIncidents ?? []) {
    rows.push({
      kind: "budget",
      actor: "budget guard",
      authority: `session budget (W045${incident.mechanism === undefined ? "" : `: ${incident.mechanism}`})`,
      summary: `session ${incident.title ?? incident.sessionId} crossed the ${incident.tier} tier${incident.reason === undefined ? "" : `: ${incident.reason}`}`,
      at: null,
    });
  }

  return { rows, degraded, retention: TIMELINE_RETENTION };
}
