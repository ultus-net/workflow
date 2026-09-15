import type { DecisionBrief, DiagnosticLesson, LearningOpportunity } from "../pedagogy/contracts.js";

export type CodingSessionEvent =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "status"; readonly status: string }
  | { readonly type: "tool-proposal"; readonly tool: string; readonly subjects: readonly string[] }
  | { readonly type: "tool-outcome"; readonly tool: string; readonly outcome: "succeeded" | "denied" | "failed"; readonly detail?: string }
  | { readonly type: "decision-brief"; readonly brief: DecisionBrief }
  | { readonly type: "tutor-checkpoint"; readonly opportunity: LearningOpportunity }
  | { readonly type: "diagnostic-lesson"; readonly lesson: DiagnosticLesson }
  | { readonly type: "log"; readonly level: "debug" | "info" | "warning" | "error"; readonly message: string; readonly source?: string }
  | { readonly type: "completed"; readonly result: string }
  | { readonly type: "failed"; readonly reason: string };

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

  constructor(readonly driver: CodingSessionDriver) {}

  subscribe(listener: (event: CodingSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async submit(prompt: string, images: readonly CodingSessionImage[] = []): Promise<void> {
    if (this.#state.state === "running") throw new TypeError("coding session is already running");
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
