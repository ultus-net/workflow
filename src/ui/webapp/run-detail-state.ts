/**
 * W175 phase 2: the run detail panel's opener memory — a VIEW preference
 * persisted per browser through sessionStorage (the rail-state.ts
 * two-shape guarded pattern). One record: which run is open and the page
 * that opened it, so a reload restores the panel and the back affordance
 * names the page it returns to ("opened from Runs, back returns to Runs").
 * This is view state, never application state: nothing here imports a
 * payload type, and no payload carries it.
 *
 * The guard encloses BOTH storage-denial shapes — the window.sessionStorage
 * PROPERTY access itself (browsers throw on access in denied contexts) and
 * the getItem/setItem/removeItem CALLS (denied or at quota) — and a corrupt
 * record is dropped, never coerced: a hostile or corrupt storage can never
 * break the shell render.
 *
 * (Template literals are deliberately absent: string concatenation keeps
 * the source patchable under the guard shell classifier.)
 */

import { APP_VIEWS } from "./shell.js";

/** The persisted opener record: the run and the page that opened it. */
export interface RunDetailOpen {
  readonly opener: string;
  readonly runId: string;
}

/** The storage key — namespaced like the webapp's other persisted prefs. */
export const RUN_DETAIL_STATE_KEY = "workflow.runs.detail";

/** The minimal storage surface (window.sessionStorage in the browser; a map
 * stub in the pins). */
export interface RunDetailStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Reads the persisted opener. Malformed JSON, a wrong-typed field, an empty
 * run id, or an opener outside the shell's views is dropped — nothing is
 * coerced. */
export function readRunDetailOpen(storage: RunDetailStorage): RunDetailOpen | undefined {
  const raw = storage.getItem(RUN_DETAIL_STATE_KEY);
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as { readonly opener?: unknown; readonly runId?: unknown };
  if (typeof record.opener !== "string" || typeof record.runId !== "string") return undefined;
  if (record.runId.length === 0) return undefined;
  if (!(APP_VIEWS as readonly string[]).includes(record.opener)) return undefined;
  return { opener: record.opener, runId: record.runId };
}

/** Persists the opener verbatim (the browser's own storage). */
export function saveRunDetailOpen(storage: RunDetailStorage, open: RunDetailOpen): void {
  storage.setItem(RUN_DETAIL_STATE_KEY, JSON.stringify(open));
}

/** Clears the opener (the panel closed). */
export function clearRunDetailOpen(storage: RunDetailStorage): void {
  storage.removeItem(RUN_DETAIL_STATE_KEY);
}

/** Reads the persisted opener, degrading to no opener when the storage CALLS
 * refuse access: the shell render path must never throw on a storage the
 * browser withheld. */
export function readRunDetailOpenGuarded(storage: RunDetailStorage): RunDetailOpen | undefined {
  try {
    return readRunDetailOpen(storage);
  } catch {
    return undefined;
  }
}

/** Persists the opener, best-effort: a storage that refuses the write is a
 * no-op — the memory applies for this session only. */
export function saveRunDetailOpenGuarded(storage: RunDetailStorage, open: RunDetailOpen): void {
  try {
    saveRunDetailOpen(storage, open);
  } catch {
    // Private browsing or quota: persistence is best-effort.
  }
}

/** Clears the opener, best-effort. */
export function clearRunDetailOpenGuarded(storage: RunDetailStorage): void {
  try {
    clearRunDetailOpen(storage);
  } catch {
    // Private browsing or quota: persistence is best-effort.
  }
}

/** Window-level pair: the guards enclose the window.sessionStorage PROPERTY
 * access itself (access-time denial) as well as the calls, so the shell's
 * render and update paths never throw on a storage the browser withheld —
 * or on a context without a window at all (a non-browser surface degrades
 * to no opener too). */
export function readRunDetailOpenFromWindow(): RunDetailOpen | undefined {
  try {
    return readRunDetailOpenGuarded(window.sessionStorage);
  } catch {
    return undefined;
  }
}

export function saveRunDetailOpenToWindow(open: RunDetailOpen): void {
  try {
    saveRunDetailOpenGuarded(window.sessionStorage, open);
  } catch {
    // No window, access denied, or quota: persistence is best-effort.
  }
}

export function clearRunDetailOpenToWindow(): void {
  try {
    clearRunDetailOpenGuarded(window.sessionStorage);
  } catch {
    // No window, access denied, or quota: persistence is best-effort.
  }
}