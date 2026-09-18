import { useCallback, useEffect, useState } from "react";

/** One analytics row: dimension columns (model, provider) plus whatever
 * metric columns OpenRouter returned (cost, tokens, request_count). */
export interface UsageRow {
  readonly [column: string]: string | number | undefined;
}

export interface UsageCredits {
  readonly totalCredits: number;
  readonly totalUsage: number;
}

export interface UsagePayload {
  readonly available: boolean;
  readonly reason?: string;
  readonly days?: number;
  readonly credits?: { readonly totalCredits: number; readonly totalUsage: number };
  readonly byModel?: { readonly rows: readonly UsageRow[]; readonly truncated: boolean };
  readonly byDay?: { readonly rows: readonly UsageRow[]; readonly truncated: boolean };
  readonly error?: string;
}

const RANGES = [
  [1, "24h"],
  [7, "7d"],
  [30, "30d"],
] as const;

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

      {payload === undefined && <p className="muted usage-empty-note">{loading ? "loading usage…" : ""}</p>}

      {payload !== undefined && payload.available === false && (
        <p className="muted usage-setup">{payload.reason ?? payload.error ?? "usage unavailable"}</p>
      )}

      {payload !== undefined && payload.available === true && (
        <div className="usage-body">
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