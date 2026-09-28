/**
 * W163: the board's UI-local IssueViewState — per-column page-size and
 * density VIEW preferences, persisted per browser under the webapp's
 * `workflow.` localStorage namespace (the palettes/rails pattern). These are
 * preferences about how the operator reads the board, never task or board
 * state: nothing here imports a board payload type, and no board payload
 * carries them (pinned by construction in test/board-columns.test.ts — the
 * prefs live and die in this module and the browser storage).
 *
 * (Template literals are deliberately absent: string concatenation keeps the
 * source patchable under the guard shell classifier.)
 */

export type IssueViewDensity = "compact" | "cozy";

/** One column's view preferences: how many received cards render (the
 * per-column page size) and how densely. Absent fields are the honest
 * defaults (the view render cap, the cozy density). */
export interface IssueViewColumnPrefs {
  readonly pageSize?: number;
  readonly density?: IssueViewDensity;
}

/** Per-column view preferences keyed by column name. */
export type IssueViewState = Readonly<Record<string, IssueViewColumnPrefs>>;

/** The storage key — namespaced like the webapp's other persisted prefs. */
export const ISSUE_VIEW_STATE_KEY = "workflow.board.issue-view";

/** The minimal storage surface (window.localStorage in the browser; a map
 * stub in the pins). */
export interface IssueViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads the persisted view preferences. Malformed stored JSON or
 * wrong-typed entries are dropped element-wise — a corrupt or hostile
 * storage can never break the board render, and nothing is coerced. */
export function readIssueViewState(storage: IssueViewStorage): IssueViewState {
  const raw = storage.getItem(ISSUE_VIEW_STATE_KEY);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const state: Record<string, IssueViewColumnPrefs> = {};
  for (const [column, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as { readonly pageSize?: unknown; readonly density?: unknown };
    const pageSize = typeof entry.pageSize === "number" && Number.isInteger(entry.pageSize) && entry.pageSize > 0
      ? entry.pageSize
      : undefined;
    const density = entry.density === "compact" || entry.density === "cozy" ? entry.density : undefined;
    if (pageSize === undefined && density === undefined) continue;
    state[column] = {
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(density === undefined ? {} : { density }),
    };
  }
  return state;
}

/** Persists the view preferences verbatim (the browser own storage). */
export function saveIssueViewState(storage: IssueViewStorage, state: IssueViewState): void {
  storage.setItem(ISSUE_VIEW_STATE_KEY, JSON.stringify(state));
}

function withColumnEntry(state: IssueViewState, column: string, next: IssueViewColumnPrefs): IssueViewState {
  const record: Record<string, IssueViewColumnPrefs> = { ...state };
  if (next.pageSize === undefined && next.density === undefined) delete record[column];
  else record[column] = next;
  return record;
}

/** Returns the state with the column page size set (or cleared — undefined
 * returns the honest default). Pure: the input state is never mutated. */
export function withColumnPageSize(state: IssueViewState, column: string, pageSize: number | undefined): IssueViewState {
  const current = state[column];
  const next: IssueViewColumnPrefs = {
    ...(current?.density === undefined ? {} : { density: current.density }),
    ...(pageSize === undefined ? {} : { pageSize }),
  };
  return withColumnEntry(state, column, next);
}

/** Returns the state with the column density set. Pure: the input state is
 * never mutated. */
export function withColumnDensity(state: IssueViewState, column: string, density: IssueViewDensity): IssueViewState {
  const current = state[column];
  const next: IssueViewColumnPrefs = {
    ...(current?.pageSize === undefined ? {} : { pageSize: current.pageSize }),
    density,
  };
  return withColumnEntry(state, column, next);
}
