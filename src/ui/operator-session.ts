import type { CodingSessionEvent, PlanEntry } from "../application/coding-session.js";

/** Reference to an image stored server-side (kept out of the polled transcript). */
export interface OperatorSessionImage {
  readonly id: string;
  readonly mediaType: string;
}

export type OperatorToolStatus = "pending" | "in_progress" | "completed" | "error" | "cancelled";

/** Typed tool-call card; updates for the same callId merge in place. */
export interface OperatorToolItem {
  readonly kind: "tool";
  readonly callId: string;
  readonly title: string;
  readonly toolKind: string;
  readonly status: OperatorToolStatus;
  readonly subjects: readonly string[];
  readonly rawInput?: string | undefined;
  readonly rawOutput?: string | undefined;
}

export type OperatorSessionItem =
  | { readonly kind: "user"; readonly text: string; readonly images?: readonly OperatorSessionImage[] }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "action"; readonly action: string; readonly subjects: readonly string[] }
  | { readonly kind: "outcome"; readonly action: string; readonly outcome: "succeeded" | "denied" | "failed"; readonly detail?: string }
  | { readonly kind: "attention"; readonly text: string }
  | { readonly kind: "plan"; readonly entries: readonly PlanEntry[] }
  | { readonly kind: "thinking"; readonly text: string }
  | OperatorToolItem
  | { readonly kind: "completion"; readonly outcome: "completed" | "failed"; readonly text: string };

/** Projects provider/session events into the stable semantics shown to operators. */
export function projectOperatorSessionEvent(event: CodingSessionEvent): OperatorSessionItem | undefined {
  if (event.type === "user") return { kind: "user", text: event.text };
  if (event.type === "assistant") return { kind: "assistant", text: event.text };
  if (event.type === "plan") return { kind: "plan", entries: event.entries };
  if (event.type === "thought") return { kind: "thinking", text: event.text };
  if (event.type === "tool") {
    return {
      kind: "tool",
      callId: event.callId,
      title: event.title,
      toolKind: event.toolKind,
      status: event.status,
      subjects: event.subjects,
      ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
      ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
    };
  }
  // Proposal/outcome pairs that carry a callId are already rendered as the
  // merged tool card above; only callId-less legacy drivers keep the
  // action/outcome lines.
  if (event.type === "tool-proposal") {
    if (event.callId !== undefined) return undefined;
    return { kind: "action", action: event.tool, subjects: event.subjects };
  }
  if (event.type === "tool-outcome") {
    if (event.callId !== undefined) return undefined;
    return {
      kind: "outcome",
      action: event.tool,
      outcome: event.outcome,
      ...(event.detail === undefined ? {} : { detail: event.detail }),
    };
  }
  if (event.type === "tutor-checkpoint") return { kind: "attention", text: event.opportunity.socraticQuestion };
  if (event.type === "diagnostic-lesson") {
    return { kind: "attention", text: `TS${event.lesson.code}: ${event.lesson.plainEnglishExplanation}` };
  }
  if (event.type === "completed") return { kind: "completion", outcome: "completed", text: event.result };
  if (event.type === "failed") return { kind: "completion", outcome: "failed", text: event.reason };

  // Status, logs, session-info metadata, and decision-brief remain available to
  // diagnostic projections but do not belong in the default intent + actions
  // transcript.
  return undefined;
}

/**
 * Appends an item to the operator transcript. Streamed assistant chunks
 * coalesce into one message; thought chunks accumulate into one thinking
 * block; tool cards merge by callId so status/output updates land in place;
 * a plan update replaces the trailing plan snapshot; a completion body that
 * merely repeats the assistant text is suppressed (whitespace-insensitive:
 * chunk boundaries differ from the final result string).
 */
export function appendOperatorItem(
  items: readonly OperatorSessionItem[],
  item: OperatorSessionItem,
): OperatorSessionItem[] {
  const last = items.at(-1);
  if (item.kind === "assistant" && last?.kind === "assistant") {
    return [...items.slice(0, -1), { kind: "assistant", text: last.text + item.text }];
  }
  if (item.kind === "user" && last?.kind === "user") {
    return [...items.slice(0, -1), { kind: "user", text: last.text + item.text }];
  }
  if (item.kind === "thinking" && last?.kind === "thinking") {
    return [...items.slice(0, -1), { kind: "thinking", text: last.text + item.text }];
  }
  if (item.kind === "plan" && last?.kind === "plan") {
    return [...items.slice(0, -1), item];
  }
  if (item.kind === "tool") {
    const index = lastToolIndex(items, item.callId);
    const previous = index === -1 ? undefined : items[index];
    if (index !== -1 && previous !== undefined && previous.kind === "tool") {
      const merged: OperatorToolItem = {
        kind: "tool",
        callId: previous.callId,
        title: previous.title,
        toolKind: previous.toolKind,
        status: item.status,
        subjects: previous.subjects,
        ...(item.rawInput !== undefined
          ? { rawInput: item.rawInput }
          : previous.rawInput !== undefined
            ? { rawInput: previous.rawInput }
            : {}),
        ...(item.rawOutput !== undefined
          ? { rawOutput: item.rawOutput }
          : previous.rawOutput !== undefined
            ? { rawOutput: previous.rawOutput }
            : {}),
      };
      return [...items.slice(0, index), merged, ...items.slice(index + 1)];
    }
  }
  if (
    item.kind === "completion" && item.outcome === "completed" &&
    last?.kind === "assistant" && normalizeText(last.text) === normalizeText(item.text)
  ) {
    return [...items, { kind: "completion", outcome: "completed", text: "" }];
  }
  return [...items, item];
}

function lastToolIndex(items: readonly OperatorSessionItem[], callId: string): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const candidate = items[index];
    if (candidate !== undefined && candidate.kind === "tool" && candidate.callId === callId) return index;
  }
  return -1;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}