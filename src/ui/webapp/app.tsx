import { useCallback, useEffect, useRef, useState } from "react";
import {
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";

import { ActionPart, AttentionPart, CompletionPart, OutcomePart } from "./message-parts.js";
import { MarkdownText } from "./markdown-text.js";

interface SnapshotTask {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly blockers: readonly string[];
}

interface SnapshotEvidence {
  readonly subject: string;
  readonly result: string;
  readonly freshness: string;
}

interface SnapshotHistory {
  readonly taskId: string;
  readonly from: string;
  readonly to: string;
}

interface Snapshot {
  readonly enforcementLevel: string;
  readonly transport: string;
  readonly tasks: readonly SnapshotTask[];
  readonly evidence: readonly SnapshotEvidence[];
  readonly history: readonly SnapshotHistory[];
}

const NEXT_STATE: Record<string, string> = { READY: "IN_PROGRESS", IN_PROGRESS: "VERIFYING", VERIFYING: "VERIFIED" };
const PANEL_POLL_MS = 1500;

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(undefined);
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/snapshot");
      if (response.ok) setSnapshot(await response.json() as Snapshot);
    } catch {
      // Keep the last good snapshot; the next poll retries.
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), PANEL_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { snapshot, refresh: load };
}

function advance(taskId: string, requested: string, refresh: () => Promise<void>): void {
  void fetch("/api/transition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId, requested }),
  }).then(() => refresh());
}

interface SessionMeta {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly active: boolean;
}

/** Polls the session registry; undefined when the server runs a single session. */
function useSessions() {
  const [sessions, setSessions] = useState<SessionMeta[] | undefined>(undefined);
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/sessions");
      if (response.status === 503) return; // single-session server: hide the panel
      if (response.ok) setSessions((await response.json() as { sessions: SessionMeta[] }).sessions);
    } catch {
      // Keep the last good list; the next poll retries.
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), PANEL_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { sessions, refresh: load };
}

function createSession(refresh: () => Promise<void>): void {
  void fetch("/api/sessions", { method: "POST" }).then(() => refresh());
}

function dismissSession(id: string, refresh: () => Promise<void>): void {
  void fetch("/api/sessions/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }).then(() => refresh());
}

function clearUnusedSessions(refresh: () => Promise<void>): void {
  void fetch("/api/sessions/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clearUnused: true }),
  }).then(() => refresh());
}

interface ConfigChoice {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

interface ConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly type: "select" | "boolean";
  readonly currentValue: string | boolean;
  readonly choices?: readonly ConfigChoice[];
}

/** Polls the agent-advertised session configuration; empty when the agent offers none. */
function useConfigOptions() {
  const [options, setOptions] = useState<ConfigOption[]>([]);
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/config-options");
      if (response.ok) setOptions((await response.json() as { options: ConfigOption[] }).options);
    } catch {
      // Keep the last good list; the next poll retries.
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), PANEL_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  const setOption = useCallback((id: string, value: string | boolean): void => {
    // Optimistic: reflect the choice now, reconcile with the server response.
    setOptions((previous) => previous.map((option) => option.id === id ? { ...option, currentValue: value } : option));
    void fetch("/api/config-options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, value }),
    }).then(async (response) => {
      if (response.ok) setOptions((await response.json() as { options: ConfigOption[] }).options);
      else await load();
    }).catch(() => load());
  }, [load]);
  return { options, setOption };
}

/** Categories promoted to composer-adjacent pickers; everything else lives in the popover. */
const COMPOSER_CATEGORIES: readonly string[] = ["model", "thought_level", "mode"];

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" strokeLinecap="round" />
    </svg>
  );
}

function ConfigSelect({ option, setOption, labelledBy }: {
  readonly option: ConfigOption;
  readonly setOption: (id: string, value: string | boolean) => void;
  readonly labelledBy?: string;
}) {
  const choices = option.choices ?? [];
  const current = String(option.currentValue);
  // Agents may report a current value outside the advertised choices; show it truthfully.
  const displayChoices = choices.some((choice) => choice.value === current)
    ? choices
    : [{ value: current, name: current }, ...choices];
  return (
    <select
      value={current}
      onChange={(event) => setOption(option.id, event.target.value)}
      aria-label={labelledBy === undefined ? option.name : undefined}
      aria-labelledby={labelledBy}
      title={option.description}
    >
      {displayChoices.map((choice) => (
        <option value={choice.value} key={choice.value} title={choice.description}>{choice.name}</option>
      ))}
    </select>
  );
}

function ConfigControls({ options, setOption }: {
  readonly options: readonly ConfigOption[];
  readonly setOption: (id: string, value: string | boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        gearRef.current?.focus();
      }
    };
    const onPointerDown = (event: MouseEvent): void => {
      if (popoverRef.current?.contains(event.target as Node) === false && gearRef.current?.contains(event.target as Node) === false) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  if (options.length === 0) return null;
  const pickers = options.filter((option) => option.type === "select" && option.category !== undefined && COMPOSER_CATEGORIES.includes(option.category));
  const toggles = options.filter((option) => option.type === "boolean");
  const popoverSelects = options.filter((option) => option.type === "select" && !pickers.includes(option));

  return (
    <div className="config-row">
      {pickers.map((option) => (
        <span className="config-picker" key={option.id}>
          <span className="config-picker-label" id={`config-label-${option.id}`}>{option.name}</span>
          <ConfigSelect option={option} setOption={setOption} labelledBy={`config-label-${option.id}`} />
        </span>
      ))}
      {(toggles.length > 0 || popoverSelects.length > 0) && (
        <span className="config-settings">
          <button
            ref={gearRef}
            className="btn btn-ghost config-gear"
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label="Session settings"
            onClick={() => setOpen((value) => !value)}
          >
            <GearIcon />
          </button>
          {open && (
            <div className="config-popover" role="dialog" aria-label="Session settings" ref={popoverRef}>
              {popoverSelects.map((option) => (
                <label className="config-field" key={option.id}>
                  <span className="config-field-label">{option.name}</span>
                  <ConfigSelect option={option} setOption={setOption} />
                </label>
              ))}
              {toggles.map((option) => (
                <label className="config-toggle" key={option.id} title={option.description}>
                  <input
                    type="checkbox"
                    checked={option.currentValue === true}
                    onChange={(event) => setOption(option.id, event.target.checked)}
                  />
                  <span className="config-toggle-track" aria-hidden="true"><span className="config-toggle-thumb" /></span>
                  <span className="config-toggle-text">
                    {option.name}
                    {option.description !== undefined && <span className="config-toggle-desc">{option.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
}

function SessionsPanel({ sessions, refresh }: { readonly sessions: SessionMeta[]; readonly refresh: () => Promise<void> }) {
  const [pending, setPending] = useState<string | undefined>(undefined);
  const switchTo = (id: string): void => {
    setPending(id);
    void activate(id).finally(() => setPending(undefined));
  };
  const activate = async (id: string): Promise<void> => {
    await fetch("/api/sessions/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await refresh();
  };
  const hasUnused = sessions.some((session) => !session.active && session.title === "New session");
  return (
    <section className="sessions">
      <h2>
        Sessions
        <span className="sessions-actions">
          {hasUnused && (
            <button className="btn btn-ghost sessions-clear" onClick={() => clearUnusedSessions(refresh)}>Clear</button>
          )}
          <button className="btn btn-ghost sessions-new" onClick={() => createSession(refresh)} aria-label="New session">+ New</button>
        </span>
      </h2>
      <div className="sessions-list">
        {sessions.map((session) => (
          <div className={`session-row ${session.active ? "session-active" : ""} ${pending === session.id ? "session-pending" : ""}`} key={session.id}>
            <button
              className="session-activate"
              onClick={() => switchTo(session.id)}
              aria-current={session.active}
              disabled={pending !== undefined}
            >
              <span className="session-title">{pending === session.id ? "loading…" : session.title}</span>
              <span className="session-time">{new Date(session.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </button>
            <button
              className="session-dismiss"
              onClick={() => dismissSession(session.id, refresh)}
              aria-label={`Dismiss ${session.title}`}
              disabled={pending !== undefined}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-user">
      <MessagePrimitive.Attachments>
        {({ attachment }) => {
          const imagePart = attachment.content.find((part) => part.type === "image");
          return imagePart !== undefined && imagePart.type === "image"
            ? <img className="msg-attachment" src={imagePart.image} alt={attachment.name} />
            : null;
        }}
      </MessagePrimitive.Attachments>
      <MessagePrimitive.Parts components={{ Text: (part) => <p className="msg-text">{part.text}</p> }} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-assistant">
      <MessagePrimitive.Parts
        components={{
          Text: MarkdownText,
          data: {
            by_name: {
              action: ActionPart,
              outcome: OutcomePart,
              attention: AttentionPart,
              completion: CompletionPart,
            },
          },
        }}
      />
    </MessagePrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="composer">
      <div className="composer-attachments">
        <ComposerPrimitive.Attachments>
          {() => (
            <AttachmentPrimitive.Root className="composer-attachment">
              <AttachmentPrimitive.unstable_Thumb className="composer-attachment-thumb" />
              <span className="composer-attachment-name"><AttachmentPrimitive.Name /></span>
              <AttachmentPrimitive.Remove className="attachment-remove" aria-label="Remove attachment">×</AttachmentPrimitive.Remove>
            </AttachmentPrimitive.Root>
          )}
        </ComposerPrimitive.Attachments>
      </div>
      <div className="composer-row">
        <ComposerPrimitive.AddAttachment className="btn btn-ghost btn-attach" aria-label="Attach image" multiple>
          +
        </ComposerPrimitive.AddAttachment>
        <ComposerPrimitive.Input
          className="composer-input"
          placeholder="Describe the work to perform"
          submitMode="enter"
          aria-label="Prompt"
        />
        <div className="composer-actions">
          <AuiIf condition={(state) => state.thread.isRunning}>
            <ComposerPrimitive.Cancel className="btn btn-cancel">Cancel</ComposerPrimitive.Cancel>
          </AuiIf>
          <AuiIf condition={(state) => !state.thread.isRunning}>
            <ComposerPrimitive.Send className="btn btn-send">Send</ComposerPrimitive.Send>
          </AuiIf>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function Panels({ snapshot, sessions, refresh, refreshSessions }: {
  readonly snapshot: Snapshot | undefined;
  readonly sessions: SessionMeta[] | undefined;
  readonly refresh: () => Promise<void>;
  readonly refreshSessions: () => Promise<void>;
}) {
  return (
    <aside className="panels">
      {sessions !== undefined && <SessionsPanel sessions={sessions} refresh={refreshSessions} />}
      <section>
        <h2>Tasks</h2>
        {(snapshot?.tasks ?? []).map((task) => (
          <div className={`task ${task.state === "BLOCKED" ? "task-blocked" : ""}`} key={task.id}>
            <strong>{task.id}</strong>
            <span className={`task-state task-state-${task.state.toLowerCase()}`}>{task.state}</span>
            <span className="task-title">
              {task.title}
              {task.blockers.length > 0 && <span className="task-blockers">blocked by {task.blockers.join(", ")}</span>}
            </span>
            {NEXT_STATE[task.state] !== undefined && (
              <button className="btn btn-ghost" onClick={() => advance(task.id, NEXT_STATE[task.state]!, refresh)}>
                Advance
              </button>
            )}
          </div>
        ))}
      </section>
      <section>
        <h2>Evidence</h2>
        {snapshot === undefined || snapshot.evidence.length === 0
          ? <p className="muted">none observed</p>
          : snapshot.evidence.map((entry, index) => (
            <p className={entry.freshness === "stale" ? "muted" : ""} key={index}>
              {entry.subject}: {entry.result} / {entry.freshness}
            </p>
          ))}
      </section>
      <section>
        <h2>History</h2>
        {snapshot === undefined || snapshot.history.length === 0
          ? <p className="muted">no transitions</p>
          : snapshot.history.slice(-8).map((entry, index) => (
            <p key={index}>{entry.taskId}: {entry.from} → {entry.to}</p>
          ))}
      </section>
    </aside>
  );
}

const ENFORCEMENT_COPY: Record<string, string> = {
  advisory: "Advisory: the agent's actions are reviewed and recorded, but file and command mutations are not pre-authorized before they run.",
  enforced: "Enforced: agent file and command mutations require Workflow authorization before they run.",
};

export function App() {
  const { snapshot, refresh } = useSnapshot();
  const { sessions, refresh: refreshSessions } = useSessions();
  const { options, setOption } = useConfigOptions();
  const enforcementCopy = snapshot === undefined ? undefined : ENFORCEMENT_COPY[snapshot.enforcementLevel];
  return (
    <div className="shell">
      <header className="shell-header">
        <strong>Workflow Control</strong>
        <span
          className="shell-host"
          title={enforcementCopy}
          aria-label={enforcementCopy ?? "enforcement level unavailable"}
        >
          {snapshot === undefined ? "connecting" : `${snapshot.enforcementLevel.toUpperCase()} / ${snapshot.transport}`}
        </span>
      </header>
      <main className="shell-main">
        <section className="chat-column">
          <ThreadPrimitive.Root className="thread-root">
            <ThreadPrimitive.Viewport className="thread-viewport">
              <AuiIf condition={(state) => state.thread.isEmpty}>
                <div className="welcome">
                  <p>Describe the work to perform. Every action the agent takes is proposed and authorized through Workflow.</p>
                </div>
              </AuiIf>
              <ThreadPrimitive.Messages>
                {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
              </ThreadPrimitive.Messages>
              <AuiIf condition={(state) => state.thread.isRunning}>
                <div className="working" role="status" aria-live="polite">
                  <span className="working-dot" aria-hidden="true" />
                  agent is working…
                </div>
              </AuiIf>
            </ThreadPrimitive.Viewport>
            <div className="composer-dock">
              <Composer />
              <ConfigControls options={options} setOption={setOption} />
            </div>
          </ThreadPrimitive.Root>
        </section>
        <Panels snapshot={snapshot} sessions={sessions} refresh={refresh} refreshSessions={refreshSessions} />
      </main>
    </div>
  );
}
