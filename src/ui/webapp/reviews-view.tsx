/**
 * W176 phase 3 (issue #347) — the Reviews page: one row per review-gated
 * run, so review discipline — five axes, anti-rubber-stamp — is browsable.
 *
 * The row set derives ONLY from the /api/runs relay's records (the same
 * mirror the Runs page polls — runs-record.ts; the page owns its poll
 * instance in app.tsx beside the other shell surfaces). A run is
 * review-gated when the relay's reviewOutcomes or blockingReasons carry it,
 * or its registry row's recorded state is VERIFYING; the union renders, in
 * record order (registry rows first, then the gate maps' ids a registry row
 * no longer carries). Every column is a record: the run id (mono), the
 * origin attribution (the origins record through the shared presenter —
 * never derived from the run id, the W153 rule), the verdict (the outcome
 * record's own vocabulary — approved says itself; changes_requested, the
 * reviewer's rejection verdict that the fail-closed path records too,
 * renders failed; no outcome record renders pending; a verdict outside the
 * vocabulary renders lowercased verbatim, never styled by a guess — the
 * statusToken rule), the axes the verdict names (the outcome record's
 * summary VERBATIM — the row clamps it in CSS, never re-parses it), the
 * blocking reason verbatim when the run sits VERIFYING, and the recorded
 * time ONLY where the run's registry row carries startedAt ("no recorded
 * time" otherwise; no duration is ever derived — the timeline house rule).
 *
 * Filter: verdict (the spec names no other filter for this page). Its
 * options derive from the derived rows — the page never offers a bucket no
 * record produced. The empty state names the first action. A row click
 * opens the SHARED run detail panel (app.tsx docks it in the shell's
 * right-side region) with the Review tab active.
 *
 * (Template literals are deliberately absent: string concatenation keeps
 * the source patchable under the guard shell classifier.)
 */

import { useState } from "react";

import { formatRelativeTime, formatRunOrigin } from "./presenters.js";
import type { ReviewOutcomeView, RunOriginView, RunsRecordState } from "./runs-record.js";

/** One review-gated run's row — every field a record the relay carried
 * (absent fields are the named absences the row renders, never derived). */
export interface ReviewRowView {
  readonly runId: string;
  /** The registry row's recorded state, when the rows list carries the run
   * (a run the gate maps alone carry has no recorded state here). */
  readonly state?: string;
  readonly origin?: RunOriginView;
  readonly outcome?: ReviewOutcomeView;
  readonly blocking?: string;
  readonly startedAt?: string;
}

/** The verdict filter's tokens: the page's three verdict buckets plus all.
 * The buckets are the page's own derivation vocabulary (see
 * reviewVerdictToken) — a run whose recorded verdict falls outside them
 * still renders, but no filter option exists for what no record named. */
export type ReviewVerdictFilter = "all" | "approved" | "failed" | "pending";

export interface ReviewFilters {
  readonly verdict: ReviewVerdictFilter;
}

const VERDICT_FILTERS: readonly Exclude<ReviewVerdictFilter, "all">[] = ["approved", "failed", "pending"];

const VERDICT_LABELS: Readonly<Record<ReviewVerdictFilter, string>> = {
  all: "all verdicts",
  approved: "approved",
  failed: "failed",
  pending: "pending",
};

/**
 * The verdict cell's token, from the outcome RECORD's own vocabulary: an
 * approved verdict says itself; changes_requested — the reviewer's
 * rejection verdict, which the fail-closed paths record too — renders
 * failed, as does fail/failed; anything else renders lowercased verbatim,
 * never styled by a guess (the statusToken rule). The vocabulary is the
 * hub reviewer's recorded one (HubReviewerResult.verdict: approved |
 * changes_requested); the page derives the bucket, the record stays
 * verbatim in the panel's Review tab.
 */
export function reviewVerdictToken(verdict: string): string {
  const lowered = verdict.toLowerCase();
  if (lowered === "approved") return "approved";
  if (lowered === "changes_requested" || lowered === "fail" || lowered === "failed") return "failed";
  return lowered;
}

/** A row's verdict bucket: approved/failed from the outcome record, pending
 * when no outcome record carries the run (the verdict has not been
 * recorded — the page never infers one from the run's state). */
export function reviewRowVerdict(outcome: ReviewOutcomeView | undefined): string {
  return outcome === undefined ? "pending" : reviewVerdictToken(outcome.verdict);
}

/**
 * The review-gated row set, from the records alone: the relay's registry
 * rows whose recorded state is VERIFYING or whose run id the gate maps
 * carry, then the gate maps' ids the rows list no longer carries (the maps
 * are bounded journals; their runs stay gated by their records). Order is
 * record order throughout — the view reorders nothing.
 */
export function deriveReviewRows(runs: NonNullable<RunsRecordState["runs"]>): readonly ReviewRowView[] {
  const outcomes = runs.reviewOutcomes;
  const blocking = runs.blockingReasons;
  const rows: ReviewRowView[] = [];
  const seen = new Set<string>();
  const push = (row: ReviewRowView): void => {
    if (seen.has(row.runId)) return;
    seen.add(row.runId);
    rows.push(row);
  };
  for (const row of runs.rows) {
    const outcome = outcomes[row.runId];
    const reason = blocking[row.runId];
    if (row.state !== "VERIFYING" && outcome === undefined && reason === undefined) continue;
    const origin = runs.origins?.[row.runId];
    push({
      runId: row.runId,
      ...(row.state === undefined ? {} : { state: row.state }),
      ...(origin === undefined ? {} : { origin }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(reason === undefined ? {} : { blocking: reason }),
      ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
    });
  }
  for (const runId of Object.keys(outcomes)) {
    const outcome = outcomes[runId];
    if (outcome === undefined) continue;
    push({ runId, outcome });
  }
  for (const runId of Object.keys(blocking)) {
    const reason = blocking[runId];
    if (reason === undefined) continue;
    push({ runId, blocking: reason });
  }
  return rows;
}

/** Applies the verdict filter over the derived rows (a view-side slice —
 * no row is derived anew, reordered, or rewritten). */
export function filterReviewRows(rows: readonly ReviewRowView[], filters: ReviewFilters): readonly ReviewRowView[] {
  if (filters.verdict === "all") return rows;
  return rows.filter((row) => reviewRowVerdict(row.outcome) === filters.verdict);
}

/** The filter's options: all, then the buckets the derived rows actually
 * produced (first-seen order) — never a hardcoded vocabulary list. */
export function reviewFilterChoices(rows: readonly ReviewRowView[]): readonly ReviewVerdictFilter[] {
  const present: Exclude<ReviewVerdictFilter, "all">[] = [];
  for (const row of rows) {
    const token = reviewRowVerdict(row.outcome);
    if (!(VERDICT_FILTERS as readonly string[]).includes(token)) continue;
    if (!present.includes(token as Exclude<ReviewVerdictFilter, "all">)) {
      present.push(token as Exclude<ReviewVerdictFilter, "all">);
    }
  }
  return ["all", ...present];
}

export interface ReviewsViewProps {
  readonly record: RunsRecordState | undefined;
  readonly selectedRunId: string | undefined;
  readonly onSelectRun: (runId: string) => void;
  /** Controlled filter (the pins drive it); undefined → local state. */
  readonly filters?: ReviewFilters | undefined;
  readonly onFilters?: ((filters: ReviewFilters) => void) | undefined;
}

export function ReviewsView({ record, selectedRunId, onSelectRun, filters, onFilters }: ReviewsViewProps) {
  const [localFilters, setLocalFilters] = useState<ReviewFilters>({ verdict: "all" });
  const active = filters ?? localFilters;
  const setFilters = onFilters ?? setLocalFilters;
  if (record === undefined) {
    return <p className="runs-absent" role="status">state unavailable — the runs relay has not answered</p>;
  }
  if (record.runs === null) {
    return <p className="runs-absent" role="status">runs relay unavailable ({record.reason ?? "hub unavailable"})</p>;
  }
  const rows = deriveReviewRows(record.runs);
  if (rows.length === 0) {
    return <p className="runs-absent" role="status">no review-gated runs recorded — a run reaches this page when its task sits VERIFYING or the reviewer records a verdict</p>;
  }
  const visible = filterReviewRows(rows, active);
  const choices = reviewFilterChoices(rows);
  return (
    <div className="reviews-view">
      <div className="runs-filters">
        <label className="runs-filter-label">
          verdict{" "}
          <select
            className="runs-select"
            aria-label="filter review-gated runs by verdict"
            value={active.verdict}
            onChange={(event) => setFilters({ verdict: event.target.value as ReviewVerdictFilter })}
          >
            {choices.map((token) => (
              <option key={token} value={token}>{VERDICT_LABELS[token]}</option>
            ))}
          </select>
        </label>
      </div>
      {visible.length === 0 ? (
        <p className="runs-absent" role="status">no review-gated runs match the filter</p>
      ) : (
        <div className="reviews-table">
          <div className="runs-head reviews-head" aria-hidden="true">
            <span>run id</span>
            <span>origin</span>
            <span>verdict</span>
            <span>axes named by the verdict</span>
            <span>blocking reason</span>
            <span>recorded time</span>
          </div>
          {visible.map((row) => {
            const verdict = reviewRowVerdict(row.outcome);
            return (
              <button
                key={row.runId}
                type="button"
                className={"runs-row reviews-row" + (selectedRunId === row.runId ? " runs-row-selected" : "")}
                data-run-row={row.runId}
                onClick={() => onSelectRun(row.runId)}
              >
                <code className="runs-row-id">{row.runId}</code>
                <span className="runs-row-origin">{formatRunOrigin(row.origin) ?? "origin not recorded"}</span>
                <span className={"runs-verdict runs-verdict-" + verdict}>{verdict}</span>
                <span className="reviews-row-axes">
                  {row.outcome === undefined
                    ? <span className="runs-cell-absent">no verdict axes recorded yet</span>
                    : row.outcome.summary}
                </span>
                <span className="reviews-row-blocking">
                  {row.state !== "VERIFYING"
                    ? <span className="runs-cell-absent">—</span>
                    : row.blocking === undefined
                      ? <span className="runs-cell-absent">no blocking reason recorded</span>
                      : row.blocking}
                </span>
                <span className="runs-row-time">
                  {row.startedAt === undefined
                    ? <span className="runs-cell-absent">no recorded time</span>
                    : <time dateTime={row.startedAt} title={row.startedAt}>{formatRelativeTime(row.startedAt)}</time>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
