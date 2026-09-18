/**
 * OpenRouter analytics client for the operator's spend/usage breakdown.
 * Requires a Management key (dashboard-created; the plain API key cannot
 * query analytics). The key never leaves the server: the browser talks to
 * Workflow's /api/usage route, which composes these calls.
 *
 * Endpoint shapes per openrouter.ai/docs/api/api-reference/analytics (2026-09).
 */

const BASE_URL = "https://openrouter.ai/api/v1";

export interface AnalyticsMeta {
  readonly metrics: readonly { readonly name: string; readonly display_label: string; readonly is_rate: boolean; readonly display_format: string }[];
  readonly dimensions: readonly { readonly name: string; readonly display_label: string }[];
  readonly granularities: readonly { readonly name: string; readonly display_label: string }[];
}

export interface AnalyticsRow {
  readonly [column: string]: string | number | undefined;
}

export interface AnalyticsResult {
  readonly rows: readonly AnalyticsRow[];
  readonly truncated: boolean;
}

export interface CreditSummary {
  readonly totalCredits: number;
  readonly totalUsage: number;
}

export interface OpenRouterAnalytics {
  meta(): Promise<AnalyticsMeta>;
  /** Totals grouped by model + provider over the window, spend descending. */
  queryByModel(startIso: string, endIso: string): Promise<AnalyticsResult>;
  /** Daily cost series over the window (for the bar strip). */
  queryDaily(startIso: string, endIso: string): Promise<AnalyticsResult>;
  credits(): Promise<CreditSummary | undefined>;
}

/** The metric names the Usage page wants, in preference order. The meta
 * endpoint is the authority: only metrics it advertises are queried, and the
 * row mapping reads whatever columns actually came back. */
const WANTED_METRICS = ["cost", "cost_usd", "prompt_tokens", "completion_tokens", "request_count"] as const;

export function createOpenRouterAnalytics(options: {
  readonly key: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly baseUrl?: string;
}) {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? BASE_URL;
  const headers = {
    authorization: `Bearer ${options.key}`,
    "content-type": "application/json",
  };

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await doFetch(`${base}${path}`, init);
    if (!response.ok) {
      const detail = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
      throw new Error(detail?.error?.message ?? `OpenRouter ${path} failed: ${response.status}`);
    }
    return await response.json() as T;
  }

  async function meta(): Promise<AnalyticsMeta> {
    const payload = await request<{ data: AnalyticsMeta }>("/analytics/meta");
    return payload.data;
  }

  /** The Usage page wants spend and token splits; the meta endpoint is the
   * authority — only metrics it advertises are queried. */
  function wantedMetrics(advertised: readonly { readonly name: string }[]): string[] {
    const available = new Set(advertised.map((metric) => metric.name));
    return WANTED_METRICS.filter((name) => available.has(name));
  }

  async function query(body: Record<string, unknown>): Promise<AnalyticsResult> {
    const payload = await request<{ data: { data: AnalyticsRow[]; metadata: { truncated?: boolean } } }>("/analytics/query", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return {
      rows: payload.data.data ?? [],
      truncated: payload.data.metadata?.truncated === true,
    };
  }

  /** Totals per model (and provider when the dimension is offered), ordered
   * by spend. Metric columns ride through as they are returned. */
  async function queryByModel(startIso: string, endIso: string): Promise<AnalyticsResult> {
    const advertised = await meta();
    const metrics = wantedMetrics(advertised.metrics);
    if (metrics.length === 0) throw new Error("OpenRouter analytics advertises no usable metrics");
    const dimensions = advertised.dimensions.some((dimension) => dimension.name === "model")
      ? ["model", ...(advertised.dimensions.some((entry) => entry.name === "provider") ? ["provider"] : [])]
      : [];
    const costMetric = metrics.find((name) => name.startsWith("cost"));
    return await query({
      metrics,
      ...(dimensions.length > 0 ? { dimensions } : {}),
      time_range: { start: startIso, end: endIso },
      limit: 100,
      ...(costMetric !== undefined ? { order_by: { field: costMetric, direction: "desc" } } : {}),
    });
  }

  async function queryDaily(startIso: string, endIso: string): Promise<AnalyticsResult> {
    const advertised = await meta();
    const metrics = wantedMetrics(advertised.metrics);
    if (metrics.length === 0) throw new Error("OpenRouter analytics advertises no usable metrics");
    if (!advertised.granularities.some((granularity) => granularity.name === "day")) {
      return { rows: [], truncated: false };
    }
    return await query({
      metrics,
      granularity: "day",
      time_range: { start: startIso, end: endIso },
      limit: 120,
    });
  }

  async function credits(): Promise<CreditSummary | undefined> {
    try {
      const payload = await request<{ data?: { total_credits?: number; total_usage?: number } }>("/credits");
      const total_credits = payload.data?.total_credits;
      const total_usage = payload.data?.total_usage;
      if (typeof total_credits !== "number" || typeof total_usage !== "number") return undefined;
      return { totalCredits: total_credits, totalUsage: total_usage };
    } catch {
      // Credits need elevated key scopes in some deployments; the analytics
      // table is the page's substance, so credits degrade to absent.
      return undefined;
    }
  }

  return { meta, queryByModel, queryDaily, credits };
}

/** ISO stamps for "the last N days" with seconds precision (OpenRouter
 * rejects minute precision). */
export function usageTimeRange(days: number, now: () => Date = () => new Date()): { readonly startIso: string; readonly endIso: string } {
  const end = now();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    startIso: start.toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    endIso: end.toISOString().replace(/\.\d{3}Z$/, ".000Z"),
  };
}