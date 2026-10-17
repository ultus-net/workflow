/**
 * W212 — the Notes page (decision-brief Option A): augur-produced notes under
 * the shared assistant workspace's `notes/` subtree, projected live. The list
 * comes from the hub's bounded `POST /notes` read (relayed as `GET /api/notes`);
 * a selected note's body comes from the path-confined `POST /note-read`
 * (relayed as `GET /api/note?name=...`).
 *
 * The view fabricates nothing: the full state cycle renders — loading
 * (`notes === undefined`, no reason), error (`reason`), empty (no notes yet),
 * and populated — plus the hub's truncation notice. Sidecar metadata renders
 * when present and is marked absent when not (`meta === null`), never invented.
 * A selected note ALSO cycles: loading / error (the relay's answer verbatim,
 * including the hub's honest 413 over-cap refusal) / populated body.
 *
 * (Template literals are deliberately absent: string concatenation keeps the
 * source patchable under the guard shell classifier.)
 */

import { formatBytes, formatModified } from "./workspace-view.js";

/** The admission sidecar beside `<slug>.md`, as the hub parses it. */
export interface NoteMeta {
  readonly title?: string;
  readonly source?: string;
  readonly producedAt?: string;
  readonly runId?: string;
  readonly blocked?: boolean;
  readonly findings?: number;
}

/** One note in the hub's bounded listing. */
export interface NoteEntry {
  readonly name: string;
  readonly byteSize: number;
  readonly modifiedMs: number;
  /** The parsed sidecar, or null when it is absent or unreadable. */
  readonly meta: NoteMeta | null;
}

/** The bounded listing the hub's /notes read returns. */
export interface NoteListing {
  /** The notes subtree (absolute path). */
  readonly root: string;
  /** True when the hub's enumeration bound stopped the listing early. */
  readonly truncated: boolean;
  readonly entries: readonly NoteEntry[];
}

/** One note's content read, as the hub's /note-read returns it. */
export interface NoteContent {
  readonly name: string;
  readonly byteSize: number;
  readonly modifiedMs: number;
  readonly meta: NoteMeta | null;
  readonly body: string;
}

/** The sidecar block for one note row or the selected note: the present
 * fields verbatim, or the honest absent marker — never a placeholder title. */
function NoteMetaFields({ meta }: { readonly meta: NoteMeta }) {
  return (
    <>
      {meta.title !== undefined && <span className="note-meta-field note-meta-title">{meta.title}</span>}
      {meta.source !== undefined && <span className="note-meta-field note-meta-source">source: {meta.source}</span>}
      {meta.producedAt !== undefined && <span className="note-meta-field note-meta-produced">produced: {meta.producedAt}</span>}
      {meta.runId !== undefined && <span className="note-meta-field note-meta-run">run: {meta.runId}</span>}
      {meta.blocked !== undefined && <span className="note-meta-field note-meta-blocked">{meta.blocked ? "held by verification" : "not blocked"}</span>}
      {meta.findings !== undefined && <span className="note-meta-field note-meta-findings">{meta.findings} findings</span>}
    </>
  );
}

export function NoteView({ notes, reason, selected, note, noteReason, onSelect }: {
  readonly notes: NoteListing | undefined;
  readonly reason?: string | undefined;
  /** The selected note's name, when one is open. */
  readonly selected?: string | undefined;
  /** The selected note's content read; undefined while it loads or when absent. */
  readonly note?: NoteContent | undefined;
  /** The content read's failure reason, verbatim from the relay. */
  readonly noteReason?: string | undefined;
  readonly onSelect?: ((name: string | undefined) => void) | undefined;
}) {
  if (notes === undefined && reason === undefined) {
    return (
      <section className="sessions-view note-view" aria-label="Notes">
        <header className="sessions-view-head">
          <h2>Notes</h2>
        </header>
        <p className="muted sessions-empty-note note-loading">loading notes…</p>
      </section>
    );
  }
  if (notes === undefined) {
    return (
      <section className="sessions-view note-view" aria-label="Notes">
        <header className="sessions-view-head">
          <h2>Notes</h2>
        </header>
        <p className="muted sessions-empty-note note-error" role="status">
          notes unavailable ({reason})
        </p>
      </section>
    );
  }
  return (
    <section className="sessions-view note-view" aria-label="Notes">
      <header className="sessions-view-head">
        <h2>Notes</h2>
        <p className="muted sessions-empty-note">
          notes augur produced into the shared assistant workspace; a bounded listing, plus one note's body on selection
        </p>
      </header>
      <p className="workspace-root note-root">
        <span className="workspace-field-label">root</span>
        <code className="workspace-root-path" title={notes.root}>{notes.root}</code>
      </p>
      {notes.truncated && (
        <p className="muted sessions-empty-note note-truncated" role="status">
          listing truncated: the notes subtree holds more entries than the hub enumerates in one read
        </p>
      )}
      <table className="usage-table note-table" aria-label="Notes">
        <thead>
          <tr>
            <th scope="col">name</th>
            <th scope="col">metadata</th>
            <th scope="col">size</th>
            <th scope="col">modified</th>
          </tr>
        </thead>
        <tbody>
          {notes.entries.map((entry) => (
            <tr key={entry.name} className={"note-row" + (entry.name === selected ? " note-row-selected" : "")}>
              <td className="note-name" title={entry.name}>
                {onSelect === undefined ? entry.name : (
                  <button type="button" className="note-open btn-ghost" onClick={() => onSelect(entry.name)}>{entry.name}</button>
                )}
              </td>
              <td className="note-meta">
                {entry.meta === null
                  ? <span className="muted note-meta-absent">metadata absent</span>
                  : <NoteMetaFields meta={entry.meta} />}
              </td>
              <td className="note-size">{formatBytes(entry.byteSize)}</td>
              <td className="note-modified session-time">{formatModified(entry.modifiedMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {notes.entries.length === 0 && (
        <p className="muted sessions-empty-note note-empty">no notes — nothing has been produced into the notes subtree yet</p>
      )}
      {selected !== undefined && (
        <article className="note-content" aria-label={"Note " + selected}>
          <header className="note-content-head">
            <h3 className="note-content-title">
              {note !== undefined && note.meta !== null && note.meta.title !== undefined ? note.meta.title : selected}
            </h3>
            {onSelect !== undefined && (
              <button type="button" className="note-close btn-ghost" onClick={() => onSelect(undefined)}>close</button>
            )}
          </header>
          {note === undefined && noteReason === undefined && (
            <p className="muted sessions-empty-note note-content-loading">loading note…</p>
          )}
          {note === undefined && noteReason !== undefined && (
            <p className="muted sessions-empty-note note-content-error" role="status">
              note unavailable ({noteReason})
            </p>
          )}
          {note !== undefined && (
            <>
              <p className="note-content-meta">
                {note.meta === null
                  ? <span className="muted note-meta-absent">metadata absent</span>
                  : <NoteMetaFields meta={note.meta} />}
                <span className="note-meta-field">{formatBytes(note.byteSize)}</span>
                <span className="note-meta-field session-time">{formatModified(note.modifiedMs)}</span>
              </p>
              <pre className="note-body">{note.body}</pre>
            </>
          )}
        </article>
      )}
    </section>
  );
}
