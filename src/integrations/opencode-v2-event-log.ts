import { createHash } from "node:crypto";

export interface OpenCodeV2ObservedEvent {
  readonly id?: string;
  readonly type: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly agentId?: string;
  readonly observedAt: string;
  readonly payload: unknown;
}

export interface WorkflowExecutionEvent extends OpenCodeV2ObservedEvent {
  readonly logId: string;
  /** Normalized Workflow kind; sourced from the OpenCode event type. */
  readonly kind: string;
  readonly mutationEpoch?: number;
  readonly inputDigest?: string;
  readonly outputDigest?: string;
  readonly taskId?: string;
  readonly stepId?: string;
  readonly result?: "passed" | "failed" | "unknown";
  readonly authority?: "environment" | "host" | "mcp" | "reviewer";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

/**
 * Append-only v2 event journal. The host event is observation only; callers
 * must separately authorize and admit evidence. Until a pinned v2 release
 * proves stable event IDs, the fallback log id is digest-bound and replay
 * ambiguity remains observable rather than silently deduplicated.
 */
export class OpenCodeV2EventLog {
  readonly #entries: WorkflowExecutionEvent[] = [];
  readonly #ids = new Set<string>();

  append(event: OpenCodeV2ObservedEvent, metadata: Pick<WorkflowExecutionEvent, "taskId" | "stepId" | "result" | "authority" | "inputDigest" | "outputDigest"> = {}): WorkflowExecutionEvent | undefined {
    const body = stableJson(event.payload);
    const logId = event.id === undefined
      ? createHash("sha256").update(`${event.sessionId}\0${event.type}\0${event.observedAt}\0${body}`).digest("hex")
      : `${event.sessionId}:${event.id}`;
    if (this.#ids.has(logId)) return undefined;
    const entry: WorkflowExecutionEvent = { ...event, ...metadata, logId, kind: event.type };
    this.#ids.add(logId);
    this.#entries.push(entry);
    return entry;
  }

  entries(): readonly WorkflowExecutionEvent[] { return [...this.#entries]; }

  replay(): readonly WorkflowExecutionEvent[] { return this.entries(); }
}

/** Consume a qualified v2 SSE response without assigning authority to it. */
export async function consumeOpenCodeV2EventStream(
  response: Response,
  log: OpenCodeV2EventLog,
  observedAt: () => string = () => new Date().toISOString(),
): Promise<number> {
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new TypeError("OpenCode v2 event response is not a qualified SSE stream");
  }
  if (response.body === null) throw new TypeError("OpenCode v2 event response has no body");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let count = 0;
  for (;;) {
    const part = await reader.read();
    buffer += part.value ?? "";
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split(/\r?\n/);
      const streamId = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data.length === 0 || data === "[DONE]") continue;
      let payload: unknown;
      try { payload = JSON.parse(data) as unknown; } catch { continue; }
      if (typeof payload !== "object" || payload === null) continue;
      const record = payload as Record<string, unknown>;
      // Resolve the properties source across the observed generations: v2 rides
      // `data` (live, 2.0.10), v1 the contract `properties`, and the historical
      // SSE wrapper nests under `payload`. Without the `data` case the journal
      // silently drops every v2 event (session id never resolves).
      const nested = typeof record.payload === "object" && record.payload !== null ? record.payload as Record<string, unknown> : record;
      const properties = typeof nested.properties === "object" && nested.properties !== null ? nested.properties as Record<string, unknown>
        : typeof nested.data === "object" && nested.data !== null ? nested.data as Record<string, unknown>
          : nested;
      const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : typeof properties.sessionId === "string" ? properties.sessionId : undefined;
      const type = typeof nested.type === "string" ? nested.type : typeof record.type === "string" ? record.type : undefined;
      if (sessionId === undefined || type === undefined) continue;
      const entry = log.append({
        ...(typeof record.id === "string" ? { id: record.id } : streamId === undefined ? {} : { id: streamId }),
        type,
        sessionId,
        ...(typeof properties.parentID === "string" ? { parentSessionId: properties.parentID } : {}),
        observedAt: observedAt(),
        payload,
      });
      if (entry !== undefined) count += 1;
    }
    if (part.done) break;
  }
  return count;
}