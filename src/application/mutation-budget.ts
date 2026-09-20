/** Parent-owned bounded mutation budget for session/subagent hierarchies. */
export class MutationBudget {
  readonly #parents = new Map<string, string | undefined>();
  readonly #counts = new Map<string, number>();
  readonly #max: number;

  constructor(max = 100) {
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

  count(sessionId: string): number { return this.#counts.get(this.root(sessionId)) ?? 0; }
  remaining(sessionId: string): number { return Math.max(0, this.#max - this.count(sessionId)); }
  clear(sessionId: string): void { this.#counts.delete(this.root(sessionId)); }
}