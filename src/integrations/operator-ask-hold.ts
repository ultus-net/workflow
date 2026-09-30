/**
 * The shared operator ask-hold primitive (P6 seats, issue #285).
 *
 * Mirrors the landed daemon hold in `opencode-server-authority.ts` so the
 * non-primary seats reuse one hold dialect rather than inventing a second:
 *
 * - **Park.** An `ask` registers a pending entry with a timeout timer; a reply
 *   that raced ahead of the ask (the latency race) is consumed first.
 * - **Answer.** The operator can tighten, never loosen — the held ask exists
 *   only because policy allowed it, so `reject` wins and any other reply maps
 *   to the policy-allowed outcome (`once`).
 * - **Timeout.** An unanswered hold resolves `reject` (fail closed) at the
 *   configured window (default 120s, matching the daemon).
 * - **Cancel.** `cancelAll` resolves every pending hold to `reject` so no ask
 *   dangles on stop.
 * - **Observability.** `pendingCount` / `pending` let a surface project the
 *   held ask.
 *
 * A stale early reply for a consumed ask id is cleared, so it can never answer
 * a later ask with the same id.
 */

export type OperatorAskReply = "once" | "always" | "reject";

export interface OperatorAskRequest {
  readonly requestId: string;
  readonly policy: string;
  readonly reason: string;
  /** The concrete surface the guard rule matched (W121 G4), when present. */
  readonly matched?: string;
}

export interface OperatorAskHoldOptions {
  /** Hold window; on timeout the ask resolves reject (fail closed). Default 120s. */
  readonly timeoutMs?: number;
}

export interface OperatorAskHold {
  /**
   * Parks an ask and resolves with the operator's reply: `reject` when the
   * operator rejected or the hold timed out, otherwise `once`.
   */
  park(request: OperatorAskRequest): Promise<OperatorAskReply>;
  /**
   * Records the operator's answer. Returns `true` when a pending hold was
   * resolved; `false` when the reply raced ahead of the ask (remembered as an
   * early reply). Reconciles tighten-never-loosen: `reject` wins.
   */
  answer(requestId: string, reply: "allow" | "deny" | OperatorAskReply): boolean;
  /** Number of asks currently held for the operator. */
  readonly pendingCount: number;
  /** The asks currently held, in park order (surface projection). */
  readonly pending: readonly OperatorAskRequest[];
  /** Resolves every pending hold to reject and forgets early replies. */
  cancelAll(): void;
}

interface PendingHold {
  readonly request: OperatorAskRequest;
  readonly resolveReply: (reply: OperatorAskReply) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createOperatorAskHold(options: OperatorAskHoldOptions = {}): OperatorAskHold {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pending = new Map<string, PendingHold>();
  const earlyReplies = new Map<string, OperatorAskReply>();

  return {
    park(request) {
      const early = earlyReplies.get(request.requestId);
      if (early !== undefined) {
        earlyReplies.delete(request.requestId);
        return Promise.resolve(early);
      }
      return new Promise<OperatorAskReply>((resolvePark) => {
        const timer = setTimeout(() => {
          pending.delete(request.requestId);
          earlyReplies.delete(request.requestId); // A stale early reply must not answer a later ask.
          resolvePark("reject"); // Fail closed: an unanswered hold never allows.
        }, timeoutMs);
        pending.set(request.requestId, {
          request,
          resolveReply: (reply) => {
            clearTimeout(timer);
            pending.delete(request.requestId);
            resolvePark(reply);
          },
          timer,
        });
      });
    },
    answer(requestId, reply) {
      // Tighten-never-loosen: the held ask exists only because policy allowed
      // it, so the operator can only deny; anything else proceeds as `once`.
      const normalized: OperatorAskReply = reply === "deny" || reply === "reject" ? "reject" : "once";
      const held = pending.get(requestId);
      if (held === undefined) {
        earlyReplies.set(requestId, normalized);
        return false;
      }
      held.resolveReply(normalized);
      return true;
    },
    get pendingCount() {
      return pending.size;
    },
    get pending() {
      return [...pending.values()].map((entry) => entry.request);
    },
    cancelAll() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.resolveReply("reject");
      }
      pending.clear();
      earlyReplies.clear();
    },
  };
}
