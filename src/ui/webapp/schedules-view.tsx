import { useState } from "react";

import { formatScheduleFire } from "./presenters.js";
import type { ScheduleLineage, ScheduleRecentRun } from "../../integrations/operator-posture.js";

/** The schedule record as the hub's /schedule/list returns it. */
export interface ScheduleMeta {
  readonly id: string;
  readonly title: string;
  readonly cron: string;
  readonly prompt: string;
  readonly workspace?: string;
  readonly enabled?: boolean;
  readonly requiresReview?: boolean;
  /** Advanced schedule fields ride the same wire; the form edits the common
   * fields and preserves these by re-sending the full entry. */
  readonly budget?: unknown;
  readonly taskClass?: string;
  readonly offPeak?: string;
  readonly offPeakRequired?: boolean;
  /**
   * W153: the hub-computed per-schedule lineage (caused-run count, last
   * outcome, tombstone) — computed by the shared projection over the kernel's
   * run states, never by this view. Null from a hub that computes no row;
   * ABSENT from a hub predating the view slice (render nothing rather than a
   * fabricated zero).
   */
  readonly lineage?: ScheduleLineage | null;
  /** W074/W085: the next cron match, hub-proxy-computed; null when none. */
  readonly nextRunAt?: string | null;
}

/** The common schedule fields the create/edit form collects. */
export interface ScheduleSaveInput {
  readonly id: string;
  readonly title: string;
  readonly cron: string;
  readonly prompt: string;
  readonly workspace?: string;
  readonly requiresReview?: boolean;
}

/** The loop record as the hub's /rsi/status returns it. */
export interface LoopMeta {
  readonly id: string;
  readonly spec: { readonly workspace: string; readonly objective: string; readonly requiresReview: boolean };
  readonly state: "running" | "completed" | "stopped" | "cancelled";
  readonly startedAt: string;
  readonly cancelRequested: boolean;
  readonly iterations: readonly unknown[];
  readonly outcome?: { readonly reason: string; readonly accepted: number; readonly rejected: number };
}

/** The last-outcome label and class the lineage line renders — the recorded
 * outcome states only, never a computed guess. Partial over the union so a
 * future hub outcome value degrades to the raw value rendered verbatim
 * (review round P3: never a render throw). */
const OUTCOME_LABELS: Partial<Record<ScheduleLineage["lastOutcome"], { readonly label: string; readonly className: string }>> = {
  verified: { label: "last run verified", className: "schedule-lineage-outcome-verified" },
  failed: { label: "last run failed", className: "schedule-lineage-outcome-failed" },
  "in-progress": { label: "last run in progress", className: "schedule-lineage-outcome-running" },
  unrun: { label: "never fired", className: "schedule-lineage-outcome-unrun" },
};

/** The lineage line's outcome span — a future hub outcome value renders its
 * raw recorded value verbatim with the neutral class (review round P3: never
 * a render throw, never a paraphrase). */
function ScheduleOutcomeLine({ outcome }: { readonly outcome: ScheduleLineage["lastOutcome"] }) {
  const known = OUTCOME_LABELS[outcome];
  return <span className={known?.className ?? "schedule-lineage-outcome-unrun"}>{known?.label ?? `last run ${outcome}`}</span>;
}

/**
 * The Schedules page (W074 + W085): the hub cron table projected live —
 * create/edit/pause/resume and delete are operator actions through the web
 * service's hub proxy (the hub's live registry applies an edit on the very
 * next tick, no restart); run-now is deliberately NOT a browser affordance
 * (it is a verifier-credential action, like starting a self-improvement
 * loop) and the page says so instead of hiding it.
 *
 * W153 (the view slice): each card renders the schedule's recorded lineage —
 * caused-run count, last outcome, next fire — and a recent-runs list answers
 * "did my schedules fire while I was away?" from hub-served rows. Run rows
 * render attribution ("fired by …") from the record; a tombstoned schedule's
 * runs say the schedule was deleted. Run inspection panels do not exist yet,
 * so rows render the target in the title exactly like the posture inbox
 * (the recorded wave-1 pattern), never dead buttons.
 */
export function SchedulesView({ schedules, loops, recentRuns, onCancelLoop, onPauseToggle, onDelete, onSaveSchedule }: {
  readonly schedules: readonly ScheduleMeta[] | undefined;
  readonly loops: readonly LoopMeta[] | undefined;
  /** W153: the hub's recent schedule-origin runs; undefined from a hub predating the slice. */
  readonly recentRuns: readonly ScheduleRecentRun[] | undefined;
  readonly onCancelLoop: (id: string) => void;
  readonly onPauseToggle: (schedule: ScheduleMeta) => void;
  readonly onDelete: (id: string) => void;
  /** Upserts through the hub proxy; resolves the hub's error message, or
   * undefined when the save succeeded. */
  readonly onSaveSchedule: (fields: ScheduleSaveInput, base?: ScheduleMeta) => Promise<string | undefined>;
}) {
  const [editing, setEditing] = useState<ScheduleMeta | "new" | undefined>(undefined);
  return (
    <section className="sessions-view" aria-label="Schedules">
      <header className="sessions-view-head">
        <h2>Schedules</h2>
        <p className="muted sessions-empty-note">
          run-now and loop start are CLI-only — they require the verifier credential, never the browser token
        </p>
      </header>
      {editing === undefined ? (
        <div className="session-card-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setEditing("new")}>New schedule</button>
        </div>
      ) : (
        <ScheduleForm
          initial={editing === "new" ? undefined : editing}
          onCancel={() => setEditing(undefined)}
          onSave={async (fields) => {
            // W085 review P2: refuse a colliding id up front — see the helper.
            if (editing === "new") {
              const collision = scheduleIdCollisionError(fields, schedules);
              if (collision !== undefined) return collision;
            }
            const error = await onSaveSchedule(fields, editing === "new" ? undefined : editing);
            if (error === undefined) setEditing(undefined);
            return error;
          }}
        />
      )}
      <div className="sessions-grid">
        {(schedules ?? []).map((entry) => (
          <article key={entry.id} className={`session-card ${entry.enabled === false ? "session-card-paused" : ""}`}>
            <header className="session-card-head">
              <span className="session-run-dot" title={entry.enabled === false ? "paused" : "enabled"} aria-hidden="true" />
              <span className="session-card-title" title={entry.prompt}>{entry.title}</span>
              {entry.enabled === false && <span className="session-focus-tag">paused</span>}
            </header>
            <footer className="session-card-meta">
              <span className="session-agent-badge">{entry.cron}</span>
              {entry.workspace !== undefined && <span className="session-time" title={entry.workspace}>{entry.workspace.split("/").pop()}</span>}
              {entry.nextRunAt != null && <span className="session-time schedule-next-fire" title={`next fire ${entry.nextRunAt}`}>next {formatScheduleFire(entry.nextRunAt)}</span>}
            </footer>
            {entry.lineage !== undefined && entry.lineage !== null && (
              <footer className="session-card-meta schedule-lineage" title="run lineage, computed from the run registry">
                <span className="schedule-lineage-count">{entry.lineage.causedRuns} run{entry.lineage.causedRuns === 1 ? "" : "s"}</span>
                <ScheduleOutcomeLine outcome={entry.lineage.lastOutcome} />
                {entry.lineage.tombstoned && <span className="schedule-lineage-tombstone">schedule deleted — runs stay attributed</span>}
              </footer>
            )}
            <div className="session-card-actions">
              {editing === undefined && (
                <button type="button" className="btn btn-ghost" onClick={() => setEditing(entry)}>Edit</button>
              )}
              <button type="button" className="btn btn-ghost" onClick={() => onPauseToggle(entry)}>
                {entry.enabled === false ? "Resume" : "Pause"}
              </button>
              <button type="button" className="btn btn-ghost session-dismiss" onClick={() => onDelete(entry.id)}>Delete</button>
            </div>
          </article>
        ))}
        {schedules !== undefined && schedules.length === 0 && editing === undefined && (
          <p className="muted sessions-empty-note">no schedules — create one above to see it here</p>
        )}
      </div>

      <header className="sessions-view-head">
        <h2>Recent schedule runs</h2>
        <p className="muted sessions-empty-note">
          {recentRuns === undefined
            ? "hub does not report schedule-run history"
            : recentRuns.length === 0
              ? "no schedule-fired runs recorded yet"
              : "the last schedule-fired runs, newest first (registry order)"}
        </p>
      </header>
      <div className="sessions-grid schedule-recent-runs">
        {(recentRuns ?? []).map((run) => (
          <article key={run.runId} className="session-card schedule-recent-run">
            <header className="session-card-head">
              <span className={`session-run-dot ${run.state === "IN_PROGRESS" || run.state === "VERIFYING" ? "session-run-dot-on" : ""}`} title={run.state} aria-hidden="true" />
              <span className="session-card-title schedule-recent-run-id" title={run.runId}>{run.runId}</span>
              <span className="session-focus-tag">{run.state}</span>
            </header>
            <footer className="session-card-meta">
              <span className="session-agent-badge schedule-run-origin">fired by {run.scheduleTitle}{run.tombstoned ? " (schedule deleted)" : ""}</span>
            </footer>
          </article>
        ))}
      </div>

      <header className="sessions-view-head">
        <h2>Self-improvement loops</h2>
      </header>
      <div className="sessions-grid">
        {(loops ?? []).map((loop) => (
          <article key={loop.id} className="session-card">
            <header className="session-card-head">
              <span className={`session-run-dot ${loop.state === "running" ? "session-run-dot-on" : ""}`} title={loop.state} aria-hidden="true" />
              <span className="session-card-title" title={loop.spec.workspace}>{loop.spec.workspace.split("/").pop()}</span>
              <span className="session-focus-tag">{loop.state}</span>
            </header>
            <footer className="session-card-meta">
              <span className="session-time" title={loop.spec.objective}>{loop.spec.objective}</span>
              <span className="session-agent-badge">{loop.iterations.length} iterations</span>
            </footer>
            <div className="session-card-actions">
              {loop.state === "running" && (
                <button type="button" className="btn btn-ghost" onClick={() => onCancelLoop(loop.id)}>Cancel</button>
              )}
            </div>
          </article>
        ))}
        {loops !== undefined && loops.length === 0 && (
          <p className="muted sessions-empty-note">no loops — start one with `workflow-rsi start`</p>
        )}
      </div>
    </section>
  );
}

/**
 * W085 review P2: the hub's `POST /schedule/save` is upsert-by-id, so creating
 * a schedule with an existing id would silently REPLACE that schedule (and
 * drop its advanced fields) while reporting success. The page refuses the
 * collision client-side, before the save ever crosses the proxy. Exported so
 * the refusal contract is pinnable without driving the interactive form.
 */
export function scheduleIdCollisionError(fields: ScheduleSaveInput, schedules: readonly ScheduleMeta[] | undefined): string | undefined {
  if ((schedules ?? []).some((entry) => entry.id === fields.id)) {
    return `a schedule with id '${fields.id}' already exists — edit it instead`;
  }
  return undefined;
}

/**
 * The create/edit schedule form (W085). The hub validates the entry — an
 * invalid cron or a bad shape comes back as the hub's own message, surfaced
 * verbatim; the form never invents a success. Editing re-sends the full
 * schedule entry (via `base`) so advanced fields the form does not collect
 * (budget, taskClass, off-peak) survive the round-trip through the proxy's
 * field stripping.
 */
export function ScheduleForm({ initial, onSave, onCancel }: {
  readonly initial: ScheduleMeta | undefined;
  readonly onSave: (fields: ScheduleSaveInput) => Promise<string | undefined>;
  readonly onCancel: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [cron, setCron] = useState(initial?.cron ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [workspace, setWorkspace] = useState(initial?.workspace ?? "");
  const [requiresReview, setRequiresReview] = useState(initial?.requiresReview !== false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const editing = initial !== undefined;
  return (
    <form
      className="schedule-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        if (id.trim().length === 0 || title.trim().length === 0 || cron.trim().length === 0 || prompt.trim().length === 0) {
          setError("id, title, cron, and prompt are required");
          return;
        }
        setSaving(true);
        void onSave({
          id: id.trim(),
          title: title.trim(),
          cron: cron.trim(),
          prompt: prompt.trim(),
          ...(workspace.trim() === "" ? {} : { workspace: workspace.trim() }),
          requiresReview,
        }).then((saveError) => {
          setSaving(false);
          setError(saveError);
        });
      }}
    >
      <div className="schedule-form-grid">
        <input aria-label="Schedule id" placeholder="id" value={id} disabled={editing} onChange={(event) => setId(event.target.value)} />
        <input aria-label="Schedule title" placeholder="title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <input aria-label="Schedule cron" placeholder="cron (e.g. 0 9 * * *)" value={cron} onChange={(event) => setCron(event.target.value)} />
        <input aria-label="Schedule workspace (optional)" placeholder="workspace (optional)" value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
      </div>
      <input aria-label="Schedule prompt" placeholder="the prompt the hub sends on each run" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      <label className="schedule-form-check">
        <input type="checkbox" checked={requiresReview} onChange={(event) => setRequiresReview(event.target.checked)} />
        require secondary review on each run
      </label>
      <div className="session-card-actions">
        <button className="btn btn-ghost" type="submit" disabled={saving}>{editing ? "Save changes" : "Create schedule"}</button>
        <button className="btn btn-ghost session-dismiss" type="button" onClick={onCancel}>Cancel</button>
        {error !== undefined && <span className="schedule-form-error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
