import type { CodingSessionDriver, CodingSessionEvent, CodingSessionImage } from "../application/coding-session.js";

export interface OpenCodeSessionClient {
  create(input: { readonly body?: Record<string, never> }): Promise<OpenCodeResponse<{ readonly id: string }>>;
  prompt(input: { readonly path: { readonly id: string }; readonly body: { readonly parts: readonly OpenCodePromptPart[] } }): Promise<OpenCodeResponse<{ readonly parts: readonly unknown[] }>>;
  abort(input: { readonly path: { readonly id: string } }): Promise<OpenCodeResponse<boolean>>;
  readonly event: {
    subscribe(): Promise<{ readonly stream: AsyncIterable<unknown> }>;
  };
}

export type OpenCodePromptPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly mime: string; readonly url: string };

interface OpenCodeResponse<T> {
  readonly data?: T;
  readonly error?: unknown;
}

export class OpenCodeSessionDriver implements CodingSessionDriver {
  #sessionId: string | undefined;
  #cancelRequested = false;

  constructor(readonly client: OpenCodeSessionClient) {}

  async start(prompt: string, emit: (event: CodingSessionEvent) => void, images: readonly CodingSessionImage[] = []): Promise<void> {
    this.#cancelRequested = false;
    const createResult = await this.client.create({});
    if (createResult.error !== undefined) throw new Error(`OpenCode session creation failed: ${errorMessage(createResult.error)}`);
    const session = createResult.data;
    if (session === undefined) throw new Error("OpenCode session creation returned no data");
    this.#sessionId = session.id;
    const events = await this.client.event.subscribe();
    const consumeEvents = this.#consumeEvents(events.stream, session.id, emit);
    const eventFailure = consumeEvents.then<never>(
      () => new Promise<never>(() => undefined),
      (error: unknown) => Promise.reject(error),
    );
    try {
      if (this.#cancelRequested) return;
      const parts: OpenCodePromptPart[] = [
        { type: "text", text: prompt },
        ...images.map(({ mediaType, data }) => ({ type: "file" as const, mime: mediaType, url: `data:${mediaType};base64,${data}` })),
      ];
      const promptResult = await Promise.race([
        this.client.prompt({ path: { id: session.id }, body: { parts } }),
        eventFailure,
      ]);
      if (promptResult.error !== undefined) throw new Error(`OpenCode prompt failed: ${errorMessage(promptResult.error)}`);
      const result = promptResult.data;
      if (result === undefined) throw new Error("OpenCode prompt returned no data");
      if (!this.#cancelRequested) emit({ type: "completed", result: result.parts.map(textFromPart).filter(Boolean).join("\n") });
    } catch (error) {
      if (!this.#cancelRequested) emit({ type: "failed", reason: errorMessage(error) });
    } finally {
      void eventFailure;
    }
  }

  async cancel(): Promise<void> {
    this.#cancelRequested = true;
    if (this.#sessionId !== undefined) {
      const result = await this.client.abort({ path: { id: this.#sessionId } });
      if (result.error !== undefined) throw new Error(`OpenCode abort failed: ${errorMessage(result.error)}`);
      if (result.data !== true) throw new Error("OpenCode abort returned no success result");
    }
  }

  async #consumeEvents(stream: AsyncIterable<unknown>, sessionId: string, emit: (event: CodingSessionEvent) => void): Promise<void> {
    for await (const event of stream) {
      if (this.#cancelRequested || this.#sessionId !== sessionId) return;
      this.#translate(event, sessionId, emit);
    }
  }

  #translate(event: unknown, sessionId: string, emit: (event: CodingSessionEvent) => void): void {
    const value = record(event);
    const properties = record(value?.properties);
    if (value === undefined || properties === undefined) return;
    if (value.type === "session.status") {
      if (stringValue(properties.sessionID) !== sessionId) return;
      const status = stringValue(record(properties.status)?.type);
      if (status !== undefined) emit({ type: "status", status });
      return;
    }
    if (value.type === "session.error") {
      if (properties.sessionID !== undefined && stringValue(properties.sessionID) !== sessionId) return;
      emit({ type: "failed", reason: errorMessage(properties.error) });
      return;
    }
    if (value.type !== "message.part.updated") return;
    const part = record(properties.part);
    if (stringValue(part?.sessionID) !== sessionId) return;
    if (part?.type === "text") {
      const text = stringValue(properties.delta) ?? stringValue(part.text);
      if (text !== undefined && text.length > 0) emit({ type: "assistant", text });
      return;
    }
    if (part?.type !== "tool") return;
    const tool = stringValue(part.tool);
    const state = record(part.state);
    if (tool === undefined || state === undefined) return;
    if (state.status === "running") {
      emit({ type: "tool-proposal", tool, subjects: [] });
    } else if (state.status === "completed") {
      emit({ type: "tool-outcome", tool, outcome: "succeeded" });
    } else if (state.status === "error") {
      const detail = stringValue(state.error);
      emit(detail === undefined
        ? { type: "tool-outcome", tool, outcome: "failed" }
        : { type: "tool-outcome", tool, outcome: "failed", detail });
    }
  }
}

function textFromPart(part: unknown): string {
  const value = record(part);
  return value?.type === "text" ? stringValue(value.text) ?? "" : "";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  const candidate = record(value);
  return stringValue(record(candidate?.data)?.message) ?? stringValue(candidate?.message) ?? stringValue(value) ?? "OpenCode session failed";
}
