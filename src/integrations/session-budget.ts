import { createBudgetGuard, type RunBudget, type UsageSnapshot } from "./hub-scheduler.js";

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
  readonly WORKFLOW_BUDGET_DOWNGRADE_MODEL?: string;
  readonly WORKFLOW_BUDGET_DOWNGRADE_FRACTION?: string;
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

/** W118 (the W095 budget-downgrade consumer): the downgrade axes. The
 * TARGET model is required — a fraction without a target downgrades to
 * nothing; the WARN FRACTION defaults to 0.8 and must parse to (0,1).
 * Unlike parseCap (which throws — a broken cap must never degrade to an
 * unenforced session), a broken downgrade axis fails CLOSED to undefined:
 * no downgrade is the status quo ante, the safe direction. The fail-closed
 * path is NOT silent: when the operator set an axis, the parse warns
 * `[budget] …` naming the axis and the value (the W118-era silence residual
 * — park P15 (d), the W118 item's residual (f) — resolved 2026-09-24 in
 * W122). Honest absence (nothing set) stays silent. The threshold source
 * stays design-open (the routing note's key-2: "env axis or cap fraction")
 * — both axes are env for v1. */
export interface BudgetDowngradeConfig {
  readonly targetModel: string;
  readonly fraction: number;
}

/** W118: the runtime shape — the env config plus the budget the activation
 * evaluates against. Named once so the proxy and pool option types cannot
 * drift apart (the fresh-eyes round-1 P3: two inline copies of the same
 * shape will diverge). */
export interface BudgetDowngradeRuntime {
  readonly targetModel: string;
  readonly budget: RunBudget;
  readonly fraction: number;
}

export function budgetDowngradeFromEnv(
  env: BudgetEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(`[budget] ${message}`),
): BudgetDowngradeConfig | undefined {
  const targetModel = env.WORKFLOW_BUDGET_DOWNGRADE_MODEL?.trim();
  const rawFraction = env.WORKFLOW_BUDGET_DOWNGRADE_FRACTION?.trim();
  const fractionSet = rawFraction !== undefined && rawFraction.length > 0;
  if ((targetModel === undefined || targetModel.length === 0) && !fractionSet) return undefined;
  if (targetModel === undefined || targetModel.length === 0) {
    // The operator set the fraction axis but there is no target: a fraction
    // without a target downgrades to nothing. The warn keeps the operator
    // facing the disabled behavior (once per runtime composition — the
    // createOpencodeRuntime call site).
    warn(
      `WORKFLOW_BUDGET_DOWNGRADE_FRACTION is set (${JSON.stringify(rawFraction)}) but WORKFLOW_BUDGET_DOWNGRADE_MODEL is missing — a fraction without a target downgrades to nothing; the downgrade stays OFF`,
    );
    return undefined;
  }
  const fraction = fractionSet ? Number(rawFraction) : 0.8;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
    warn(
      `WORKFLOW_BUDGET_DOWNGRADE_FRACTION is malformed: ${JSON.stringify(rawFraction)} does not parse to (0,1) — the downgrade to ${JSON.stringify(targetModel)} stays off (fail-closed; the status quo ante)`,
    );
    return undefined;
  }
  // The fail-closed-to-undefined posture itself is unchanged (a broken
  // downgrade degrades to no-downgrade, the safe direction). What the
  // W118-era record carried as a residual was the SILENCE around it —
  // "operator-facing logging is queued" (park P15 (d); the W118 item's
  // residual (f)) — now landed as the warns above; honest absence stays
  // silent.
  return { targetModel, fraction };
}

/** W118: the WARN-tier predicate — mirrors budgetViolation's per-dimension
 * comparison at the warn fraction (usage >= fraction x cap on ANY
 * dimension). No caps configured means nothing to warn about. The abort
 * tier itself is untouched: the guard still cancels at the full cap. */
export function budgetDowngradeActive(usage: UsageSnapshot, budget: RunBudget, fraction: number): boolean {
  if (budget.maxTotalTokens !== undefined && usage.totalTokens >= budget.maxTotalTokens * fraction) return true;
  if (budget.maxInputTokens !== undefined && usage.promptTokens >= budget.maxInputTokens * fraction) return true;
  if (budget.maxOutputTokens !== undefined && usage.completionTokens >= budget.maxOutputTokens * fraction) return true;
  if (budget.maxCostUsd !== undefined && usage.costUsd >= budget.maxCostUsd * fraction) return true;
  return false;
}

export type SessionBudgetGuard = ReturnType<typeof createSessionBudgetGuard>;

/**
 * The interactive-session guard IS the scheduled-run guard
 * (`createBudgetGuard` in `hub-scheduler.ts`): same signature, same
 * cancel-once/sticky-violation semantics, same `budgetViolation` rules —
 * one implementation, two enforcement points. Re-exported under the
 * session-budget name so callers read the intent at the import site.
 */
export const createSessionBudgetGuard = createBudgetGuard;
