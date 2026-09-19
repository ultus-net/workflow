import type { ReadFingerprint } from "../application/host.js";
import { FileClaimLedger } from "../application/file-claim-ledger.js";
import { MutationBudget } from "../application/mutation-budget.js";

export interface OpenCodeV2SessionIdentity {
  readonly sessionId: string;
  readonly parentSessionId?: string;
}

/** v2-facing session identity/claims adapter. It owns no Workflow authority;
 * it translates v2 parent/child identity into the existing Workflow claim and
 * budget primitives for the gateway to enforce. */
export class OpenCodeV2SessionClaims {
  readonly #claims = new FileClaimLedger();
  readonly #budget: MutationBudget;

  constructor(maxMutations = 100) {
    this.#budget = new MutationBudget(maxMutations);
  }

  register(identity: OpenCodeV2SessionIdentity): void {
    this.#budget.register(identity.sessionId, identity.parentSessionId);
  }

  recordRead(sessionId: string, fingerprint: ReadFingerprint): void {
    this.#claims.recordRead(fingerprint);
  }

  claim(sessionId: string, paths: readonly string[]): boolean {
    return this.#claims.claim(sessionId, paths);
  }

  release(sessionId: string): void {
    this.#claims.release(sessionId);
    this.#budget.clear(sessionId);
  }

  consumeMutation(sessionId: string): boolean {
    return this.#budget.consume(sessionId);
  }

  matchesRead(path: string, fingerprint: ReadFingerprint): boolean {
    return this.#claims.matchesCurrent(path, fingerprint);
  }
}