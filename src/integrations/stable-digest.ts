import { createHash } from "node:crypto";

/**
 * Shared deterministic encoding for durability primitives (W199).
 *
 * The v2 event journal carries its own private `stableJson`
 * (`opencode-v2-event-log.ts:26-30`); this module is the reusable form so the
 * step journal, the durable timers, and the conductor checkpoint all digest
 * payloads the same way instead of growing three divergent encoders.
 *
 * Determinism rules: object keys are ordered by code-unit comparison (never
 * `localeCompare`, whose ordering is locale-dependent and would make the same
 * value digest differently on two hosts), arrays keep their order, and the
 * output carries no incidental whitespace.
 */

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // `undefined` is not valid JSON; encode it as null so a sparse object does
    // not silently produce the string "undefined" and collide with a real
    // string payload. A top-level undefined therefore digests like null.
    return value === undefined ? "null" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

/** sha256 hex over the stable-JSON encoding of `value`. */
export function digestValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
