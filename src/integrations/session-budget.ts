import { budgetViolation, type RunBudget, type UsageSnapshot } from "./hub-scheduler.js";

/**
 * W045 (G1 budget enforcement): spending caps for INTERACTIVE sessions,
 * not only scheduled runs. The cap is enforced against the metering proxy's
 * recorded usage: crossing it aborts the in-flight turn (session/cancel
 * semantics) and every later prompt is refused — fail-closed and
 * operator-visible, never a silent truncation. Violation semantics are
 * shared with the scheduled-run guard (`budgetViolation`) so both
 * enforcement points answer to the same rules; the scheduled-run wiring
 * itself is untouched.
 *
 * Server-side backstop: when no local interactive caps are configured, the
 * chosen enforcement mechanism is OpenRouter's per-key credit limit — set on
 * the metering proxy's upstream key (the only key agents never see) at
 * openrouter.ai/keys. That limit is enforced by the provider and bounds the
 * same channel; the runtime records which mechanism is active
 * (`sessionBudgetMechanism`) so the hub surfaces it per runtime.
 */

export type SessionBudget = RunBudget;

interface BudgetEnv {
  readonly WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS?: string;
  readonly WORKFLOW_SESSION_BUDGET_INPUT_TOKENS?: string;
  readonly WORKFLOW_SESSION_BUDGET_OUTPUT_TOKENS?: string;
  readonly WORKFLOW_SESSION_BUDGET_COST_USD?: string;
}

function parseCap(env: BudgetEnv, name: keyof BudgetEnv): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number (got ${JSON.stringify(raw)}) — refuse to run with a broken budget`);
  }
  return value;
}

/**
 * Caps for the interactive session budget, from the environment. Unset on
 * every axis → undefined (no local guard; the OpenRouter per-key credit
 * limit is the enforcement backstop). A malformed value throws: a broken
 * cap must never degrade to an unenforced session.
 */
export function sessionBudgetFromEnv(env: BudgetEnv = process.env): SessionBudget | undefined {
  const budget: { maxInputTokens?: number; maxOutputTokens?: number; maxTotalTokens?: number; maxCostUsd?: number } = {};
  let any = false;
  for (const [name, key] of [
    ["WORKFLOW_SESSION_BUDGET_INPUT_TOKENS", "maxInputTokens"],
    ["WORKFLOW_SESSION_BUDGET_OUTPUT_TOKENS", "maxOutputTokens"],
    ["WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS", "maxTotalTokens"],
    ["WORKFLOW_SESSION_BUDGET_COST_USD", "maxCostUsd"],
  ] as const) {
    const cap = parseCap(env, name);
    if (cap !== undefined) {
      budget[key] = cap;
      any = true;
    }
  }
  return any ? budget : undefined;
}

/** Which enforcement mechanism is active, recorded per runtime. */
export function sessionBudgetMechanism(env: BudgetEnv = process.env): string {
  const budget = sessionBudgetFromEnv(env);
  if (budget === undefined) {
    return "server-side: OpenRouter per-key credit limit on the metering proxy's upstream key (operator-set at openrouter.ai/keys); no local interactive caps";
  }
  const caps = [
    budget.maxInputTokens === undefined ? undefined : `input≤${budget.maxInputTokens}`,
    budget.maxOutputTokens === undefined ? undefined : `output≤${budget.maxOutputTokens}`,
    budget.maxTotalTokens === undefined ? undefined : `total≤${budget.maxTotalTokens}`,
    budget.maxCostUsd === undefined ? undefined : `cost≤$${budget.maxCostUsd}`,
  ].filter((part): part is string => part !== undefined);
  return `local session-budget guard (${caps.join(", ")})`;
}

export interface SessionBudgetGuard {
  /** Wire the guard into the session's event stream. */
  attach(): void;
  /** Check one session event; cancels the turn on the first violation. */
  checkEvent(event: { readonly type: string }): void;
  /** The recorded violation reason, once one has occurred (sticky). */
  violation(): string | undefined;
}

export function createSessionBudgetGuard(options: {
  readonly budget: SessionBudget;
  readonly usageSnapshot: () => UsageSnapshot | undefined;
  readonly cancel: () => void | Promise<void>;
  readonly subscribe: (listener: (event: { readonly type: string }) => void) => () => void;
}): SessionBudgetGuard {
  let violation: string | undefined;
  let cancelled = false;
  const checkEvent = (_event: { readonly type: string }): void => {
    void _event;
    if (violation !== undefined) return;
    const usage = options.usageSnapshot();
    if (usage === undefined) return;
    const reason = budgetViolation(usage, options.budget);
    if (reason === undefined) return;
    violation = reason;
    if (!cancelled) {
      cancelled = true;
      void Promise.resolve(options.cancel()).catch(() => undefined);
    }
  };
  return {
    attach() {
      options.subscribe(checkEvent);
    },
    checkEvent,
    violation: () => violation,
  };
}
