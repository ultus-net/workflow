import { PolicyFailureTracker } from "../application/policy-failure-tracker.js";
import type { OpenCodeV2SessionStats } from "./opencode-v2-stats.js";

export interface V2CircuitIdentity {
  readonly sessionId: string;
  readonly taskId?: string;
  readonly stepId?: string;
}

export type V2FailureKind = "policy_denial" | "tool_failure";

/**
 * Maps qualified OpenCode v2 observations to the Workflow-owned circuit
 * breaker. The v2 server remains an observation source: it never opens or
 * clears Workflow authority by itself. Session stats are telemetry and are
 * retained as a snapshot; per-event decisions drive the breaker.
 */
export class OpenCodeV2CircuitBreaker {
  readonly #tracker: PolicyFailureTracker;
  readonly #stats = new Map<string, OpenCodeV2SessionStats>();

  constructor(tracker = new PolicyFailureTracker()) {
    this.#tracker = tracker;
  }

  recordFailure(identity: V2CircuitIdentity, kind: V2FailureKind, classifier: string): number {
    return this.#tracker.recordFailure({
      sessionId: this.#key(identity),
      tool: classifier,
      reason: kind,
    });
  }

  recordSuccess(sessionId: string, taskId?: string, stepId?: string): void {
    this.#tracker.recordSuccess(this.#key({ sessionId, ...(taskId === undefined ? {} : { taskId }), ...(stepId === undefined ? {} : { stepId }) }));
  }

  observeStats(sessionId: string, stats: OpenCodeV2SessionStats): { readonly failedDelta: number; readonly totalFailed: number } {
    const previous = this.#stats.get(sessionId);
    this.#stats.set(sessionId, stats);
    const failedDelta = Math.max(0, stats.tools.failed - (previous?.tools.failed ?? 0));
    return { failedDelta, totalFailed: stats.tools.failed };
  }

  #key(identity: V2CircuitIdentity): string {
    return [identity.sessionId, identity.taskId ?? "-", identity.stepId ?? "-"].join(":");
  }

  isOpen(sessionId: string, taskId?: string, stepId?: string): boolean { return this.#tracker.isOpen(this.#key({ sessionId, ...(taskId === undefined ? {} : { taskId }), ...(stepId === undefined ? {} : { stepId }) })); }
  count(sessionId: string, taskId?: string, stepId?: string): number { return this.#tracker.count(this.#key({ sessionId, ...(taskId === undefined ? {} : { taskId }), ...(stepId === undefined ? {} : { stepId }) })); }
  clear(sessionId: string, taskId?: string, stepId?: string): void { this.#tracker.clear(this.#key({ sessionId, ...(taskId === undefined ? {} : { taskId }), ...(stepId === undefined ? {} : { stepId }) })); }
}