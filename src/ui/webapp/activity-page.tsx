/**
 * W176 phase 3 (issue #347) — the Activity page: the W152 unified timeline
 * promoted from the chat panel to a full page with kind filters. The chat
 * panel stays (the page adds filtering and scannability).
 *
 * Projection-only discipline (the W152 pins generalize): the page renders
 * ONLY the rows the hub's /api/timeline relay returned — the kind filter is
 * a view-side slice of that record list, never a derivation of new facts,
 * and no row is reordered or rewritten by the slice.
 *
 * The retention line copies the projection's statement verbatim
 * (TIMELINE_RETENTION, imported — never retyped here, and the relayed copy
 * is not trusted: the page renders the exported constant itself).
 *
 * Every empty or degraded state names why (the panel's degraded copy
 * pattern): loading, hub unavailable (reason), the relay's named absences,
 * and an empty filtered result names the filter honestly ("no <kind> rows
 * recorded") instead of the feed's generic empty copy.
 *
 * Each consumer owns its poll: ActivityPage runs its own useActivityTimeline
 * instance — the chat panel's and the Overview's polls are untouched.
 *
 * (Template literals are deliberately absent: string concatenation keeps
 * the source patchable under the guard shell classifier.)
 */

import { useState } from "react";

import { TIMELINE_RETENTION } from "../../integrations/activity-timeline.js";
import { KIND_LABELS, TimelineRowItem, useActivityTimeline, type TimelineState } from "./activity-timeline.js";

/** One filter option: the row kind's raw relay value with its display
 * label (the panel's own KIND_LABELS mapping). */
export interface ActivityKindFilter {
  readonly kind: string;
  readonly label: string;
}

/** The filter's options, derived from the panel's own kind labels — the
 * page never invents a kind the projection does not emit. */
export function activityKindFilters(): readonly ActivityKindFilter[] {
  return Object.keys(KIND_LABELS).map((kind) => ({ kind, label: KIND_LABELS[kind] ?? kind }));
}

export interface ActivityPageViewProps {
  /** The relay state; undefined until the page's own poll answers. */
  readonly state: TimelineState | undefined;
  /** The selected row kind's raw value, or null for all kinds (the default). */
  readonly kind: string | null;
  readonly onKind: (kind: string | null) => void;
}

export function ActivityPageView({ state, kind, onKind }: ActivityPageViewProps) {
  if (state === undefined || state.timeline === null) {
    return (
      <div className="activity-page activity-page-degraded" role="status">
        <span className="activity-timeline-degraded-note">
          {state?.reason === undefined ? "hub timeline: loading…" : "hub timeline unavailable (" + state.reason + ")"}
        </span>
      </div>
    );
  }
  const timeline = state.timeline;
  const filters = activityKindFilters();
  // The filter is a view-side SLICE of the relayed record list — no row is
  // derived, reordered, or rewritten.
  const visible = kind === null ? timeline.rows : timeline.rows.filter((row) => row.kind === kind);
  const degraded = new Set(timeline.degraded);
  // An active filter that yields nothing names itself; only the unfiltered
  // empty feed says "no recorded activity yet".
  const emptyKindLabel = kind === null ? null : KIND_LABELS[kind] ?? kind;
  return (
    <div className="activity-page">
      <div className="activity-page-filters" role="group" aria-label="Filter activity by record kind">
        <button
          type="button"
          className={"activity-page-filter" + (kind === null ? " activity-page-filter-active" : "")}
          aria-pressed={kind === null}
          onClick={() => onKind(null)}
        >
          all
        </button>
        {filters.map((filter) => (
          <button
            type="button"
            key={filter.kind}
            className={"activity-page-filter" + (kind === filter.kind ? " activity-page-filter-active" : "")}
            aria-pressed={kind === filter.kind}
            onClick={() => onKind(filter.kind)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="muted activity-page-empty">
          {emptyKindLabel === null ? "no recorded activity yet" : "no " + emptyKindLabel + " rows recorded"}
        </p>
      ) : (
        <ul className="activity-page-rows">
          {visible.map((row, index) => (
            <TimelineRowItem key={row.kind + ":" + String(index)} row={row} />
          ))}
        </ul>
      )}
      {degraded.size > 0 && (
        <div className="activity-timeline-degraded-note">state unavailable: {[...degraded].join(", ")}</div>
      )}
      <p className="muted activity-timeline-retention">{TIMELINE_RETENTION}</p>
    </div>
  );
}

/** The page's wiring: its own timeline poll (each consumer owns its poll)
 * and the filter's UI state, defaulting to all kinds. */
export function ActivityPage() {
  const state = useActivityTimeline();
  const [kind, setKind] = useState<string | null>(null);
  return <ActivityPageView state={state} kind={kind} onKind={setKind} />;
}
