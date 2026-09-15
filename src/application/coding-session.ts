import type { DecisionBrief, DiagnosticLesson, LearningOpportunity } from "../pedagogy/contracts.js";

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

export class WorkflowCodingSession {
  readonly #listeners = new Set<(event: CodingSessionEvent) => void>();
  #state: CodingSessionState = { state: "idle" };
  // Web-parity message queue (Tier 2): prompts submitted while a turn is
  // running are queued and submitted in order when the turn ends. Cancellation
  // clears the queue — a cancelled turn never auto-continues.
  #queue: readonly { readonly prompt: string; readonly images: readonly CodingSessionImage[] }[] = [];

  constructor(readonly driver: CodingSessionDriver) {}

  subscribe(listener: (event: CodingSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  queuedPrompts(): readonly string[] {
    return this.#queue.map((entry) => entry.prompt);
  }

  async submit(prompt: string, images: readonly CodingSessionImage[] = []): Promise<void> {
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
    try {
      await this.driver.start(prompt, (event) => this.#emit(event), images);
    } catch (error) {
      if (this.#state.state === "running") {
        this.#emit({ type: "failed", reason: error instanceof Error ? error.message : "coding session failed" });
      }
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
