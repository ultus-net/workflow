import { createHash } from "node:crypto";

export interface PolicyFailureInput {
  readonly sessionId: string;
  readonly tool: string;
  readonly reason: string;
}

export interface PolicyFailureState {
  readonly signature: string;
  readonly consecutive: number;
}

/** Application-owned per-session circuit-breaker state (plugin parity). */
export class PolicyFailureTracker {
  readonly #failures = new Map<string, PolicyFailureState>();
  readonly #threshold: number;

  constructor(threshold = 2) {
    if (!Number.isSafeInteger(threshold) || threshold < 1) throw new TypeError("threshold must be a positive integer");
    this.#threshold = threshold;
  }

  recordFailure(input: PolicyFailureInput): number {
    const signature = createHash("sha256").update(`${input.tool}\0${input.reason}`).digest("hex");
    const previous = this.#failures.get(input.sessionId);
    const consecutive = previous?.signature === signature ? previous.consecutive + 1 : 1;
    this.#failures.set(input.sessionId, { signature, consecutive });
    return consecutive;
  }

  recordSuccess(sessionId: string): void { this.#failures.delete(sessionId); }
  count(sessionId: string): number { return this.#failures.get(sessionId)?.consecutive ?? 0; }
  isOpen(sessionId: string): boolean { return this.count(sessionId) >= this.#threshold; }
  clear(sessionId: string): void { this.#failures.delete(sessionId); }
}