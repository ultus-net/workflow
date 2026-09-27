import { useEffect, useState } from "react";

import type { ActivityTimeline } from "../../integrations/activity-timeline.js";

/**
 * W152 — the unified activity timeline (the Paperclip borrow wave 3): one
 * feed over the hub's kernel transition log and its registry records (review
 * verdicts, blocking reasons, completion claims, per-run usage, schedule
 * origins, budget incidents).
 *
 * Projection-only: every row comes from the hub's /snapshot timeline block,
 * computed by the shared projection over registry state. Kernel transition
 * rows render the explicit "unattributed" actor/authority — the kernel does
 * not record attribution (W157 is the record change), and this panel never
 * guesses it. Rows whose record carries no time render "no recorded time";
 * the view never fabricates a timestamp to force chronology.
 *
 * Fail-closed: no hub, or a hub predating W152 (timeline null), renders the
 * degraded state — the local kernel history panel below it is untouched, so
 * nothing is fabricated. The retention line copies the projection's
 * statement verbatim (criterion 3): the hub's feed is in-memory and resets
 * on restart.
 */

export interface TimelineState {
  readonly timeline: ActivityTimeline | null;
  readonly reason?: string;
}

export function useActivityTimeline(): TimelineState | undefined {
  const [state, setState] = useState<TimelineState | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/timeline");
        const payload = (await response.json()) as TimelineState;
        if (!cancelled) setState(payload);
      } catch {
        if (!cancelled) setState({ timeline: null, reason: "hub unavailable" });
      }
    };
    void load();
    const poll = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);
  return state;
}

const KIND_LABELS: Record<string, string> = {
  transition: "kernel",
  review: "review",
  gate: "gate",
  claim: "claim",
  usage: "usage",
  origin: "schedule",
  budget: "budget",
};

export function ActivityTimelinePanel({ state }: {
  readonly state: TimelineState | undefined;
}) {
  if (state === undefined || state.timeline === null) {
    return (
      <div className="activity-timeline activity-timeline-degraded" role="status">
        <span className="activity-timeline-degraded-note">
          {state?.reason === undefined ? "hub timeline: loading…" : `hub timeline unavailable (${state.reason})`}
        </span>
      </div>
    );
  }
  const timeline = state.timeline;
  const degraded = new Set(timeline.degraded);
  return (
    <div className="activity-timeline" role="feed" aria-label="Activity timeline">
      {timeline.rows.length === 0 ? (
        <p className="muted activity-timeline-empty">no recorded activity yet</p>
      ) : (
        <ul className="activity-timeline-rows">
          {timeline.rows.map((row, index) => (
            <li key={`${row.kind}:${index}`} className={`activity-row activity-row-${row.kind}`}>
              <span className={`activity-kind activity-kind-${row.kind}`}>{KIND_LABELS[row.kind] ?? row.kind}</span>
              <span className="activity-row-body">
                <span className="activity-row-summary">{row.summary}</span>
                <span className="activity-row-attribution">
                  {row.actor} · {row.authority}
                  {" · "}
                  {row.at === null ? "no recorded time" : new Date(row.at).toLocaleString()}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {degraded.size > 0 && (
        <div className="activity-timeline-degraded-note">state unavailable: {[...degraded].join(", ")}</div>
      )}
      <p className="muted activity-timeline-retention">{timeline.retention}</p>
    </div>
  );
}
