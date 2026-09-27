import { useState } from "react";

/**
 * W164 — the Projects page: the hub's project container projected live —
 * the "open a project" record the operator asked for (Paperclip borrow).
 * Each card renders the provider-stable repo identity (fullName + provider
 * repo id — credential-free by construction; the browser can never see a
 * credential that is not in the record), the status, the budget envelope
 * (the W045/W118 caps, display only), and the bound workspaces.
 *
 * Create/edit/delete go through the web service's hub proxy exactly like
 * the schedules page; the hub's registry is the single writer and persists
 * before admitting. There is deliberately NO run affordance on a project:
 * the record carries no dispatch seam, so work starts through the ordinary
 * authority (runs, schedules) — a project is a container, not a launcher.
 * Per-project board scoping in this UI is a recorded follow-up (the hub's
 * /project/scope answers the scoped board; wiring the board page to it is
 * deferred, stated on the issue, never silently).
 */

/** The project record as the hub's /project/list returns it. */
export interface ProjectMeta {
  readonly id: string;
  readonly title: string;
  readonly repo: { readonly provider: string; readonly fullName: string; readonly repoId: number };
  readonly status: "active" | "paused" | "archived";
  /** The W045/W118 budget envelope; display only — enforcement stays with
   * the run-time budget machinery. */
  readonly budget?: unknown;
  readonly workspaces: readonly string[];
}

/** The common project fields the create/edit form collects. The budget
 * envelope rides the `base` spread (like the schedule form's advanced
 * fields) so an edit never drops it. */
export interface ProjectSaveInput {
  readonly id: string;
  readonly title: string;
  readonly fullName: string;
  readonly repoId: number;
  readonly status: "active" | "paused" | "archived";
  readonly workspaces: readonly string[];
}

/** The status classes the card renders — the recorded states only. */
const STATUS_LABELS: Record<ProjectMeta["status"], string> = {
  active: "active",
  paused: "paused",
  archived: "archived",
};

/**
 * The hub's `POST /project/save` is upsert-by-id, so creating a project
 * with an existing id would silently REPLACE that project. The page refuses
 * the collision client-side, before the save crosses the proxy. Exported so
 * the refusal contract is pinnable without driving the interactive form.
 */
export function projectIdCollisionError(fields: ProjectSaveInput, projects: readonly ProjectMeta[] | undefined): string | undefined {
  if ((projects ?? []).some((entry) => entry.id === fields.id)) {
    return `a project with id '${fields.id}' already exists — edit it instead`;
  }
  return undefined;
}

/** The form's own shape validation — the hub validates authoritatively; this
 * only refuses a record the proxy would strip into nonsense anyway. */
export function projectFormError(fields: ProjectSaveInput): string | undefined {
  if (fields.id.trim().length === 0 || fields.title.trim().length === 0) return "id and title are required";
  if (!/^[^/\s]+\/[^/\s]+$/.test(fields.fullName)) return "the repository must be an 'owner/name' pair";
  if (!Number.isInteger(fields.repoId) || fields.repoId <= 0) return "the repository id must be a positive integer";
  return undefined;
}

export function ProjectsView({ projects, onDelete, onSaveProject }: {
  readonly projects: readonly ProjectMeta[] | undefined;
  readonly onDelete: (id: string) => void;
  /** Upserts through the hub proxy; resolves the hub's error message, or
   * undefined when the save succeeded. */
  readonly onSaveProject: (fields: ProjectSaveInput, base?: ProjectMeta) => Promise<string | undefined>;
}) {
  const [editing, setEditing] = useState<ProjectMeta | "new" | undefined>(undefined);
  return (
    <section className="sessions-view" aria-label="Projects">
      <header className="sessions-view-head">
        <h2>Projects</h2>
        <p className="muted sessions-empty-note">
          a project binds a repository identity, a status, a budget envelope, and its workspaces — it never runs anything itself
        </p>
      </header>
      {editing === undefined ? (
        <div className="session-card-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setEditing("new")}>New project</button>
        </div>
      ) : (
        <ProjectForm
          initial={editing === "new" ? undefined : editing}
          onCancel={() => setEditing(undefined)}
          onSave={async (fields) => {
            if (editing === "new") {
              const collision = projectIdCollisionError(fields, projects);
              if (collision !== undefined) return collision;
            }
            const error = await onSaveProject(fields, editing === "new" ? undefined : editing);
            if (error === undefined) setEditing(undefined);
            return error;
          }}
        />
      )}
      <div className="sessions-grid">
        {(projects ?? []).map((entry) => (
          <article key={entry.id} className={`session-card ${entry.status !== "active" ? "session-card-paused" : ""}`}>
            <header className="session-card-head">
              <span className="session-run-dot" title={STATUS_LABELS[entry.status]} aria-hidden="true" />
              <span className="session-card-title" title={entry.repo.fullName}>{entry.title}</span>
              <span className="session-focus-tag">{STATUS_LABELS[entry.status]}</span>
            </header>
            <footer className="session-card-meta">
              <span className="session-agent-badge" title={`${entry.repo.provider} · repo id ${entry.repo.repoId}`}>{entry.repo.fullName}</span>
              {entry.budget !== undefined && entry.budget !== null && (
                <span className="session-time" title="budget envelope (caps only — enforced by the run-time budget machinery)">
                  {budgetLine(entry.budget)}
                </span>
              )}
            </footer>
            <footer className="session-card-meta" title="bound workspaces — project-scoped queries return only these">
              {entry.workspaces.length === 0
                ? <span className="muted">no workspaces bound</span>
                : entry.workspaces.map((workspace) => (
                  <span key={workspace} className="session-time" title={workspace}>{workspace.split("/").pop()}</span>
                ))}
            </footer>
            <div className="session-card-actions">
              {editing === undefined && (
                <button type="button" className="btn btn-ghost" onClick={() => setEditing(entry)}>Edit</button>
              )}
              <button type="button" className="btn btn-ghost session-dismiss" onClick={() => onDelete(entry.id)}>Delete</button>
            </div>
          </article>
        ))}
        {projects !== undefined && projects.length === 0 && editing === undefined && (
          <p className="muted sessions-empty-note">no projects — create one above to see it here</p>
        )}
        {projects === undefined && (
          <p className="muted sessions-empty-note">hub does not report projects</p>
        )}
      </div>
    </section>
  );
}

/** The budget envelope's honest display line: only the caps the record
 * actually carries, formatted verbatim — no synthesized totals. */
function budgetLine(budget: unknown): string {
  if (typeof budget !== "object" || budget === null) return "";
  const caps = budget as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof caps.maxTotalTokens === "number") parts.push(`≤${caps.maxTotalTokens} tok`);
  if (typeof caps.maxInputTokens === "number") parts.push(`in ≤${caps.maxInputTokens}`);
  if (typeof caps.maxOutputTokens === "number") parts.push(`out ≤${caps.maxOutputTokens}`);
  if (typeof caps.maxCostUsd === "number") parts.push(`≤$${caps.maxCostUsd}`);
  return parts.join(" · ");
}

/** The create/edit project form. The hub validates the record — an invalid
 * shape comes back as the hub's own message, surfaced verbatim; the form
 * never invents a success. Editing re-sends the full project entry (via
 * `base`) so fields the form does not collect (the budget envelope) survive
 * the round-trip through the proxy's field stripping. */
export function ProjectForm({ initial, onSave, onCancel }: {
  readonly initial: ProjectMeta | undefined;
  readonly onSave: (fields: ProjectSaveInput) => Promise<string | undefined>;
  readonly onCancel: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [fullName, setFullName] = useState(initial?.repo.fullName ?? "");
  const [repoId, setRepoId] = useState(initial === undefined ? "" : String(initial.repo.repoId));
  const [status, setStatus] = useState<ProjectMeta["status"]>(initial?.status ?? "active");
  const [workspaces, setWorkspaces] = useState((initial?.workspaces ?? []).join("\n"));
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const editing = initial !== undefined;
  return (
    <form
      className="schedule-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        const fields: ProjectSaveInput = {
          id: id.trim(),
          title: title.trim(),
          fullName: fullName.trim(),
          repoId: Number(repoId.trim()),
          status,
          workspaces: workspaces.split("\n").map((line) => line.trim()).filter((line) => line.length > 0),
        };
        const invalid = projectFormError(fields);
        if (invalid !== undefined) {
          setError(invalid);
          return;
        }
        setSaving(true);
        void onSave(fields).then((saveError) => {
          setSaving(false);
          setError(saveError);
        });
      }}
    >
      <div className="schedule-form-grid">
        <input aria-label="Project id" placeholder="id" value={id} disabled={editing} onChange={(event) => setId(event.target.value)} />
        <input aria-label="Project title" placeholder="title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <input aria-label="Project repository" placeholder="owner/name" value={fullName} onChange={(event) => setFullName(event.target.value)} />
        <input aria-label="Project repository id" placeholder="repo id" value={repoId} onChange={(event) => setRepoId(event.target.value)} />
      </div>
      <select aria-label="Project status" value={status} onChange={(event) => setStatus(event.target.value as ProjectMeta["status"])}>
        <option value="active">active</option>
        <option value="paused">paused</option>
        <option value="archived">archived</option>
      </select>
      <textarea
        aria-label="Project workspaces (one per line)"
        placeholder="bound workspaces, one per line"
        rows={2}
        value={workspaces}
        onChange={(event) => setWorkspaces(event.target.value)}
      />
      <div className="session-card-actions">
        <button className="btn btn-ghost" type="submit" disabled={saving}>{editing ? "Save changes" : "Create project"}</button>
        <button className="btn btn-ghost session-dismiss" type="button" onClick={onCancel}>Cancel</button>
        {error !== undefined && <span className="schedule-form-error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
