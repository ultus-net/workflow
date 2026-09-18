import { useEffect, useState } from "react";

import { formatRelativeTime } from "./presenters.js";
import type { AgentInfo, SessionMeta } from "./app.js";

/**
 * The Sessions page: every session record with its live facts (running? live
 * runtime? which agent), the agent picker for new sessions, and switch /
 * rename / dismiss. Session history lives here and behind /sessions — never
 * in a sidebar panel.
 */
export function SessionsView({ sessions, agents, currentAgent, onActivate, onCreate, onSwitchAgent, onRename, onDismiss, onClearUnused, onOpenChat }: {
  readonly sessions: readonly SessionMeta[] | undefined;
  readonly agents: readonly AgentInfo[];
  readonly currentAgent: string;
  readonly onActivate: (id: string) => void;
  readonly onCreate: (agent: string) => void;
  readonly onSwitchAgent: (id: string, agent: string) => void;
  readonly onRename: (id: string, title: string) => void;
  readonly onDismiss: (id: string) => void;
  readonly onClearUnused: () => void;
  readonly onOpenChat: (id: string) => void;
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
      <section className="sessions-view" aria-label="Sessions">
        <header className="sessions-view-head">
          <h2>Sessions</h2>
        </header>
        <p className="muted sessions-empty-note">This server runs a single session — session management is unavailable.</p>
      </section>
    );
  }

  return (
    <section className="sessions-view" aria-label="Sessions">
      <header className="sessions-view-head">
        <h2>Sessions</h2>
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
            </header>
            <footer className="session-card-meta">
              <span className="session-time" title={new Date(session.updatedAt).toLocaleString()}>{formatRelativeTime(session.updatedAt)}</span>
              <span className="session-agent-badge">{session.agent}</span>
            </footer>
            <div className="session-card-actions">
              {!session.active && <button type="button" className="btn btn-ghost" onClick={() => onActivate(session.id)}>Focus</button>}
              {session.active && <button type="button" className="btn btn-ghost" onClick={() => onOpenChat(session.id)}>Open chat</button>}
              {session.active && session.agent !== currentAgent && (
                <button type="button" className="btn btn-ghost" onClick={() => onSwitchAgent(session.id, currentAgent === session.agent ? session.agent : currentAgent)}>
                  Switch to {currentAgent}
                </button>
              )}
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
                className="btn btn-ghost"
                aria-label={`Rename ${session.title}`}
                onClick={() => setRenaming({ id: session.id, title: session.title })}
              >
                ✎
              </button>
              <button type="button" className="btn btn-ghost session-dismiss" aria-label={`Dismiss ${session.title}`} onClick={() => onDismiss(session.id)}>×</button>
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
