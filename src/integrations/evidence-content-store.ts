/**
 * W158 (the capture half of "work products over evidence"): the bounded
 * integration-layer content store behind the kernel's evidence content
 * REFERENCES. The kernel evidence record carries only the reference; this
 * store owns the bytes — same bounded-eviction discipline as the web image
 * store (24 entries, oldest evicted first) plus a per-entry byte cap, so a
 * huge capture is refused (honest absence: the evidence record simply has no
 * content; a fabricated empty reference would be worse). The kernel reads
 * none of this: capture lives in the integration layer, exactly where the
 * environment produced the output.
 */

export interface StoredEvidenceContent {
  readonly ref: string;
  readonly kind: "test-output" | "screenshot";
  readonly mediaType: string;
  readonly bytes: string;
  readonly byteSize: number;
}

export interface EvidenceContentStore {
  /** Stores bounded content; resolves undefined when the payload exceeds the
   * per-entry cap (never a truncated or fabricated reference). */
  put(kind: "test-output" | "screenshot", mediaType: string, payload: string): StoredEvidenceContent | undefined;
  get(ref: string): StoredEvidenceContent | undefined;
  size(): number;
}

const MAX_ENTRIES = 24;
const MAX_BYTES = 256 * 1024;

export function createEvidenceContentStore(options?: {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}): {
  put(kind: "test-output" | "screenshot", mediaType: string, payload: string): StoredEvidenceContent | undefined;
  get(ref: string): StoredEvidenceContent | undefined;
  size(): number;
} {
  const maxEntries = options?.maxEntries ?? MAX_ENTRIES;
  const maxBytes = options?.maxBytes ?? MAX_BYTES;
  const entries = new Map<string, StoredEvidenceContent>();
  let counter = 0;
  return {
    put(kind, mediaType, payload) {
      const byteSize = Buffer.byteLength(payload, "utf8");
      if (byteSize > maxBytes) return undefined;
      counter += 1;
      const ref = `content:${counter}`;
      const stored: StoredEvidenceContent = { ref, kind, mediaType, bytes: payload, byteSize };
      entries.set(ref, stored);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return stored;
    },
    get(ref) {
      return entries.get(ref);
    },
    size() {
      return entries.size;
    },
  };
}

export type EvidenceContentStoreType = ReturnType<typeof createEvidenceContentStore>;
