/**
 * W197 — the Workspace page: the hub's shared assistant workspace directory
 * projected live (slice 2 of the hub overhaul; read-only). The `augur-workspace`
 * Azure Files share is mounted at the plane's workspace root; this view lets the
 * operator see what the plane and the assistant are working on together.
 *
 * The view surfaces a bounded directory listing and fabricates nothing: the
 * root path, the truncation flag, and the entries all come from the hub's
 * `POST /workspace` read. V1 is a LISTING only — the hub never reads file
 * contents, so the view never claims a content preview. The full state cycle is
 * rendered: loading (`workspace === undefined`, no reason), error (`reason`),
 * empty (a root with no entries), and populated, plus the truncated notice when
 * the hub's enumeration bound was hit.
 *
 * (Template literals are deliberately absent: string concatenation keeps the
 * source patchable under the guard shell classifier.)
 */

/** One directory entry as the hub's /workspace read returns it. */
export interface WorkspaceEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
  /** Bytes; 0 for directories. */
  readonly size: number;
  /** Epoch milliseconds. */
  readonly modifiedMs: number;
}

/** The bounded listing the hub's /workspace read returns. */
export interface WorkspaceListing {
  /** The configured workspace root (absolute path). */
  readonly root: string;
  /** True when the hub's enumeration bound stopped the listing early. */
  readonly truncated: boolean;
  readonly entries: readonly WorkspaceEntry[];
}

/** Human-readable byte count. Pure and locale-independent: B / KiB / MiB,
 * one decimal for the scaled units. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return String(bytes) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}

/** Locale-independent timestamp: the ISO instant, never a locale string. */
export function formatModified(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

export function WorkspaceView({ workspace, reason }: {
  readonly workspace: WorkspaceListing | undefined;
  readonly reason?: string | undefined;
}) {
  if (workspace === undefined && reason === undefined) {
    return (
      <section className="sessions-view workspace-view" aria-label="Workspace">
        <header className="sessions-view-head">
          <h2>Workspace</h2>
        </header>
        <p className="muted sessions-empty-note workspace-loading">loading workspace…</p>
      </section>
    );
  }
  if (workspace === undefined) {
    return (
      <section className="sessions-view workspace-view" aria-label="Workspace">
        <header className="sessions-view-head">
          <h2>Workspace</h2>
        </header>
        <p className="muted sessions-empty-note workspace-error" role="status">
          workspace unavailable ({reason})
        </p>
      </section>
    );
  }
  return (
    <section className="sessions-view workspace-view" aria-label="Workspace">
      <header className="sessions-view-head">
        <h2>Workspace</h2>
        <p className="muted sessions-empty-note">
          the shared assistant workspace: the files the plane and augur both read and write; a bounded listing, never file contents
        </p>
      </header>
      <p className="workspace-root">
        <span className="workspace-field-label">root</span>
        <code className="workspace-root-path" title={workspace.root}>{workspace.root}</code>
      </p>
      {workspace.truncated && (
        <p className="muted sessions-empty-note workspace-truncated" role="status">
          listing truncated: the workspace holds more entries than the hub enumerates in one read
        </p>
      )}
      <table className="usage-table workspace-table" aria-label="Workspace entries">
        <thead>
          <tr>
            <th scope="col">name</th>
            <th scope="col">kind</th>
            <th scope="col">size</th>
            <th scope="col">modified</th>
          </tr>
        </thead>
        <tbody>
          {workspace.entries.map((entry) => (
            <tr key={entry.name} className="workspace-row">
              <td className="workspace-name" title={entry.name}>{entry.name}</td>
              <td><span className="session-focus-tag workspace-kind">{entry.kind}</span></td>
              <td className="workspace-size">{entry.kind === "directory" ? "—" : formatBytes(entry.size)}</td>
              <td className="workspace-modified session-time">{formatModified(entry.modifiedMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {workspace.entries.length === 0 && (
        <p className="muted sessions-empty-note workspace-empty">no entries — the workspace root is empty</p>
      )}
    </section>
  );
}
