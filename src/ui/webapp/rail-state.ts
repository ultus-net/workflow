/**
 * W174 phase 1a: the shell rail's collapsed preference — a VIEW preference
 * persisted per browser under the webapp's `workflow.` localStorage
 * namespace (the palettes/rails/issue-view-state pattern). This is a
 * preference about how the operator reads the shell, never application
 * state: nothing here imports a payload type, and no payload carries it.
 *
 * The guard encloses BOTH storage-denial shapes, degrading to the honest
 * default: the window.localStorage PROPERTY access itself (browsers throw
 * on access in denied contexts) and the getItem/setItem CALLS (denied or
 * at quota). A corrupt record is dropped element-wise — a hostile or
 * corrupt storage can never break the shell render.
 *
 * (Template literals are deliberately absent: string concatenation keeps
 * the source patchable under the guard shell classifier.)
 */

/** The rail's persisted view preference. An absent flag is the honest
 * default (the expanded rail). */
export interface RailState {
  readonly collapsed?: boolean;
}

/** The storage key — namespaced like the webapp's other persisted prefs. */
export const RAIL_STATE_KEY = "workflow.shell.rail";

/** The minimal storage surface (window.localStorage in the browser; a map
 * stub in the pins). */
export interface RailStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads the persisted rail state. Malformed stored JSON or a wrong-typed
 * flag is dropped — nothing is coerced. */
export function readRailState(storage: RailStorage): RailState {
  const raw = storage.getItem(RAIL_STATE_KEY);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as { readonly collapsed?: unknown };
  return record.collapsed === true || record.collapsed === false
    ? { collapsed: record.collapsed }
    : {};
}

/** Persists the rail state verbatim (the browser's own storage). */
export function saveRailState(storage: RailStorage, state: RailState): void {
  storage.setItem(RAIL_STATE_KEY, JSON.stringify(state));
}

/** Reads the persisted rail state, degrading to the honest default — the
 * same empty state the absent-key and corrupt-read paths return — when the
 * storage CALLS refuse access (denied or at quota): the shell render path
 * must never throw on a storage the browser withheld. */
export function readRailStateGuarded(storage: RailStorage): RailState {
  try {
    return readRailState(storage);
  } catch {
    return {};
  }
}

/** Persists the rail state verbatim, best-effort: a storage that refuses
 * the write (denied or at quota) is a no-op — the preference applies for
 * this session only, and the shell's update path never throws. */
export function saveRailStateGuarded(storage: RailStorage, state: RailState): void {
  try {
    saveRailState(storage, state);
  } catch {
    // Private browsing or quota: persistence is best-effort.
  }
}

/** Window-level pair: the guards enclose the window.localStorage PROPERTY
 * access itself (access-time denial) as well as the calls, so the shell's
 * render and update paths never throw on a storage the browser withheld —
 * or on a context without a window at all (a non-browser surface degrades
 * to the honest default too). */
export function readRailStateFromWindow(): RailState {
  try {
    return readRailStateGuarded(window.localStorage);
  } catch {
    return {};
  }
}

export function saveRailStateToWindow(state: RailState): void {
  try {
    saveRailStateGuarded(window.localStorage, state);
  } catch {
    // No window, access denied, or quota: persistence is best-effort.
  }
}

/** Returns the state with the collapsed flag set. Pure: the input state is
 * never mutated. */
export function withRailCollapsed(state: RailState, collapsed: boolean): RailState {
  return { ...state, collapsed };
}
