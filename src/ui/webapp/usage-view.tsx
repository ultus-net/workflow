import { useCallback, useEffect, useState } from "react";

import type { LiveStatsState } from "../../integrations/opencode-live-state.js";

/** One analytics row: dimension columns (model, provider) plus whatever
 * metric columns OpenRouter returned (cost, tokens, request_count). */
export interface UsageRow {
  readonly [column: string]: string | number | undefined;
}

export interface UsageCredits {
  readonly totalCredits: number;
  readonly totalUsage: number;
}

export interface UsageCoverage {
  readonly requestedDaysParam: string | null;
  readonly days: number;
  readonly ignoredParams?: readonly string[];
  readonly window?: { readonly startIso: string; readonly endIso: string };
  readonly byModel?: { readonly rows: number; readonly truncated?: boolean; readonly limit: number };
  readonly byDay?: { readonly rows: number; readonly truncated?: boolean; readonly limit: number; readonly granularityAvailable?: boolean };
  readonly creditsAvailable?: boolean;
}

export interface UsagePayload {
  readonly available: boolean;
  readonly reason?: string;
  readonly days?: number;
  readonly credits?: { readonly totalCredits: number; readonly totalUsage: number };
  readonly byModel?: { readonly rows: readonly UsageRow[]; readonly truncated: boolean };
  readonly byDay?: { readonly rows: readonly UsageRow[]; readonly truncated: boolean };
  /** W107 (amux C1): server-computed coverage metadata — rendered inline so
   * every number states what population and window it actually judged. */
  readonly coverage?: UsageCoverage;
  readonly error?: string;
}

const RANGES = [
  [1, "24h"],
  [7, "7d"],
  [30, "30d"],
] as const;

/** W107 (amux C1): the response-honesty line — what population and window
 * each rendered number actually judged, all facts server-supplied. Rendered
 * inline beside the numbers; the amux anti-pattern was an all-clear whose
 * window or population differed silently from its label. */
function UsageCoverageLine(props: { readonly coverage: UsageCoverage }) {
  const { coverage } = props;
  const parts: string[] = [];
  parts.push(coverage.window !== undefined
    ? `window ${coverage.window.startIso} → ${coverage.window.endIso}`
    : `window ${coverage.days}d`);
  if (coverage.byModel !== undefined) {
    parts.push(`${coverage.byModel.rows} model rows / limit ${coverage.byModel.limit}${coverage.byModel.truncated === true ? " · TRUNCATED" : ""}`);
  }
  if (coverage.byDay !== undefined) {
    parts.push(`${coverage.byDay.rows} daily rows / limit ${coverage.byDay.limit}${coverage.byDay.truncated === true ? " · TRUNCATED" : ""}`);
    if (coverage.byDay.granularityAvailable === false) {
      parts.push("daily granularity unavailable upstream — the empty series is a coverage fact, not an all-clear");
    }
  }
  if (coverage.creditsAvailable !== undefined) {
    parts.push(coverage.creditsAvailable ? "credits included" : "credits unavailable");
  }
  if (coverage.ignoredParams !== undefined && coverage.ignoredParams.length > 0) {
    parts.push(`ignored params: ${coverage.ignoredParams.join(", ")}`);
  }
  return <p className="muted usage-note usage-coverage" aria-label="Usage coverage">{parts.join(" · ")}</p>;
}

/** Server-side session statistics (W079, data lane): the documented aggregate
 * read through the enforced gateway when the server topology runs. Honest
 * states only — null until resolved, the reason is the value when unavailable,
 * never a fabricated figure. */
export function LiveTopologyStats(props: { readonly state?: LiveStatsState | undefined }) {
  const [fetched, setFetched] = useState<LiveStatsState | undefined>(undefined);
  const state = props.state ?? fetched;
  useEffect(() => {
    if (props.state !== undefined) return; // state override (tests)
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/usage/sessions/live");
        if (!response.ok) return;
        const loaded = await response.json() as LiveStatsState;
        setFetched(loaded);
      } catch {
        // Honest absence: the block stays hidden rather than showing zeros.
      }
    };
    void load();
    return () => { /* single load per mount */ };
  }, [props.state]);
  if (state === undefined) return null;
  if (!state.live) {
    return <p className="muted usage-topology-note">no server-topology stats — {state.reason}</p>;
  }
  const stats = state.stats;
  return (
    <div className="usage-topology" aria-label="Server topology statistics">
      <h3>Server topology <span className="muted">({state.gatewayUrl})</span></h3>
      <table className="usage-table">
        <tbody>
          <tr><th scope="row">sessions</th><td>{stats.sessions}</td><th scope="row">prompts</th><td>{stats.prompts}</td><th scope="row">steps</th><td>{stats.steps}</td></tr>
          <tr>
            <th scope="row">tokens</th>
            <td colSpan={5}>
              in {stats.tokens.input} · out {stats.tokens.output} · reasoning {stats.tokens.reasoning} · cache r/w {stats.tokens.cacheRead}/{stats.tokens.cacheWrite}
            </td>
          </tr>
          <tr>
            <th scope="row">cost</th>
            <td>${stats.cost.toFixed(4)}</td>
            <th scope="row">tools</th>
            <td colSpan={3}>
              {stats.tools.calls} calls · {stats.tools.succeeded} ok · {stats.tools.failed} failed · {stats.tools.unfinished} unfinished
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Daily spend strip: square bars, relative height, honest "no spend" when
 * every day is zero. Pure CSS — no chart dependency in the bundle. */
function SpendStrip({ rows }: { readonly rows: readonly UsageRow[] }) {
  const days = rows.map((row) => ({
    date: String(row.date__day ?? "").slice(0, 10),
    cost: costOf(row),
  }));
  const max = Math.max(0, ...days.map((day) => day.cost));
  if (days.length === 0 || max === 0) {
    return <p className="muted usage-strip-empty">no metered spend in this window</p>;
  }
  return (
    <div className="usage-strip" role="img" aria-label={`Daily spend over the window, peak ${max.toFixed(4)} dollars`}>
      {days.map((day) => (
        <span key={day.date} className="usage-strip-day" title={`${day.date}: $${day.cost.toFixed(4)}`}>
          <span className="usage-strip-fill" style={{ height: `${Math.max(2, Math.round((day.cost / max) * 100))}%` }} />
        </span>
      ))}
    </div>
  );
}

function costOf(row: UsageRow): number {
  for (const key of ["cost", "cost_usd"]) {
    const value = row[key];
    if (typeof value === "number") return value;
  }
  return 0;
}

/** The Usage page: OpenRouter spend and token breakdown by model/provider,
 * sourced from the analytics API with the server-held Management key. */
export function UsageView() {
  const [days, setDays] = useState(7);
  const [payload, setPayload] = useState<UsagePayload | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (range: number): Promise<void> => {
    setPayload(undefined);
    setLoading(true);
    try {
      const response = await fetch(`/api/usage?days=${range}`);
      if (response.ok) setPayload(await response.json() as UsagePayload);
      else setPayload({ available: false, error: `usage unavailable (${response.status})` });
    } catch {
      setPayload({ available: false, error: "usage unavailable (network error)" });
    }
  }, []);
  useEffect(() => {
    void load(days).finally(() => setLoading(false));
  }, [days, load]);

  return (
    <section className="usage-view" aria-label="Usage">
      <header className="usage-head">
        <h2>Usage</h2>
        <div className="usage-ranges" role="radiogroup" aria-label="Time range">
          {RANGES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={days === value}
              className={`theme-option ${days === value ? "theme-option-on" : ""}`}
              onClick={() => { setDays(value); setLoading(true); }}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <LiveTopologyStats />

      {payload === undefined && <p className="muted usage-empty-note">{loading ? "loading usage…" : ""}</p>}

      {payload !== undefined && payload.available === false && (
        <p className="muted usage-setup">{payload.reason ?? payload.error ?? "usage unavailable"}</p>
      )}

      {payload !== undefined && payload.available === true && (
        <div className="usage-body">
          {payload.coverage !== undefined && <UsageCoverageLine coverage={payload.coverage} />}
          {payload.credits !== undefined && (
            <div className="usage-credits">
              <span className="usage-credit-item">
                <span className="usage-credit-label">credits</span>
                <span className="usage-credit-value">${payload.credits.totalCredits.toFixed(2)}</span>
              </span>
              <span className="usage-credit-item">
                <span className="usage-credit-label">used</span>
                <span className="usage-credit-value">${payload.credits.totalUsage.toFixed(4)}</span>
              </span>
            </div>
          )}
          <SpendStrip rows={payload.byDay?.rows ?? []} />
          <table className="usage-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Provider</th>
                <th scope="col" className="usage-num">Requests</th>
                <th scope="col" className="usage-num">Input</th>
                <th scope="col" className="usage-num">Output</th>
                <th scope="col" className="usage-num">Cost</th>
              </tr>
            </thead>
          <tbody>
            {(payload.byModel?.rows ?? []).map((row, index) => (
              <tr key={index}>
                <td title={String(row.model ?? "")}>{String(row.model ?? "—")}</td>
                <td title={String(row.provider ?? "")}>{String(row.provider ?? "—")}</td>
                <td className="usage-num">{fmt(row.request_count)}</td>
                <td className="usage-num">{fmt(row.prompt_tokens)}</td>
                <td className="usage-num">{fmt(row.completion_tokens)}</td>
                <td className="usage-num">{costText(row)}</td>
              </tr>
            ))}
            {(payload.byModel?.rows ?? []).length === 0 && (
              <tr><td colSpan={6} className="muted">no metered generations in this window</td></tr>
            )}
          </tbody>
        </table>
          {payload.byModel?.truncated === true && <p className="muted usage-note">results truncated by OpenRouter — narrow the window for the long tail</p>}
          {payload.error !== undefined && <p className="muted usage-note">{payload.error}</p>}
        </div>
      )}
    </section>
  );
}

function fmt(value: string | number | undefined): string {
  if (typeof value !== "number") return "—";
  return value.toLocaleString("en-US");
}

function costText(row: UsageRow): string {
  for (const key of ["cost", "cost_usd"]) {
    const value = row[key];
    if (typeof value === "number") return `$${value.toFixed(4)}`;
  }
  return "—";
}