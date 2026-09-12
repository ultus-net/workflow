import type { ClineHostAdapter } from "../adapters/cline.js";
import type { CodingSessionDriver, CodingSessionEvent, CodingSessionImage } from "../application/coding-session.js";

interface ClineCoreSessionEvent {
  readonly type: string;
  readonly payload?: unknown;
}

export interface ClineCoreSessionClient {
  start(input: unknown): Promise<{
    readonly sessionId: string;
    readonly result?: { readonly text?: string };
  }>;
  subscribe(listener: (event: ClineCoreSessionEvent) => void): () => void;
  stop(sessionId: string): Promise<void>;
  readMessages?(sessionId: string): Promise<unknown[]>;
}

export interface ClineCoreSessionDriverOptions {
  readonly core: ClineCoreSessionClient;
  readonly startInput: (prompt: string, initialMessages?: readonly unknown[], userImages?: readonly string[]) => unknown;
  readonly hostAdapter: ClineHostAdapter;
  readonly resumeSessionId?: string;
  readonly onSessionId?: (sessionId: string) => void;
}

export class ClineSessionDriver implements CodingSessionDriver {
  #sessionId: string | undefined;
  #cancelRequested = false;
  #stopRequested = false;
  #failed = false;
  #reportedSessionId: string | undefined;
  #emit: ((event: CodingSessionEvent) => void) | undefined;
  readonly #deniedTools = new Map<string, number>();
  readonly #deniedToolCalls = new Set<string>();

  constructor(readonly options: ClineCoreSessionDriverOptions) {}

  async start(prompt: string, emit: (event: CodingSessionEvent) => void, images: readonly CodingSessionImage[] = []): Promise<void> {
    this.#sessionId = undefined;
    this.#cancelRequested = false;
    this.#stopRequested = false;
    this.#failed = false;
    this.#reportedSessionId = undefined;
    this.#deniedTools.clear();
    this.#deniedToolCalls.clear();
    this.#emit = emit;
    const unsubscribe = this.options.core.subscribe((event) => this.#translate(event, emit));
    try {
      let initialMessages: readonly unknown[] | undefined;
      if (this.options.resumeSessionId !== undefined) {
        try {
          if (this.options.core.readMessages === undefined) throw new Error("SDK history API unavailable");
          initialMessages = await this.options.core.readMessages(this.options.resumeSessionId);
        } catch (error) {
          throw new Error(`unable to restore Cline session ${this.options.resumeSessionId}: ${errorMessage(error)}`, { cause: error });
        }
      }
      const userImages = images.map(({ mediaType, data }) => `data:${mediaType};base64,${data}`);
      const result = await this.options.core.start(this.options.startInput(prompt, initialMessages, userImages.length === 0 ? undefined : userImages));
      this.#sessionId ??= result.sessionId;
      this.#reportSessionId();
      await this.#stopIfCancelled();
      if (!this.#cancelRequested && !this.#failed) emit({ type: "completed", result: result.result?.text ?? "" });
    } catch (error) {
      if (!this.#cancelRequested && !this.#failed) {
        emit({ type: "failed", reason: error instanceof Error ? error.message : "Cline session failed" });
      }
    } finally {
      this.#emit = undefined;
      unsubscribe();
    }
  }

  recordToolDenial(tool: string, reason: string, toolCallId?: string): void {
    if (this.#emit === undefined) return;
    if (toolCallId === undefined) this.#deniedTools.set(tool, (this.#deniedTools.get(tool) ?? 0) + 1);
    else this.#deniedToolCalls.add(toolCallId);
    this.#emit({ type: "tool-outcome", tool, outcome: "denied", detail: reason });
  }

  async cancel(): Promise<void> {
    this.#cancelRequested = true;
    await this.#stopIfCancelled();
  }

  #translate(event: ClineCoreSessionEvent, emit: (event: CodingSessionEvent) => void): void {
    const payload = record(event.payload);
    if (payload === undefined) return;
    const eventSessionId = stringValue(payload.sessionId);
    if (eventSessionId !== undefined) {
      if (this.#sessionId !== undefined && this.#sessionId !== eventSessionId) return;
      this.#sessionId ??= eventSessionId;
      this.#reportSessionId();
      void this.#stopIfCancelled();
    }
    if (event.type === "status") {
      const status = stringValue(payload.status);
      if (status !== undefined) emit({ type: "status", status });
      return;
    }
    if (event.type !== "agent_event") return;
    const agentEvent = record(payload.event);
    if (agentEvent === undefined) return;
    const type = stringValue(agentEvent.type);
    const contentType = stringValue(agentEvent.contentType);
    if (type === "content_start" && contentType === "text") {
      const text = stringValue(agentEvent.text);
      if (text !== undefined && text.length > 0) emit({ type: "assistant", text });
      return;
    }
    if (type === "content_start" && contentType === "tool") {
      const tool = stringValue(agentEvent.toolName);
      if (tool === undefined) return;
      try {
        const proposal = this.options.hostAdapter.proposalFromBeforeTool({ tool: { name: tool }, input: agentEvent.input });
        emit({ type: "tool-proposal", tool: proposal.tool, subjects: proposal.subjects });
      } catch (error) {
        emit({ type: "tool-outcome", tool, outcome: "failed", detail: error instanceof Error ? error.message : "invalid Cline tool proposal" });
      }
      return;
    }
    if (type === "content_end" && contentType === "tool") {
      const tool = stringValue(agentEvent.toolName);
      if (tool === undefined) return;
      const toolCallId = stringValue(agentEvent.toolCallId);
      if (toolCallId !== undefined && this.#deniedToolCalls.delete(toolCallId)) return;
      const denied = this.#deniedTools.get(tool) ?? 0;
      if (denied > 0) {
        if (denied === 1) this.#deniedTools.delete(tool);
        else this.#deniedTools.set(tool, denied - 1);
        return;
      }
      const error = stringValue(agentEvent.error);
      emit(error === undefined
        ? { type: "tool-outcome", tool, outcome: "succeeded" }
        : { type: "tool-outcome", tool, outcome: "failed", detail: error });
      return;
    }
    if (type === "tool-updated") {
      emit(logEventFromToolUpdate(agentEvent.update));
      return;
    }
    if (type === "error" && agentEvent.recoverable === false) {
      this.#failed = true;
      emit({ type: "failed", reason: errorMessage(agentEvent.error) });
    }
  }

  async #stopIfCancelled(): Promise<void> {
    if (!this.#cancelRequested || this.#sessionId === undefined || this.#stopRequested) return;
    this.#stopRequested = true;
    await this.options.core.stop(this.#sessionId);
  }

  #reportSessionId(): void {
    if (this.#sessionId === undefined || this.#reportedSessionId === this.#sessionId) return;
    this.#reportedSessionId = this.#sessionId;
    this.options.onSessionId?.(this.#sessionId);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

/**
 * Maps a tool `emitUpdate` payload to a session log event. MCP notifications
 * forwarded by the Workflow-patched Cline MCP client carry {server, method,
 * params}; plain tool updates (e.g. bash output chunks) pass through as
 * info-level logs. See patches/cline-cli-v3.0.61-workflow.patch.
 */
function logEventFromToolUpdate(update: unknown): CodingSessionEvent {
  const payload = record(update) ?? {};
  const server = stringValue(payload.server);
  const method = stringValue(payload.method);
  const params = record(payload.params);
  if (method === "notifications/message" && params !== undefined) {
    const data = params.data;
    return {
      type: "log",
      level: logLevel(stringValue(params.level)),
      message: typeof data === "string" ? data : JSON.stringify(data ?? params),
      ...(server === undefined ? {} : { source: server }),
    };
  }
  if (method === "notifications/progress" && params !== undefined) {
    const progress = typeof params.progress === "number" ? params.progress : undefined;
    const total = typeof params.total === "number" ? params.total : undefined;
    const label = stringValue(params.message) ?? "progress";
    const detail = progress === undefined ? "" : total === undefined ? ` (${progress})` : ` (${progress}/${total})`;
    return { type: "log", level: "info", message: `${label}${detail}`, ...(server === undefined ? {} : { source: server }) };
  }
  const message = stringValue(payload.output) ?? stringValue(payload.message) ?? JSON.stringify(payload);
  return { type: "log", level: "info", message, ...(server === undefined ? {} : { source: server }) };
}

function logLevel(level: string | undefined): "debug" | "info" | "warning" | "error" {
  switch (level) {
    case "debug": return "debug";
    case "warning": return "warning";
    case "error": case "critical": case "alert": case "emergency": return "error";
    default: return "info";
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  const candidate = record(value);
  return stringValue(candidate?.message) ?? stringValue(value) ?? "Cline session failed";
}
