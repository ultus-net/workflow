/**
 * The default per-root mutation cap. `WORKFLOW_MUTATION_BUDGET` overrides it per
 * deployment; the default is kept as the honest baseline so an unconfigured
 * surface is byte-identical to the pre-W-hardening behavior.
 */
export const DEFAULT_MUTATION_BUDGET = 100;

/**
 * Parse `WORKFLOW_MUTATION_BUDGET`. Fail-closed: an unset value yields the
 * default, but a value that is not a positive safe integer throws — a broken
 * cap must never silently degrade to an unenforced or arbitrary budget (the
 * `sessionBudgetFromEnv` discipline). This is the operator-facing seam for the
 * observed C1 fault: a burst of allowed `process`-class shell mutations could
 * exhaust the cap for the rest of a session.
 */
export function mutationBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORKFLOW_MUTATION_BUDGET;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MUTATION_BUDGET;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`WORKFLOW_MUTATION_BUDGET must be a positive integer (got ${JSON.stringify(raw)}) — refuse to run with a broken budget`);
  }
  return value;
}

/** Parent-owned bounded mutation budget for session/subagent hierarchies. */
export class MutationBudget {
  readonly #parents = new Map<string, string | undefined>();
  readonly #counts = new Map<string, number>();
  readonly #max: number;

  constructor(max = DEFAULT_MUTATION_BUDGET) {
    if (!Number.isSafeInteger(max) || max < 1) throw new TypeError("max mutation budget must be positive");
    this.#max = max;
  }

  register(sessionId: string, parentId?: string): void {
    this.#parents.set(sessionId, parentId);
    if (!this.#counts.has(sessionId)) this.#counts.set(sessionId, 0);
  }

  root(sessionId: string): string {
    let current = sessionId;
    const seen = new Set<string>();
    while (this.#parents.get(current) !== undefined) {
      if (seen.has(current)) throw new TypeError("mutation budget parent cycle");
      seen.add(current);
      current = this.#parents.get(current)!;
    }
    return current;
  }

  consume(sessionId: string): boolean {
    const owner = this.root(sessionId);
    const next = (this.#counts.get(owner) ?? 0) + 1;
    if (next > this.#max) return false;
    this.#counts.set(owner, next);
    return true;
  }

  /** The configured cap for the root budget (diagnostics). */
  get max(): number { return this.#max; }
  count(sessionId: string): number { return this.#counts.get(this.root(sessionId)) ?? 0; }
  remaining(sessionId: string): number { return Math.max(0, this.#max - this.count(sessionId)); }
  clear(sessionId: string): void { this.#counts.delete(this.root(sessionId)); }
}