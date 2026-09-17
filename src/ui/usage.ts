import type { ModelUsageMetrics } from "../integrations/model-usage-proxy.js";

/**
 * W044 (G1 metric surfacing): what the session UIs render. The metering
 * proxy's records are cumulative-per-proxy; per-turn figures are computed at
 * turn boundaries by the usage tracker below.
 */
export interface UsageView {
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly perTurnTokens?: number;
  readonly perTurnCostUsd?: number;
  /** W045: the sticky session-budget violation reason, once crossed. */
  readonly budgetViolation?: string;
}

export type UsageSource = () => UsageView | undefined;

/** Cumulative-only view straight from the proxy's metrics. */
export function usageViewFromMetrics(metrics: ModelUsageMetrics | undefined): UsageView | undefined {
  if (metrics === undefined) return undefined;
  return { totalTokens: metrics.totalTokens, costUsd: metrics.costUsd };
}

/**
 * Tracks per-turn usage across the session-state lifecycle the TUI already
 * observes: a transition INTO "running" marks a turn start (baseline the
 * cumulative counters), a transition INTO "completed" marks the turn end
 * (delta = current − baseline). "failed"/"cancelled" also end a turn but
 * publish no delta — a partial bill is not an honest per-turn figure.
 * Deterministic and side-effect free so it is unit-testable without a live
 * proxy.
 */
export class UsageTurnTracker {
  #baseline: UsageView | undefined;
  #lastTurn: { perTurnTokens: number; perTurnCostUsd: number } | undefined;

  /**
   * Feed the session state and the latest cumulative usage; returns the
   * per-turn figures once a turn has completed (sticky until the next turn
   * completes).
   */
  observe(sessionState: string | undefined, current: UsageView | undefined): UsageView | undefined {
    if (current === undefined) return undefined;
    if (sessionState === "running") {
      if (this.#baseline === undefined) this.#baseline = current;
    } else if (this.#baseline !== undefined) {
      if (sessionState === "completed") {
        this.#lastTurn = {
          perTurnTokens: Math.max(0, current.totalTokens - this.#baseline.totalTokens),
          perTurnCostUsd: Math.max(0, current.costUsd - this.#baseline.costUsd),
        };
      }
      this.#baseline = undefined;
    }
    return { ...current, ...(this.#lastTurn === undefined ? {} : { perTurnTokens: this.#lastTurn.perTurnTokens, perTurnCostUsd: this.#lastTurn.perTurnCostUsd }) };
  }
}

/** Header status line: cumulative + (when known) the last turn's delta + a crossed budget. */
export function formatUsageLine(usage: UsageView): string {
  const cumulative = `${usage.totalTokens} tokens · $${usage.costUsd.toFixed(4)}`;
  const perTurn = usage.perTurnTokens === undefined || usage.perTurnCostUsd === undefined
    ? ""
    : ` · +${usage.perTurnTokens} this turn · $${usage.perTurnCostUsd.toFixed(4)}`;
  const violation = usage.budgetViolation === undefined ? "" : ` · ! ${usage.budgetViolation}`;
  return `${cumulative}${perTurn}${violation}`;
}
