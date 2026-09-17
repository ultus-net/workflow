import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { isReviewProvenanceRecord, type ReviewProvenanceRecord } from "../review/provenance.js";

/**
 * Durable review-provenance journal (TASKS.md W041). One NDJSON record per
 * line, append-only with a bounded trim; loads fail closed on any corrupt
 * line — a journal that cannot be trusted for replay cannot be silently
 * partially trusted either. The journal lives in hub state (never inside a
 * reviewed workspace: writing there would mutate the very fingerprint the
 * records are bound to).
 */

export interface ReviewProvenanceStore {
  append(record: ReviewProvenanceRecord): Promise<void>;
  records(): Promise<readonly ReviewProvenanceRecord[]>;
}

export const DEFAULT_REVIEW_PROVENANCE_MAX_RECORDS = 256;

export function createJsonReviewProvenanceStore(
  path: string,
  options?: { readonly maxRecords?: number },
): ReviewProvenanceStore {
  const maxRecords = options?.maxRecords ?? DEFAULT_REVIEW_PROVENANCE_MAX_RECORDS;
  return {
    async append(record: ReviewProvenanceRecord): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const file = await open(path, "a", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      if (maxRecords > 0) {
        const current = await this.records();
        if (current.length > maxRecords) {
          const keep = Math.ceil(maxRecords / 2);
          await rewrite(path, current.slice(current.length - keep));
        }
      }
    },
    async records(): Promise<readonly ReviewProvenanceRecord[]> {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const records: ReviewProvenanceRecord[] = [];
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        const parsed: unknown = JSON.parse(line);
        if (!isReviewProvenanceRecord(parsed)) {
          throw new TypeError(`invalid review provenance record in ${path}`);
        }
        records.push(parsed);
      }
      return records;
    },
  };
}

/** Atomic whole-file rewrite (temp + rename, JsonWorkflowStore pattern). */
async function rewrite(path: string, records: readonly ReviewProvenanceRecord[]): Promise<void> {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""), "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
