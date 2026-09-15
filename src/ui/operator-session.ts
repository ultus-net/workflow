import type { CodingSessionEvent } from "../application/coding-session.js";

export type OperatorSessionItem =
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "action"; readonly action: string; readonly subjects: readonly string[] }
  | { readonly kind: "outcome"; readonly action: string; readonly outcome: "succeeded" | "denied" | "failed"; readonly detail?: string }
  | { readonly kind: "attention"; readonly text: string }
  | { readonly kind: "completion"; readonly outcome: "completed" | "failed"; readonly text: string };

/** Projects provider/session events into the stable semantics shown to operators. */
export function projectOperatorSessionEvent(event: CodingSessionEvent): OperatorSessionItem | undefined {
  if (event.type === "assistant") return { kind: "assistant", text: event.text };
  if (event.type === "tool-proposal") return { kind: "action", action: event.tool, subjects: event.subjects };
  if (event.type === "tool-outcome") {
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

  // Status, logs, and decision-brief metadata remain available to diagnostic
  // projections but do not belong in the default intent + actions transcript.
  return undefined;
}

/**
 * Appends an item to the operator transcript, coalescing streamed assistant
 * chunks into one message and suppressing a completion body that merely
 * repeats the assistant text already shown (whitespace-insensitive: chunk
 * boundaries differ from the final result string).
 */
export function appendOperatorItem(
  items: readonly OperatorSessionItem[],
  item: OperatorSessionItem,
): OperatorSessionItem[] {
  const last = items.at(-1);
  if (item.kind === "assistant" && last?.kind === "assistant") {
    return [...items.slice(0, -1), { kind: "assistant", text: last.text + item.text }];
  }
  if (
    item.kind === "completion" && item.outcome === "completed" &&
    last?.kind === "assistant" && normalizeText(last.text) === normalizeText(item.text)
  ) {
    return [...items, { kind: "completion", outcome: "completed", text: "" }];
  }
  return [...items, item];
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
