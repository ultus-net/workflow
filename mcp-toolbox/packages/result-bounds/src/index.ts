/**
 * Server-side MCP result bounding (plan Task E1).
 *
 * The vendored-host patch bounded MCP results client-side (48k middle-cut);
 * hosts without the patch get nothing. Bounding in the server gives every
 * MCP-capable host the same token economy with no host-side code. The bound
 * applies to the model-visible `text` content only — `structuredContent`
 * stays exact so hosts reading structure keep full fidelity.
 */

/** Parity with the vendored patch's client-side truncation limit. */
export const DEFAULT_MAX_RESULT_CHARS = 48_000;

export interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Middle-cut bound: keeps the head and tail of the value (the beginning and
 * end of a result are almost always the informative parts — file listings,
 * summaries, and final statuses live there) and replaces the middle with a
 * visible truncation marker.
 */
export function boundText(value: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): BoundedText {
  if (value.length <= maxChars) return { text: value, truncated: false };
  const omitted = value.length - maxChars;
  const marker = `\n[... ${omitted} characters truncated (result-bounds middle-cut) ...]\n`;
  const budget = maxChars - marker.length;
  if (budget < 8) {
    // The cap is too small for a middle cut with a marker: keep the head only,
    // and never let the marker itself exceed the cap.
    const shortMarker = `[... +${omitted} truncated ...]`;
    if (shortMarker.length >= maxChars) {
      return { text: shortMarker.slice(0, maxChars), truncated: true };
    }
    const headBudget = maxChars - shortMarker.length;
    return { text: value.slice(0, headBudget) + shortMarker, truncated: true };
  }
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  return {
    text: value.slice(0, head) + marker + value.slice(value.length - tail),
    truncated: true,
  };
}

/**
 * Serialize a structured result and bound the JSON text for the content
 * block. Use for every tool result so total payload size is capped even when
 * per-item fields are already individually bounded.
 */
export function boundJsonText(value: unknown, maxChars: number = DEFAULT_MAX_RESULT_CHARS): BoundedText {
  return boundText(JSON.stringify(value), maxChars);
}

/**
 * Bound every text block of an MCP tool result in place (other fields pass
 * through untouched). Servers wrap their tool registration with this so the
 * whole tool surface inherits the bound without per-tool code.
 */
export function boundToolResultText(result: unknown, maxChars: number = DEFAULT_MAX_RESULT_CHARS): unknown {
  if (typeof result !== "object" || result === null) return result;
  const record = result as { content?: unknown };
  if (!Array.isArray(record.content)) return result;
  const content = record.content.map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const block = item as { type?: unknown; text?: unknown };
    if (block.type !== "text" || typeof block.text !== "string") return item;
    return { ...item, text: boundText(block.text, maxChars).text };
  });
  return { ...record, content };
}