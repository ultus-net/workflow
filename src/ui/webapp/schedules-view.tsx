/** The schedule record as the hub's /schedule/list returns it. */
export interface ScheduleMeta {
  readonly id: string;
  readonly title: string;
  readonly cron: string;
  readonly prompt: string;
  readonly workspace?: string;
  readonly enabled?: boolean;
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

/**
 * The Schedules page (W074): the hub cron table projected live — pause/resume
 * and delete are operator actions through the web service's hub proxy; run-now
 * is deliberately NOT a browser affordance (it is a verifier-credential action,
 * like starting a self-improvement loop) and the page says so instead of
 * hiding it.
 */
export function SchedulesView({ schedules, loops, onCancelLoop, onPauseToggle, onDelete }: {
  readonly schedules: readonly ScheduleMeta[] | undefined;
  readonly loops: readonly LoopMeta[] | undefined;
  readonly onCancelLoop: (id: string) => void;
  readonly onPauseToggle: (schedule: ScheduleMeta) => void;
  readonly onDelete: (id: string) => void;
}) {
  return (
    <section className="sessions-view" aria-label="Schedules">
      <header className="sessions-view-head">
        <h2>Schedules</h2>
        <p className="muted sessions-empty-note">
          run-now and loop start are CLI-only — they require the verifier credential, never the browser token
        </p>
      </header>
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
            </footer>
            <div className="session-card-actions">
              <button type="button" className="btn btn-ghost" onClick={() => onPauseToggle(entry)}>
                {entry.enabled === false ? "Resume" : "Pause"}
              </button>
              <button type="button" className="btn btn-ghost session-dismiss" onClick={() => onDelete(entry.id)}>Delete</button>
            </div>
          </article>
        ))}
        {schedules !== undefined && schedules.length === 0 && (
          <p className="muted sessions-empty-note">no schedules — add one to the hub table to see it here</p>
        )}
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
