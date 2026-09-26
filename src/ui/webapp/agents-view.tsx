import { useEffect, useState } from "react";

import { formatRelativeTime } from "./presenters.js";
import type { AgentInfo, SessionMeta } from "./app.js";
import type { SessionBudgetPosture } from "../web-sessions.js";

/** Card glyphs — same 1.4 stroke as the nav slugs, no text-glyph stand-ins. */
function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 13l1-3.5L10.5 3l2.5 2.5L6.5 12z" />
      <path d="M9.5 4L12 6.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** The bar's binding axis: the highest usage-to-cap fraction among the axes
 * that have BOTH recorded usage and a configured cap. Undefined when there is
 * nothing to fill from — the caller renders the honest "no local cap" state
 * instead of a fabricated 0%. Exported so the fill contract (clamped display
 * fraction, binding-axis label) is pinnable without driving the DOM. */
export function budgetBarFill(budget: SessionBudgetPosture): { readonly percent: number; readonly axis: string } | undefined {
  const usage = budget.usage;
  const caps = budget.caps;
  if (usage === undefined || caps === undefined) return undefined;
  const axes: readonly { readonly axis: string; readonly used: number | undefined; readonly cap: number | undefined }[] = [
    { axis: "total tokens", used: usage.totalTokens, cap: caps.maxTotalTokens },
    { axis: "input tokens", used: usage.promptTokens, cap: caps.maxInputTokens },
    { axis: "output tokens", used: usage.completionTokens, cap: caps.maxOutputTokens },
    { axis: "cost", used: usage.costUsd, cap: caps.maxCostUsd },
  ];
  let best: { readonly percent: number; readonly axis: string } | undefined;
  for (const { axis, used, cap } of axes) {
    if (used === undefined || cap === undefined || cap <= 0) continue;
    const percent = (used / cap) * 100;
    if (best === undefined || percent > best.percent) best = { percent, axis };
  }
  return best === undefined ? undefined : { axis: best.axis, percent: Math.min(best.percent, 100) };
}

/**
 * W151: the raise-and-resume dispatch's outcome — undefined resolves to
 * "succeeded, refresh and render the new posture"; a denial resolves to the
 * server's reason VERBATIM (fail closed when the authority withholds the
 * capability — W151 criterion 2), never a disabled-looking success path.
 * Exported so the refusal contract is pinnable without driving the form
 * (the W085 pattern).
 */
export function budgetRaiseOutcome(ok: boolean, status: number, error: string | undefined): string | undefined {
  if (ok) return undefined;
  return error ?? `budget raise failed (${status})`;
}

/**
 * The Agents page (renamed from "Sessions" 2026-09-19, operator direction: a
 * more truthful description that avoids confusion with transcript history):
 * every agent session record with its live facts (running? live runtime? which
 * agent), the agent picker for new sessions, and switch / rename / dismiss.
 * Session history lives here and behind /agents (the /sessions command stays
 * as an alias) — never in a sidebar panel.
 */
export function AgentsView({ sessions, agents, onActivate, onCreate, onSwitchAgent, onRename, onDismiss, onClearUnused, onOpenChat, onBudgetRaise }: {
  readonly sessions: readonly SessionMeta[] | undefined;
  readonly agents: readonly AgentInfo[];
  readonly onActivate: (id: string) => void;
  readonly onCreate: (agent: string) => void;
  readonly onSwitchAgent: (id: string, agent: string) => void;
  readonly onRename: (id: string, title: string) => void;
  readonly onDismiss: (id: string) => void;
  readonly onClearUnused: () => void;
  readonly onOpenChat: (id: string) => void;
  /** W151: dispatches the raise-and-resume proposal; resolves the denial's
   * reason to render, or undefined on success (the caller refreshes). */
  readonly onBudgetRaise: (id: string, raise: { maxTotalTokens?: number; maxCostUsd?: number }) => Promise<string | undefined>;
}) {
  const [newAgent, setNewAgent] = useState<string | undefined>(undefined);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | undefined>(undefined);
  // Default the picker to the operator's current agent (registry leads with it).
  useEffect(() => {
    setNewAgent((existing) => existing ?? agents[0]?.id);
  }, [agents]);
  const chosenAgent = newAgent ?? agents[0]?.id ?? "opencode";
  const hasUnused = sessions?.some((session) => !session.active && session.title === "New session") ?? false;

  if (sessions === undefined) {
    return (
      <section className="sessions-view" aria-label="Agents">
        <header className="sessions-view-head">
          <h2>Agents</h2>
        </header>
        <p className="muted sessions-empty-note">This server runs a single session — session management is unavailable.</p>
      </section>
    );
  }

  return (
    <section className="sessions-view" aria-label="Agents">
      <header className="sessions-view-head">
        <h2>Agents</h2>
        <div className="sessions-view-new">
          <label className="sessions-agent-label" htmlFor="sessions-agent-picker">New session on</label>
          <select
            id="sessions-agent-picker"
            className="sessions-agent-picker"
            value={chosenAgent}
            onChange={(event) => setNewAgent(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id} disabled={!agent.available}>
                {agent.name}{agent.available ? "" : ` — ${agent.reason ?? "unavailable"}`}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-ghost sessions-new" onClick={() => onCreate(chosenAgent)}>+ New</button>
          {hasUnused && <button type="button" className="btn btn-ghost sessions-clear" onClick={onClearUnused}>Clear unused</button>}
        </div>
      </header>
      <div className="sessions-grid">
        {sessions.map((session) => (
          <article
            key={session.id}
            className={`session-card ${session.active ? "session-card-focus" : ""} ${session.busy ? "session-card-busy" : ""}`}
            aria-current={session.active}
          >
            <header className="session-card-head">
              <span className={`session-run-dot ${session.busy ? "session-run-dot-on" : ""}`} title={session.busy ? "turn running" : session.live ? "runtime live" : "not loaded"} aria-hidden="true" />
              <span className="session-card-title" title={session.title}>{session.title}</span>
              {session.active && <span className="session-focus-tag">focused</span>}
              <SessionBudgetBadge budget={session.budget} />
            </header>
            <SessionBudgetBody budget={session.budget} onRaise={(raise) => onBudgetRaise(session.id, raise)} />
            <footer className="session-card-meta">
              <span className="session-time" title={new Date(session.updatedAt).toLocaleString()}>{formatRelativeTime(session.updatedAt)}</span>
              <span className="session-agent-badge">{session.agent}</span>
            </footer>
            <div className="session-card-actions">
              {!session.active && <button type="button" className="btn btn-ghost" onClick={() => onActivate(session.id)}>Focus</button>}
              {session.active && <button type="button" className="btn btn-ghost" onClick={() => onOpenChat(session.id)}>Open chat</button>}
              {session.active && (
                <select
                  aria-label={`Agent for ${session.title}`}
                  className="session-agent-select"
                  value={session.agent}
                  onChange={(event) => onSwitchAgent(session.id, event.target.value)}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id} disabled={!agent.available}>{agent.name}</option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn btn-ghost session-icon-button"
                aria-label={`Rename ${session.title}`}
                onClick={() => setRenaming({ id: session.id, title: session.title })}
              >
                <PencilIcon />
              </button>
              <button
                type="button"
                className="btn btn-ghost session-icon-button session-dismiss"
                aria-label={`Dismiss ${session.title}`}
                onClick={() => onDismiss(session.id)}
              >
                <CloseIcon />
              </button>
            </div>
            {renaming !== undefined && renaming.id === session.id && (
              <div className="session-card-rename">
                <input
                  aria-label={`New title for ${session.title}`}
                  value={renaming.title}
                  autoFocus
                  onChange={(event) => setRenaming({ id: session.id, title: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      onRename(session.id, renaming.title);
                      setRenaming(undefined);
                    }
                    if (event.key === "Escape") setRenaming(undefined);
                  }}
                />
                <button type="button" className="btn btn-ghost" onClick={() => { onRename(session.id, renaming.title); setRenaming(undefined); }}>Save</button>
              </div>
            )}
          </article>
        ))}
        {sessions.length === 0 && <p className="muted sessions-empty-note">no sessions — start one above</p>}
      </div>
    </section>
  );
}

/**
 * W151: the budget badge — rendered ONLY from recorded tier state. The
 * paused-by-budget badge appears exactly when the guard's sticky refusal is
 * installed (the recorded violation). The no-caps state renders in the body
 * (the honest "no local cap" chip), not as a badge — a badge for "nothing is
 * enforced" would be noise on every uncapped session.
 */
function SessionBudgetBadge({ budget }: { readonly budget: SessionMeta["budget"] }) {
  if (budget === undefined) return null;
  if (budget.violation !== undefined) return <span className="session-budget-badge session-budget-badge-abort">paused: budget</span>;
  return null;
}

/**
 * W151: the budget bar and incident card. The bar renders the recorded tier's
 * color (the tier comes from the guard's own predicates, computed server-side
 * — criterion 3); the incident card appears only for a recorded sticky
 * violation and offers the raise-and-resume dispatch whose denial renders
 * verbatim (criterion 2). "Keep stopped" is the explicit no-op: the card
 * says so rather than rendering a button that mutates nothing.
 */
function SessionBudgetBody({ budget, onRaise }: {
  readonly budget: SessionMeta["budget"];
  readonly onRaise: (raise: { maxTotalTokens?: number; maxCostUsd?: number }) => Promise<string | undefined>;
}) {
  const [raising, setRaising] = useState(false);
  const [totalInput, setTotalInput] = useState("");
  const [costInput, setCostInput] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  if (budget === undefined) return null;
  const fill = budgetBarFill(budget);
  const tierClass = budget.tier === undefined ? "session-budget-tier-unknown" : `session-budget-tier-${budget.tier}`;
  const submit = async () => {
    if (submitting) return;
    const total = totalInput.trim() === "" ? undefined : Number(totalInput);
    const cost = costInput.trim() === "" ? undefined : Number(costInput);
    if ((total !== undefined && (!Number.isFinite(total) || total <= 0)) || (cost !== undefined && (!Number.isFinite(cost) || cost <= 0))) {
      setError("raised caps must be positive numbers");
      return;
    }
    setSubmitting(true);
    const outcome = await onRaise({
      ...(total === undefined ? {} : { maxTotalTokens: total }),
      ...(cost === undefined ? {} : { maxCostUsd: cost }),
    });
    setSubmitting(false);
    setError(outcome);
  };
  return (
    <div className={`session-budget ${budget.tier === undefined ? "" : tierClass}`}>
      {budget.caps === undefined ? (
        <span className="session-budget-uncapped" title={budget.mechanism}>no local cap</span>
      ) : (
        <div className="session-budget-bar" role="img" aria-label={`budget: ${budget.tier ?? "usage incomplete"}`}>
          <div
            className="session-budget-bar-fill"
            style={fill === undefined ? { width: 0 } : { width: `${fill.percent}%` }}
            title={fill === undefined
              ? "recorded usage incomplete for the configured caps"
              : `${fill.axis}: ${Math.round(fill.percent)}% of the configured cap${budget.tier === undefined ? "" : ` — tier ${budget.tier}`}`}
          />
        </div>
      )}
      {budget.violation !== undefined && (
        <div className="session-budget-incident" role="alert">
          <span className="session-budget-incident-title">budget incident</span>
          <span className="session-budget-violation">{budget.violation}</span>
          <span className="session-budget-mechanism">{budget.mechanism}</span>
          {raising ? (
            <form
              className="session-budget-raise"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label className="session-budget-raise-field">
                <span>total tokens</span>
                <input
                  aria-label="Raised total-token cap"
                  inputMode="numeric"
                  placeholder={budget.caps?.maxTotalTokens === undefined ? "unset" : String(budget.caps.maxTotalTokens)}
                  value={totalInput}
                  onChange={(event) => setTotalInput(event.target.value)}
                />
              </label>
              <label className="session-budget-raise-field">
                <span>cost USD</span>
                <input
                  aria-label="Raised cost cap"
                  inputMode="decimal"
                  placeholder={budget.caps?.maxCostUsd === undefined ? "unset" : String(budget.caps.maxCostUsd)}
                  value={costInput}
                  onChange={(event) => setCostInput(event.target.value)}
                />
              </label>
              <div className="session-card-actions">
                <button type="submit" className="btn btn-ghost" disabled={submitting}>Raise cap and resume</button>
                <button type="button" className="btn btn-ghost session-dismiss" onClick={() => { setRaising(false); setError(undefined); }}>Cancel</button>
              </div>
              {error !== undefined && <span className="session-budget-raise-error" role="alert">{error}</span>}
            </form>
          ) : (
            <div className="session-card-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setRaising(true); setError(undefined); }}>Raise cap and resume…</button>
            </div>
          )}
          <p className="muted session-budget-keep-stopped">
            keeping it stopped needs no action — the session stays paused until a cap is raised or the session is dismissed
          </p>
        </div>
      )}
    </div>
  );
}
