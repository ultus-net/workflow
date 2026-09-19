import type { DecisionBrief, DiagnosticLesson, LearningOpportunity } from "../pedagogy/contracts.js";
import {
  createToolExpectedTurnSteering,
  type ToolExpectedTurnScope,
  type ToolExpectedTurnStats,
} from "./tool-expected-turn.js";

export type CodingSessionEvent =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "status"; readonly status: string }
  | { readonly type: "tool-proposal"; readonly tool: string; readonly subjects: readonly string[]; readonly callId?: string | undefined }
  | { readonly type: "tool-outcome"; readonly tool: string; readonly outcome: "succeeded" | "denied" | "failed"; readonly detail?: string; readonly callId?: string | undefined }
  | {
      /** Unified tool lifecycle for card-style surfaces; identified by callId. */
      readonly type: "tool";
      readonly callId: string;
      readonly title: string;
      readonly toolKind: string;
      readonly status: "pending" | "in_progress" | "completed" | "error" | "cancelled";
      readonly subjects: readonly string[];
      readonly rawInput?: string | undefined;
      readonly rawOutput?: string | undefined;
    }
  | { readonly type: "plan"; readonly entries: readonly PlanEntry[] }
  | { readonly type: "thought"; readonly text: string }
  | { readonly type: "session-info"; readonly title: string }
  | { readonly type: "decision-brief"; readonly brief: DecisionBrief }
  | { readonly type: "tutor-checkpoint"; readonly opportunity: LearningOpportunity }
  | { readonly type: "diagnostic-lesson"; readonly lesson: DiagnosticLesson }
  | { readonly type: "log"; readonly level: "debug" | "info" | "warning" | "error"; readonly message: string; readonly source?: string }
  | {
      /**
       * W047 (G7 context visibility): an agent-emitted context/usage signal
       * the session record keeps for observability — standard kinds the
       * driver doesn't otherwise project (e.g. `usage_update`) and
       * agent-custom notification methods (e.g. goose's usage channel).
       * Advisory only: context visibility is never upgraded to control.
       */
      readonly type: "agent-context";
      readonly kind: string;
      readonly payload: unknown;
    }
  | { readonly type: "completed"; readonly result: string }
  | { readonly type: "failed"; readonly reason: string };

/** One plan checklist entry, mirroring the ACP plan update shape. */
export interface PlanEntry {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export type CodingSessionState =
  | { readonly state: "idle" }
  | { readonly state: "running" }
  | { readonly state: "completed"; readonly result: string }
  | { readonly state: "failed"; readonly reason: string }
  | { readonly state: "cancelled" };

export interface CodingSessionImage {
  readonly mediaType: string;
  readonly data: string;
}

export interface CodingSessionDriver {
  start(prompt: string, emit: (event: CodingSessionEvent) => void, images?: readonly CodingSessionImage[]): Promise<void>;
  cancel(): Promise<void>;
  /** Optional cumulative provider usage (e.g. Cline session driver). */
  usageSnapshot?(): { inputTokens: number; outputTokens: number };
}

export interface ToolExpectedTurnPolicyOptions {
  readonly scope: () => ToolExpectedTurnScope;
  readonly expectedToolClass?: string;
  readonly maxRetries?: number;
  readonly onEscalate?: (info: { readonly message: string; readonly stats: ToolExpectedTurnStats }) => void;
}

export class WorkflowCodingSession {
  readonly #listeners = new Set<(event: CodingSessionEvent) => void>();
  #state: CodingSessionState = { state: "idle" };
  // Web-parity message queue (Tier 2): prompts submitted while a turn is
  // running are queued and submitted in order when the turn ends. Cancellation
  // clears the queue — a cancelled turn never auto-continues.
  #queue: readonly { readonly prompt: string; readonly images: readonly CodingSessionImage[] }[] = [];
  readonly #toolExpectedTurn: ReturnType<typeof createToolExpectedTurnSteering> | undefined;
  readonly #toolExpectedPolicy: ToolExpectedTurnPolicyOptions | undefined;

  constructor(
    readonly driver: CodingSessionDriver,
    options: {
      /**
       * W045 budget enforcement: consulted before every submit. A defined
       * reason refuses the prompt — the turn never starts, the queue is
       * never entered, and the reason surfaces as a failed event when the
       * session state still accepts events. Never a silent truncation.
       */
      readonly refusalGate?: () => string | undefined;
      /**
       * W070b slice 4b: bounded tool-expected-turn steering. When supplied,
       * a no-tool turn on a mutation-scoped in-progress task gets at most
       * `maxRetries` corrective re-prompts before escalating to the
       * operator. Opt-in; absent means no steering.
       */
      readonly toolExpectedTurn?: ToolExpectedTurnPolicyOptions;
    } = {},
  ) {
    this.#refusalGate = options.refusalGate;
    this.#toolExpectedPolicy = options.toolExpectedTurn;
    this.#toolExpectedTurn =
      options.toolExpectedTurn === undefined
        ? undefined
        : createToolExpectedTurnSteering({
            scope: options.toolExpectedTurn.scope,
            ...(options.toolExpectedTurn.expectedToolClass === undefined ? {} : { expectedToolClass: options.toolExpectedTurn.expectedToolClass }),
            ...(options.toolExpectedTurn.maxRetries === undefined ? {} : { maxRetries: options.toolExpectedTurn.maxRetries }),
          });
  }

  readonly #refusalGate: (() => string | undefined) | undefined;

  /** W070b slice 4b counters for monitor visibility (undefined when steering is off). */
  toolExpectedTurnStats(): ToolExpectedTurnStats | undefined {
    return this.#toolExpectedTurn?.stats();
  }

  subscribe(listener: (event: CodingSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  queuedPrompts(): readonly string[] {
    return this.#queue.map((entry) => entry.prompt);
  }

  async submit(prompt: string, images: readonly CodingSessionImage[] = []): Promise<void> {
    const refusal = this.#refusalGate?.();
    if (refusal !== undefined) {
      // Refuse fail-closed: the prompt is neither run nor queued, and the
      // reason is surfaced. (When the session is in the cancelled state the
      // event is intentionally dropped — the sticky violation is still
      // visible through the session-budget guard's own surface.)
      this.#emit({ type: "failed", reason: refusal });
      return;
    }
    if (this.#state.state === "running") {
      this.#queue = [...this.#queue, { prompt, images }];
      return;
    }
    await this.#runTurn(prompt, images);
    while (this.#queue.length > 0) {
      // A concurrent submit that arrives between turns may have moved the
      // session back to running; only the owning call drives the queue.
      if (this.#state.state !== "completed" && this.#state.state !== "failed" && this.#state.state !== "idle") return;
      const next = this.#queue[0];
      if (next === undefined) return;
      this.#queue = this.#queue.slice(1);
      await this.#runTurn(next.prompt, next.images);
    }
  }

  async #runTurn(prompt: string, images: readonly CodingSessionImage[]): Promise<void> {
    this.#state = { state: "running" };
    let currentPrompt = prompt;
    for (;;) {
      let sawToolCall = false;
      try {
        await this.driver.start(currentPrompt, (event) => {
          if (event.type === "tool" || event.type === "tool-proposal") sawToolCall = true;
          this.#emit(event);
        }, images);
      } catch (error) {
        if (this.#state.state === "running") {
          this.#emit({ type: "failed", reason: error instanceof Error ? error.message : "coding session failed" });
        }
        return;
      }
      const steering = this.#toolExpectedTurn;
      if (steering === undefined) return;
      // Only a completed turn can be a stall; a failed/cancelled turn is not.
      if (this.snapshot().state !== "completed") return;
      const decision = steering.observe({ hadToolCall: sawToolCall });
      if (decision.action === "none") return;
      if (decision.action === "escalate") {
        this.#emit({ type: "status", status: decision.message });
        this.#toolExpectedPolicy?.onEscalate?.({ message: decision.message, stats: steering.stats() });
        return;
      }
      this.#emit({ type: "status", status: `tool-expected turn: corrective re-prompt ${decision.attempt} (bounded steering, not enforcement)` });
      // The corrective turn is a fresh turn; reset state so its own outcome
      // is what surfaces to the session.
      this.#state = { state: "running" };
      currentPrompt = decision.prompt;
    }
  }

  async cancel(): Promise<void> {
    this.#queue = [];
    if (this.#state.state !== "running") return;
    try {
      await this.driver.cancel();
      this.#state = { state: "cancelled" };
    } catch (error) {
      this.#emit({ type: "failed", reason: error instanceof Error ? error.message : "coding session cancellation failed" });
    }
  }

  snapshot(): CodingSessionState {
    return this.#state;
  }

  #emit(event: CodingSessionEvent): void {
    if (this.#state.state === "cancelled") return;
    if (event.type === "completed") this.#state = { state: "completed", result: event.result };
    if (event.type === "failed") this.#state = { state: "failed", reason: event.reason };
    for (const listener of this.#listeners) listener(event);
  }
}
