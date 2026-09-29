/**
 * W175 phase 2 — the Runs page: EVERY registry run, one row each (not
 * schedule-lane only). Every column carries the /api/runs relay's records
 * verbatim: the run id (mono), the origin attribution (the origins record,
 * never derived from the run id — the W153 rule), the state, the work-product
 * link (W165), the recorded cost (the usage record's costUsd, the house
 * $/toFixed(4)), and the start time ONLY where the row's record carries
 * startedAt — a row without one renders "no recorded time" (the timeline
 * house rule), and no duration renders at all (the relay carries no duration
 * record; deriving one from kernel transitions is forbidden — the view is
 * projection-only). Filters: origin, state. The empty state names the first
 * action. A row click opens the run detail panel (app.tsx mounts it in the
 * shell's right-side region).
 *
 * (Template literals are deliberately absent: string concatenation keeps
 * the source patchable under the guard shell classifier.)
 */

import { useState } from "react";

import { formatRelativeTime, formatRunOrigin, statusToken } from "./presenters.js";
import type { RunOriginView, RunRowView, RunsRecordState } from "./runs-record.js";

/** The origin filter's tokens: the recorded origin kinds plus the honest
 * "no recorded origin" bucket (an unattributed run is never squeezed into a
 * recorded kind). */
export type RunOriginFilter = "all" | "schedule" | "provider-task" | "unrecorded";

/** The runs table's two filters. The state token is a verbatim recorded
 * state (never a hardcoded vocabulary — the records supply the options). */
export interface RunFilters {
  readonly origin: RunOriginFilter;
  readonly state: string;
}

/** A row's origin bucket for the filter — from the origins RECORD alone. */
export function originBucket(origin: RunOriginView | undefined): Exclude<RunOriginFilter, "all"> {
  if (origin === undefined) return "unrecorded";
  if (origin.kind === "schedule") return "schedule";
  if (origin.kind === "provider-task") return "provider-task";
  return "unrecorded";
}

/** Applies the two filters over the relay's rows and origin records. */
export function filterRunRows(
  rows: readonly RunRowView[],
  origins: Readonly<Record<string, RunOriginView>> | undefined,
  filters: RunFilters,
): readonly RunRowView[] {
  return rows.filter((row) => {
    if (filters.origin !== "all" && originBucket(origins?.[row.runId]) !== filters.origin) return false;
    if (filters.state !== "all" && row.state !== filters.state) return false;
    return true;
  });
}

/** The filter options, derived from the records themselves: "all" plus the
 * origin kinds and states actually recorded (states in first-seen row order;
 * origins in the fixed vocabulary order). */
export function runFilterChoices(
  rows: readonly RunRowView[],
  origins: Readonly<Record<string, RunOriginView>> | undefined,
): { readonly origin: readonly RunOriginFilter[]; readonly state: readonly string[] } {
  const originOrder: readonly Exclude<RunOriginFilter, "all">[] = ["schedule", "provider-task", "unrecorded"];
  const present = new Set(rows.map((row) => originBucket(origins?.[row.runId])));
  const states: string[] = [];
  for (const row of rows) if (!states.includes(row.state)) states.push(row.state);
  return {
    origin: ["all", ...originOrder.filter((bucket) => present.has(bucket))],
    state: ["all", ...states],
  };
}

const ORIGIN_LABELS: Readonly<Record<RunOriginFilter, string>> = {
  all: "all origins",
  schedule: "schedule",
  "provider-task": "provider-task",
  unrecorded: "no recorded origin",
};

export interface RunsViewProps {
  readonly record: RunsRecordState | undefined;
  readonly selectedRunId: string | undefined;
  readonly onSelectRun: (runId: string) => void;
  /** Controlled filters (the pins drive them); undefined → local state. */
  readonly filters?: RunFilters | undefined;
  readonly onFilters?: ((filters: RunFilters) => void) | undefined;
}

export function RunsView({ record, selectedRunId, onSelectRun, filters, onFilters }: RunsViewProps) {
  const [localFilters, setLocalFilters] = useState<RunFilters>({ origin: "all", state: "all" });
  const active = filters ?? localFilters;
  const setFilters = onFilters ?? setLocalFilters;
  if (record === undefined) {
    return <p className="runs-absent" role="status">state unavailable — the runs relay has not answered</p>;
  }
  if (record.runs === null) {
    return <p className="runs-absent" role="status">runs relay unavailable ({record.reason ?? "hub unavailable"})</p>;
  }
  const rows = record.runs.rows;
  if (rows.length === 0) {
    return <p className="runs-absent" role="status">no runs recorded yet — delegate a board task or fire a schedule</p>;
  }
  const origins = record.runs.origins;
  const workProducts = record.runs.workProducts;
  const usage = record.runs.usage;
  const visible = filterRunRows(rows, origins, active);
  const choices = runFilterChoices(rows, origins);
  return (
    <div className="runs-view">
      <div className="runs-filters">
        <label className="runs-filter-label">
          origin{" "}
          <select
            className="runs-select"
            aria-label="filter runs by origin"
            value={active.origin}
            onChange={(event) => setFilters({ origin: event.target.value as RunOriginFilter, state: active.state })}
          >
            {choices.origin.map((bucket) => (
              <option key={bucket} value={bucket}>{ORIGIN_LABELS[bucket]}</option>
            ))}
          </select>
        </label>
        <label className="runs-filter-label">
          state{" "}
          <select
            className="runs-select"
            aria-label="filter runs by state"
            value={active.state}
            onChange={(event) => setFilters({ origin: active.origin, state: event.target.value })}
          >
            {choices.state.map((state) => (
              <option key={state} value={state}>{state === "all" ? "all states" : state}</option>
            ))}
          </select>
        </label>
      </div>
      {visible.length === 0 ? (
        <p className="runs-absent" role="status">no runs match the filters</p>
      ) : (
        <div className="runs-table">
          <div className="runs-head" aria-hidden="true">
            <span>run id</span>
            <span>title</span>
            <span>origin</span>
            <span>state</span>
            <span>work product</span>
            <span>recorded cost</span>
            <span>start</span>
          </div>
          {visible.map((row) => {
            const link = workProducts?.[row.runId];
            const rowUsage = usage?.[row.runId];
            const origin = formatRunOrigin(origins?.[row.runId]);
            return (
              <button
                key={row.runId}
                type="button"
                className={"runs-row" + (selectedRunId === row.runId ? " runs-row-selected" : "")}
                data-run-row={row.runId}
                onClick={() => onSelectRun(row.runId)}
              >
                <code className="runs-row-id">{row.runId}</code>
                <span className="runs-row-title">{row.title ?? "—"}</span>
                <span className="runs-row-origin">{origin ?? "origin not recorded"}</span>
                <span className={"runs-state runs-state-" + statusToken(row.state)}>{row.state}</span>
                <span className="runs-row-workproduct">
                  {link === undefined
                    ? <span className="runs-cell-absent">no work-product link recorded</span>
                    : (
                      <a href={link.url} target="_blank" rel="noreferrer noopener" className="runs-workproduct" onClick={(event) => event.stopPropagation()}>
                        <code>{link.key}</code>
                      </a>
                    )}
                </span>
                <span className="runs-row-cost">
                  {rowUsage === undefined
                    ? <span className="runs-cell-absent">no recorded cost</span>
                    : "$" + rowUsage.costUsd.toFixed(4)}
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