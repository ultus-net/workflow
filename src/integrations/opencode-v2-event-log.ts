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
    const entry: WorkflowExecutionEvent = { ...event, ...metadata, logId };
    this.#ids.add(logId);
    this.#entries.push(entry);
    return entry;
  }

  entries(): readonly WorkflowExecutionEvent[] { return [...this.#entries]; }

  replay(): readonly WorkflowExecutionEvent[] { return this.entries(); }
}