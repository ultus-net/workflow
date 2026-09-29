/**
 * W174 phase 1b — the Overview landing: the five approved zones, every
 * element a record the hub returned (projection-only; no view-side
 * derivation — the W153/W165 pins generalize). The zones:
 *
 *   1. Stat strip — live runs (the kernel snapshot's run tasks), the
 *      in-review/in-progress count (the registry keys the board payload
 *      carries), pending permissions (the poll's presence), and the
 *      RECORDED spend — an aggregation of the per-run RunUsageSummary.costUsd
 *      values the /api/runs relay carries, labelled "recorded": an
 *      aggregation of recorded values, never a live meter. A hub without the
 *      relay renders the named absence ("recorded spend arrives with the
 *      runs relay"), never a fabricated zero.
 *   2. Needs you — the parked permission prompt and the posture inbox's
 *      review-gated rows, each linked to its surface.
 *   3. Live runs — the run tasks with their recorded states.
 *   4. Next fires — the schedules registry's nextRunAt through the shared
 *      formatScheduleFire formatter.
 *   5. Recent activity — the hub timeline feed (the W152 panel's state).
 *
 * Every empty or degraded state names why or names the first action (the
 * named-absence rule); absent registries render "state unavailable", never a
 * fabricated zero.
 *
 * (Template literals are deliberately absent: string concatenation keeps
 * the source patchable under the guard shell classifier.)
 */

import { useEffect, useState } from "react";

import { ActivityTimelinePanel, type TimelineState } from "./activity-timeline.js";
import type { AppView } from "./shell.js";
import { formatScheduleFire } from "./presenters.js";
import type { OperatorDecisionRow } from "../../integrations/operator-posture.js";
import type { ScheduleRecentRun } from "../../integrations/operator-posture.js";

/** The per-run usage summary the /api/runs relay carries (the registry's
 * RunUsageSummary shape, mirrored structurally — the view derives nothing). */
export interface RunUsageSummaryView {
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly cacheReadTokens: number;
  readonly cacheCreateTokens: number;
  readonly recordedAt: string;
}

/** One run row as the kernel snapshot's task population carries it. */
export interface OverviewRunTask {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly blockers: readonly string[];
}

/** One schedule row's next-fire fields (the schedules registry poll). */
export interface OverviewSchedule {
  readonly id: string;
  readonly title: string;
  readonly nextRunAt?: string | null;
}

/** The /api/runs relay's record state — the W175 lane, mirrored. `runs`
 * null (or the fetch failing) is the named absence, never an empty list. */
export interface RunsRecordState {
  readonly runs:
    | {
        readonly rows: readonly { readonly runId: string; readonly title?: string; readonly state: string }[];
        readonly usage?: Readonly<Record<string, RunUsageSummaryView>>;
      }
    | null;
  readonly reason?: string;
}

/** Polls the W175 runs relay. Undefined until the first answer; a hub that
 * predates the relay answers runs: null with the reason. */
export function useRunsRecord(): RunsRecordState | undefined {
  const [state, setState] = useState<RunsRecordState | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/runs");
        const payload = (await response.json()) as RunsRecordState;
        if (!cancelled) setState(payload);
      } catch {
        if (!cancelled) setState({ runs: null, reason: "hub unavailable" });
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return state;
}

/** The stat strip's recorded spend: the SUM of the relay's per-run recorded
 * costs — an aggregation of recorded values, never a live meter. */
export function recordedSpend(state: RunsRecordState | undefined): { readonly total: number; readonly runs: number } | undefined {
  const usage = state?.runs?.usage;
  if (usage === undefined) return undefined;
  const entries = Object.values(usage);
  return {
    total: entries.reduce((sum, row) => sum + row.costUsd, 0),
    runs: entries.length,
  };
}

export interface OverviewViewProps {
  readonly runTasks: readonly OverviewRunTask[];
  readonly inProgressCount: number | undefined;
  readonly pendingPermission: boolean;
  readonly awaitingReview: number | null;
  readonly decisions: readonly OperatorDecisionRow[];
  /** The schedules registry's recent run rows; undefined until the poll answers. */
  readonly recentRuns?: readonly ScheduleRecentRun[] | undefined;
  /** The schedules registry's entries; undefined until the poll answers. */
  readonly schedules?: readonly OverviewSchedule[] | undefined;
  readonly timeline: TimelineState | undefined;
  readonly runsRecord: RunsRecordState | undefined;
  readonly onNavigate: (view: AppView) => void;
}

export function OverviewView({
  runTasks,
  inProgressCount,
  pendingPermission,
  awaitingReview,
  decisions,
  recentRuns,
  schedules,
  timeline,
  runsRecord,
  onNavigate,
}: OverviewViewProps) {
  const spend = recordedSpend(runsRecord);
  const nextFires = (schedules ?? []).filter((schedule) => schedule.nextRunAt != null);
  return (
    <div className="overview">
      <section className="overview-stats" aria-label="Where things stand">
        <div className="overview-stat">
          <span className="overview-stat-value">{runTasks.length}</span>
          <span className="overview-stat-label">live runs</span>
        </div>
        <div className="overview-stat">
          <span className="overview-stat-value">{inProgressCount === undefined ? "—" : inProgressCount}</span>
          <span className="overview-stat-label">in review / in progress{inProgressCount === undefined ? " (state unavailable)" : ""}</span>
        </div>
        <div className="overview-stat">
          <span className="overview-stat-value">{pendingPermission ? 1 : 0}</span>
          <span className="overview-stat-label">pending permissions</span>
        </div>
        <div className="overview-stat">
          <span className="overview-stat-value">{awaitingReview === null ? "—" : awaitingReview}</span>
          <span className="overview-stat-label">awaiting review{awaitingReview === null ? " (state unavailable)" : ""}</span>
        </div>
        <div className="overview-stat">
          {spend === undefined ? (
            <span className="overview-stat-absent">recorded spend arrives with the runs relay</span>
          ) : (
            <span className="overview-stat-value">${spend.total.toFixed(4)}</span>
          )}
          <span className="overview-stat-label">{spend === undefined ? "recorded spend" : "recorded spend across " + spend.runs + " run(s)"}</span>
        </div>
      </section>

      <section className="overview-needs-you" aria-label="What needs you">
        <h3>Needs you</h3>
        <ul className="overview-needs-list">
          {pendingPermission && (
            <li>
              <button type="button" className="overview-link" onClick={() => onNavigate("chat")}>
                a parked permission prompt waits in chat
              </button>
            </li>
          )}
          {decisions.map((row, index) => (
            <li key={row.kind + ":" + String(index)}>
              <span className="overview-decision-summary">{row.summary}</span>
              <button type="button" className="overview-link" onClick={() => onNavigate(decisionTarget(row))}>
                {row.action.label}
              </button>
            </li>
          ))}
          {!pendingPermission && decisions.length === 0 && (
            <li className="overview-empty">nothing is waiting on you — runs proceed on their recorded gates</li>
          )}
        </ul>
      </section>

      <section className="overview-live-runs" aria-label="Live runs">
        <h3>Live runs</h3>
        {runTasks.length === 0 ? (
          <p className="overview-empty">no runs recorded yet — delegate a board task or fire a schedule</p>
        ) : (
          <ul className="overview-run-list">
            {runTasks.map((task) => (
              <li key={task.id} className="overview-run-row">
                <span className={"status-dot status-" + task.state.toLowerCase()} aria-hidden="true" />
                <span className="overview-run-id">{task.id}</span>
                <span className="overview-run-title">{task.title}</span>
                <span className="overview-run-state">{task.state}</span>
              </li>
            ))}
          </ul>
        )}
        {recentRuns === undefined || recentRuns.length === 0 ? null : (
          <p className="overview-recent-note">
            {recentRuns.length} recent schedule run(s) recorded — the runs page (next phase) lists every registry run
          </p>
        )}
      </section>

      <section className="overview-next-fires" aria-label="Next fires">
        <h3>Next fires</h3>
        {schedules === undefined ? (
          <p className="overview-empty">state unavailable — the schedules registry has not answered</p>
        ) : nextFires.length === 0 ? (
          <p className="overview-empty">no schedules armed — arm one from the Schedules page</p>
        ) : (
          <ul className="overview-fire-list">
            {nextFires.map((schedule) => (
              <li key={schedule.id}>
                <span className="overview-run-title">{schedule.title}</span>
                <span className="overview-fire-time">next {formatScheduleFire(schedule.nextRunAt as string)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="overview-recent-activity" aria-label="Recent activity">
        <h3>Recent activity</h3>
        <ActivityTimelinePanel state={timeline} />
      </section>
    </div>
  );
}

/** A posture decision's action target mapped into the shell's views — the
 * same mapping the posture strip uses (today the schedules inbox is the
 * decision rows' only in-shell home; a future target extends this map,
 * never a per-row guess). */
const DECISION_TARGETS: Readonly<Record<string, AppView>> = { "#schedules": "schedules" };
function decisionTarget(row: OperatorDecisionRow): AppView {
  return DECISION_TARGETS[row.action.target] ?? "schedules";
}