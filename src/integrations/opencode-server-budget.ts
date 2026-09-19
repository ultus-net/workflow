import type { ModelUsageMetrics } from "./model-usage-proxy.js";
import type { SessionBudget } from "./session-budget.js";

/**
 * W071 M4 — the session-budget watcher for the Workflow-owned OpenCode server.
 *
 * The W045 interactive budget semantics, adapted to the server path: there is
 * no WorkflowCodingSession to subscribe to, so the watcher polls the metering
 * proxy's cumulative usage; crossing a cap aborts every active server turn and
 * sets a sticky violation that the authority broker consults before allowing
 * any further mutation. Unset caps mean no watcher (the OpenRouter per-key
 * credit limit remains the recorded backstop). A malformed cap already throws
 * at `sessionBudgetFromEnv`, so a broken budget never degrades to silence.
 */

export interface OpencodeServerBudgetOptions {
  readonly budget: SessionBudget;
  /** Metering-proxy usage snapshot (undefined = nothing recorded yet). */
  readonly usage: () => ModelUsageMetrics | undefined;
  /** Aborts a turn on a server session (`engine.abort`). */
  readonly abort: (sessionId: string) => Promise<void>;
  /** Session ids currently known to the broker. */
  readonly knownSessions: () => readonly string[];
  readonly intervalMs?: number | undefined;
  readonly onViolation?: ((reason: string) => void) | undefined;
}

export interface OpencodeServerBudgetWatcher {
  start(): void;
  stop(): void;
  /** Polls once and returns the sticky violation, if any (deterministic; tests use this). */
  check(): string | undefined;
  /** The sticky violation reason once crossed, otherwise undefined. */
  violation(): string | undefined;
}

export function createOpencodeServerBudget(options: OpencodeServerBudgetOptions): OpencodeServerBudgetWatcher {
  const intervalMs = options.intervalMs ?? 2_000;
  let violation: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const aborted = new Set<string>();

  const exceeded = (usage: ModelUsageMetrics): string | undefined => {
    if (options.budget.maxTotalTokens !== undefined && usage.totalTokens > options.budget.maxTotalTokens) {
      return `total tokens ${usage.totalTokens} exceeded the session budget cap ${options.budget.maxTotalTokens}`;
    }
    if (options.budget.maxInputTokens !== undefined && usage.promptTokens > options.budget.maxInputTokens) {
      return `input tokens ${usage.promptTokens} exceeded the session budget cap ${options.budget.maxInputTokens}`;
    }
    if (options.budget.maxOutputTokens !== undefined && usage.completionTokens > options.budget.maxOutputTokens) {
      return `output tokens ${usage.completionTokens} exceeded the session budget cap ${options.budget.maxOutputTokens}`;
    }
    if (options.budget.maxCostUsd !== undefined && usage.costUsd > options.budget.maxCostUsd) {
      return `cost $${usage.costUsd.toFixed(4)} exceeded the session budget cap $${options.budget.maxCostUsd}`;
    }
    return undefined;
  };

  const check = (): string | undefined => {
    const usage = options.usage();
    if (usage === undefined) return violation;
    const reason = exceeded(usage);
    if (reason !== undefined && violation === undefined) {
      violation = reason;
      options.onViolation?.(reason);
    }
    if (violation === undefined) return undefined;
    // While violated, abort every known session that has not been aborted yet
    // (review P3-5): sessions learned after the crossing must not keep
    // spending.
    for (const sessionId of options.knownSessions()) {
      if (aborted.has(sessionId)) continue;
      aborted.add(sessionId);
      void options.abort(sessionId).catch(() => undefined);
    }
    return violation;
  };

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        try {
          check();
        } catch {
          // The poller never throws; a usage-read failure surfaces elsewhere.
        }
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    check,
    violation() {
      return violation;
    },
  };
}