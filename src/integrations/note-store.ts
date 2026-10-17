/**
 * W212 (the hub Note view, decision-brief Option A): the bounded, path-confined
 * note store behind the hub's `/notes` and `/note-read` routes. Augur-produced
 * notes are markdown files under `<WORKFLOW_ASSISTANT_WORKSPACE>/notes`, with an
 * optional admission sidecar `<slug>.json` beside each `<slug>.md`.
 *
 * The discipline mirrors `/workspace` (W197) and the evidence content store
 * (W158, `evidence-content-store.ts`):
 *  - BOUNDED: a max entry count for the listing (`truncated: true` when the
 *    bound is hit) and a per-note byte cap on the read.
 *  - CONFINED: the read accepts only a bare `.md` basename — any `/`, `\`,
 *    `..`, or absolute resolution is refused before the filesystem is touched.
 *  - NEVER FOLLOWS SYMLINKS: every entry resolves with lstat; a symlink is
 *    skipped (listing) or answered as unknown (read).
 *  - FABRICATES NOTHING: a missing or malformed sidecar means `meta: null`
 *    (the store never invents a title); a missing note is a named `unknown`
 *    outcome the route answers as an honest 404; an over-cap note is a named
 *    `over-cap` outcome the route answers as an honest 413.
 *
 * Pure-ish fs reads with an injectable root so the store unit-tests against a
 * temp directory; the same store backs the hub capability composition
 * (`src/cli/hub.ts`).
 */

import { lstatSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** The admission sidecar beside `<slug>.md`. Every field is optional; a
 * missing or malformed sidecar is `null`, never a fabricated record. */
export interface NoteMeta {
  readonly title?: string;
  readonly source?: string;
  readonly producedAt?: string;
  readonly runId?: string;
  readonly blocked?: boolean;
  readonly findings?: number;
}

/** One markdown note in the notes subtree, with its sidecar metadata. */
export interface NoteEntry {
  readonly name: string;
  readonly byteSize: number;
  readonly modifiedMs: number;
  /** The parsed sidecar, or null when it is absent or unreadable. */
  readonly meta: NoteMeta | null;
}

/** The bounded listing `/notes` returns. */
export interface NoteListing {
  /** The notes subtree (absolute path): `<workspace>/notes`. */
  readonly root: string;
  /** True when the enumeration bound stopped the listing early. */
  readonly truncated: boolean;
  readonly entries: readonly NoteEntry[];
}

/** One note's content read, as `/note-read` returns it. */
export interface NoteContent {
  readonly name: string;
  readonly byteSize: number;
  readonly modifiedMs: number;
  readonly meta: NoteMeta | null;
  readonly body: string;
}

/** The honest outcome of a single-note read. Each non-ok kind carries the
 * named reason the route maps to its status; no kind is a fabricated empty
 * success. */
export type NoteReadOutcome =
  | { readonly kind: "ok"; readonly note: NoteContent }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "over-cap"; readonly error: string };

export interface NoteStore {
  /** The bounded `.md` listing of the notes subtree. A missing subtree reads
   * as the honest empty listing (no notes produced yet), never an error. */
  list(): NoteListing;
  /** One note's content, confined to a bare `.md` basename under the root. */
  read(name: string): NoteReadOutcome;
}

const MAX_ENTRIES = 500;
/** Mirrors the evidence content store's per-entry cap (256 KiB). */
const MAX_BYTES = 256 * 1024;

/** Parse the admission sidecar defensively: only properly-typed known fields
 * survive; anything else is the honest absence. */
function parseSidecar(raw: string): NoteMeta | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.source === "string" ? { source: record.source } : {}),
      ...(typeof record.producedAt === "string" ? { producedAt: record.producedAt } : {}),
      ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
      ...(typeof record.blocked === "boolean" ? { blocked: record.blocked } : {}),
      ...(typeof record.findings === "number" && Number.isFinite(record.findings) ? { findings: record.findings } : {}),
    };
  } catch {
    return null;
  }
}

export function createNoteStore(options: {
  readonly root: string;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}): NoteStore {
  const root = options.root;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? MAX_BYTES;

  /** lstat a name inside the root. A symlink never passes (never followed);
   * a vanished entry (the readdir/lstat race) is skipped. Returns undefined
   * when the path is not a regular file. */
  const regularFile = (path: string): { readonly size: number; readonly modifiedMs: number } | undefined => {
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      return undefined;
    }
    if (!stats.isFile()) return undefined;
    return { size: stats.size, modifiedMs: Math.floor(stats.mtimeMs) };
  };

  const sidecarFor = (name: string): NoteMeta | null => {
    // `<slug>.json` beside `<slug>.md`; missing or unreadable is `null`.
    const path = join(root, name.slice(0, -".md".length) + ".json");
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    return parseSidecar(raw);
  };

  /** The read's confinement gate: only a bare `.md` basename may ever reach
   * the join — no separators, no `..`, no absolute resolution. */
  const confine = (name: string): { readonly path: string } | { readonly error: string } => {
    if (!name.endsWith(".md")) return { error: "note names must end in .md" };
    if (name.includes("/") || name.includes("\\")) return { error: "note names are bare basenames (no path separators)" };
    if (name.includes("..")) return { error: "note names must not contain .." };
    if (name.slice(0, -".md".length).length === 0) return { error: "note basenames are never empty" };
    return { path: join(root, name) };
  };

  return {
    list() {
      // A missing subtree is the honest empty listing (no notes produced yet).
      if (!existsSync(root)) return { root, truncated: false, entries: [] };
      const names = readdirSync(root).filter((name) => name.endsWith(".md"));
      // Deterministic, locale-independent order: plain code-unit `<`.
      names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const truncated = names.length > maxEntries;
      const bounded = truncated ? names.slice(0, maxEntries) : names;
      const entries: NoteEntry[] = [];
      for (const name of bounded) {
        const file = regularFile(join(root, name));
        if (file === undefined) continue; // symlink, directory, or vanished: skipped, never followed
        entries.push({ name, byteSize: file.size, modifiedMs: file.modifiedMs, meta: sidecarFor(name) });
      }
      return { root, truncated, entries };
    },
    read(name) {
      const confined = confine(name);
      if ("error" in confined) return { kind: "invalid", error: confined.error };
      const file = regularFile(confined.path);
      if (file === undefined) return { kind: "unknown" };
      if (file.size > maxBytes) {
        return { kind: "over-cap", error: "note body exceeds the " + Math.floor(maxBytes / 1024) + " KiB per-note cap (" + file.size + " bytes); read it from the filesystem directly" };
      }
      return {
        kind: "ok",
        note: {
          name,
          byteSize: file.size,
          modifiedMs: file.modifiedMs,
          meta: sidecarFor(name),
          body: readFileSync(confined.path, "utf8"),
        },
      };
    },
  };
}
