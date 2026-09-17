import { useCallback, useEffect, useRef, useState } from "react";
import {
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";

import { ActionPart, AttentionPart, CompletionPart, OutcomePart, PlanPart, ThinkingPart, ToolPart } from "./message-parts.js";
import { ConfigField } from "./config-field.js";
import { DiffText, looksLikeDiff } from "./diff-text.js";
import { MarkdownText } from "./markdown-text.js";
import { describeActivity, formatElapsed, formatRelativeTime, formatTokens } from "./presenters.js";
import { useSessionState, useSessionUsage } from "./runtime.js";
import { SettingsDialog } from "./settings-dialog.js";
import { useTheme } from "./theme.js";
import type { OperatorSessionItem } from "../operator-session.js";
import type { WebConfigOption } from "../web-config-options.js";

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
const NEXT_STATE_ACTION: Record<string, string> = { READY: "Start", IN_PROGRESS: "Verify", VERIFYING: "Complete" };
const PANEL_POLL_MS = 1500;

interface GitChange {
  readonly path: string;
  readonly status: "added" | "deleted" | "modified" | "renamed" | "untracked";
}

interface GitStatus {
  readonly branch: string;
  readonly changes: readonly GitChange[];
}

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

function useGitStatus() {
  const [status, setStatus] = useState<GitStatus | undefined>(undefined);
  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/git");
        if (response.ok) setStatus(await response.json() as GitStatus);
      } catch {
        // Keep the last good repository state; the next poll retries.
      }
    };
    void load();
    const timer = setInterval(() => void load(), PANEL_POLL_MS);
    return () => clearInterval(timer);
  }, []);
  return status;
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

type PermissionDecision = "allow_once" | "allow_always" | "reject_once" | "reject_always";

interface PendingPermission {
  readonly id: string;
  readonly tool: string;
  readonly capability?: string;
  readonly subjects: readonly string[];
  readonly inputPreview?: string;
}

interface PermissionsState {
  readonly available: boolean;
  readonly mode: "auto" | "ask";
  readonly pending: PendingPermission | null;
  readonly patterns: { readonly alwaysAllow: readonly string[]; readonly alwaysReject: readonly string[] };
}

const PERMISSION_POLL_MS = 1000;

/** Polls operator permission-asking state; parked prompts need fast feedback. */
function usePermissions() {
  const [state, setState] = useState<PermissionsState>({
    available: false,
    mode: "auto",
    pending: null,
    patterns: { alwaysAllow: [], alwaysReject: [] },
  });
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/permission");
      if (response.ok) setState(await response.json() as PermissionsState);
    } catch {
      // Keep the last good state; the next poll retries.
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), PERMISSION_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  const answer = useCallback(async (id: string, decision: PermissionDecision): Promise<void> => {
    await fetch("/api/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    await load();
  }, [load]);
  const update = useCallback(async (body: { mode?: "auto" | "ask"; reset?: boolean }): Promise<void> => {
    await fetch("/api/permission-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await load();
  }, [load]);
  return { ...state, answer, update };
}

interface CapabilitiesState {
  readonly capabilities: readonly string[];
  readonly workspaceConfinement: boolean;
}

/** Polls the hub's capability grants (process/network toggles + confinement). */
function useCapabilities() {
  const [state, setState] = useState<CapabilitiesState | undefined>(undefined);
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/capabilities");
      if (response.ok) setState(await response.json() as CapabilitiesState);
    } catch {
      // Keep the last good state; the next poll retries.
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), PANEL_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  const setCapability = useCallback(async (capability: "process" | "network", enabled: boolean): Promise<void> => {
    await fetch("/api/capabilities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability, enabled }),
    });
    await load();
  }, [load]);
  return { capabilities: state, setCapability };
}

/** Polls the agent-advertised session configuration; empty when the agent offers none. */
function useConfigOptions() {
  const [options, setOptions] = useState<WebConfigOption[]>([]);
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/config-options");
      if (response.ok) setOptions((await response.json() as { options: WebConfigOption[] }).options);
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
      if (response.ok) setOptions((await response.json() as { options: WebConfigOption[] }).options);
      else await load();
    }).catch(() => load());
  }, [load]);
  return { options, setOption };
}

/** Categories promoted to composer-adjacent chips; everything else lives in
 * the settings dialog. Provider rides alongside model — the agent's
 * provider/model/effort/mode are the controls an operator reaches for most. */
const COMPOSER_CATEGORIES: readonly string[] = ["provider", "model", "thought_level", "mode"];

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Per-category glyph for the composer chips — the icon carries the category
 * so the controls need no uppercase labels. One consistent 1.4 stroke. */
function ChipIcon({ category }: { readonly category: string | undefined }) {
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  const svg = (paths: React.ReactNode): React.ReactNode => (
    <svg viewBox="0 0 16 16" width="13" height="13" {...stroke} aria-hidden="true">{paths}</svg>
  );
  switch (category) {
    case "provider":
      return svg(<><rect x="2.5" y="2.5" width="11" height="4.5" rx="1" /><rect x="2.5" y="9" width="11" height="4.5" rx="1" /><path d="M5 4.7h0.01M5 11.3h0.01" strokeWidth="2" /></>);
    case "model":
      return svg(<><path d="M8 2l1.1 3 3.1 1.1-3.1 1.1L8 10.2 6.9 7.2 3.8 6.1l3.1-1.1z" /><path d="M11.5 10.5l0.55 1.45L13.5 12.5l-1.45 0.55L11.5 14.5l-0.55-1.45L9.5 12.5l1.45-0.55z" /></>);
    case "thought_level":
      return svg(<path d="M8.8 1.5L3.5 9h3.3L6.2 14.5 12.5 6.5H9.2z" />);
    case "mode":
      return svg(<><path d="M8 2.5l5.5 3L8 8.5 2.5 5.5z" /><path d="M2.5 8.5l5.5 3 5.5-3" /><path d="M2.5 11.5l5.5 3 5.5-3" /></>);
    default:
      return svg(<><path d="M3 5h10M3 11h10" /><circle cx="6" cy="5" r="1.6" /><circle cx="10" cy="11" r="1.6" /></>);
  }
}

/** Composer-adjacent quick pickers (provider/model/effort/mode) rendered as
 * quiet ghost controls in the composer card footer; the full surface lives in
 * the SettingsDialog. */
function ConfigChips({ options, setOption }: {
  readonly options: readonly WebConfigOption[];
  readonly setOption: (id: string, value: string | boolean) => void;
}) {
  const pickers = options.filter((option) => option.type === "select" && option.category !== undefined && COMPOSER_CATEGORIES.includes(option.category));
  if (pickers.length === 0) return null;

  return (
    <div className="composer-chips">
      {pickers.map((option) => (
        <span className="config-picker" key={option.id} title={option.description ?? option.name}>
          <ChipIcon category={option.category} />
          <ConfigField option={option} setOption={setOption} />
        </span>
      ))}
    </div>
  );
}

/** In-thread permission prompt card; the hub parks a request until answered.
 * The authorization boundary is the loudest card in the thread: focus lands
 * on Allow when it appears, the groups read as allow-vs-deny, and the
 * "always" choices state their scope. */
function PermissionPrompt({ pending, answer, remembered }: {
  readonly pending: PendingPermission;
  readonly answer: (id: string, decision: PermissionDecision) => Promise<void>;
  readonly remembered: number;
}) {
  const allowRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A parked prompt is a blocking decision: bring it into view and put
    // focus where the answer starts. Focus also announces it to screen readers.
    cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    allowRef.current?.focus();
  }, [pending.id]);
  return (
    <div className="part part-permission" role="alertdialog" aria-label={`Permission request for ${pending.tool}`} ref={cardRef}>
      <div className="part-permission-head">
        <span className="part-permission-label">Permission required</span>
        <code className="part-permission-tool">{pending.tool}</code>
        {remembered > 0 && <span className="part-permission-remembered">{remembered} remembered</span>}
      </div>
      {pending.subjects.length > 0 && <div className="part-subjects">{pending.subjects.join("  ")}</div>}
      {pending.inputPreview !== undefined && <pre className="part-permission-input">{pending.inputPreview}</pre>}
      <div className="part-permission-actions">
        <div className="part-permission-group">
          <button ref={allowRef} className="btn" onClick={() => void answer(pending.id, "allow_once")}>Allow</button>
          <button className="btn btn-ghost" title={`Don't ask again for ${pending.tool} (policy still applies)`} onClick={() => void answer(pending.id, "allow_always")}>Always allow this tool</button>
        </div>
        <span className="part-permission-separator" aria-hidden="true" />
        <div className="part-permission-group">
          <button className="btn btn-ghost" onClick={() => void answer(pending.id, "reject_once")}>Deny</button>
          <button className="btn btn-ghost" title={`Always reject ${pending.tool} without asking`} onClick={() => void answer(pending.id, "reject_always")}>Always deny this tool</button>
        </div>
      </div>
    </div>
  );
}

/** The session's single usage readout (composer meta row): a context-window
 * fill bar plus cumulative tokens and cost. Context fill needs both the
 * latest context input (proxy) and the agent-reported window (ACP
 * usage_update); without the window the used count still shows, honestly. */
function UsageMeter() {
  const usage = useSessionUsage();
  if (usage === undefined) return null;
  const contextUsed = usage.latestPromptTokens;
  const contextWindow = usage.contextWindowTokens;
  const fillPct = contextUsed !== undefined && contextWindow !== undefined && contextWindow > 0
    ? Math.min(100, Math.round((contextUsed / contextWindow) * 100))
    : undefined;
  return (
    <div className="usage-meter" title={`${usage.requests} metered model request(s)`}>
      {contextUsed !== undefined && (
        <span
          className="usage-context"
          aria-label={contextWindow === undefined
            ? `${contextUsed} tokens in the latest model context input`
            : `Context ${contextUsed} of ${contextWindow} tokens used (${fillPct}%)`}
        >
          <span className="usage-context-bar" aria-hidden="true">
            <span className="usage-context-fill" style={{ "--context-fill-scale": `${(fillPct ?? 0) / 100}` } as React.CSSProperties} />
          </span>
          Context {formatTokens(contextUsed)}
          {contextWindow !== undefined && <> / {formatTokens(contextWindow)}</>}
          {fillPct !== undefined && <> · {fillPct}%</>}
        </span>
      )}
      <span className="usage-tokens" aria-label={`${usage.promptTokens} prompt tokens, ${usage.completionTokens} completion tokens`}>
        ↑{formatTokens(usage.promptTokens)} ↓{formatTokens(usage.completionTokens)} tokens
      </span>
      <span className="usage-cost" aria-label={`${usage.costUsd} US dollars`}>${usage.costUsd.toFixed(4)}</span>
    </div>
  );
}

/** Header toggle: hides the git rail and inspector so the thread centers.
 * The state lives in App so the settings dialog's Focus mode row and this
 * button always read/write the same setting. */
const RAILS_KEY = "workflow.rails";

function RailsToggle({ off, onToggle }: {
  readonly off: boolean;
  readonly onToggle: (off: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="rail-toggle"
      aria-pressed={off}
      title={off ? "Show the git rail and inspector panels" : "Focus the conversation — hide the side panels"}
      onClick={() => onToggle(!off)}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <path d="M5.8 2.5v11M10.2 2.5v11" />
      </svg>
    </button>
  );
}

/** Live activity while a turn runs: what the agent is doing plus elapsed time.
 * The status reads the same projection the transcript renders — no extra
 * server surface. */
function WorkingStatus() {
  const { items } = useSessionState();
  const [elapsed, setElapsed] = useState(0);
  const startedRef = useRef(0);
  useEffect(() => {
    startedRef.current = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="working" role="status" aria-live="polite">
      <span className="working-dot" aria-hidden="true" />
      <span className="working-activity">{describeActivity(items)}</span>
      {/* The elapsed counter is a glance affordance; the live region carries
          the activity text only, so screen readers are not re-announced
          every second. */}
      <span className="working-elapsed" aria-hidden="true">{formatElapsed(elapsed)}</span>
    </div>
  );
}

/** Empty-state suggestions; presentation-only — they fill the composer. */
const SUGGESTED_PROMPTS: readonly string[] = [
  "Explain what the failing tests in this repository cover",
  "Draft a plan for the next change, then wait for my approval",
  "Summarize the working-tree changes",
];

function SessionsPanel({ sessions, refresh }: { readonly sessions: SessionMeta[]; readonly refresh: () => Promise<void> }) {
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; title: string } | undefined>(undefined);
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
  const commitRename = async (): Promise<void> => {
    if (renaming === undefined) return;
    await fetch("/api/sessions/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: renaming.id, title: renaming.title }),
    });
    setRenaming(undefined);
    await refresh();
  };
  const hasUnused = sessions.some((session) => !session.active && session.title === "New session");
  // Title search over the registry (local-first): transcripts live in the
  // agent process, so what the registry holds is what can be searched.
  const needle = query.trim().toLowerCase();
  const visible = needle === "" ? sessions : sessions.filter((session) => session.title.toLowerCase().includes(needle));
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
      <input
        className="sessions-search"
        type="search"
        placeholder="Search sessions"
        aria-label="Search sessions by title"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="sessions-list">
        {visible.length === 0 && needle !== "" && <p className="muted sessions-none">no sessions match</p>}
        {visible.map((session) => (
          <div className={`session-row ${session.active ? "session-active" : ""} ${pending === session.id ? "session-pending" : ""}`} key={session.id}>
            {renaming?.id === session.id ? (
              <span className="session-rename">
                <input
                  aria-label={`New title for ${session.title}`}
                  value={renaming.title}
                  autoFocus
                  onChange={(event) => setRenaming({ id: session.id, title: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void commitRename();
                    if (event.key === "Escape") setRenaming(undefined);
                  }}
                />
                <button className="btn btn-ghost session-rename-save" aria-label="Save title" onClick={() => void commitRename()} disabled={pending !== undefined}>✓</button>
                <button className="btn btn-ghost session-rename-cancel" aria-label="Cancel rename" onClick={() => setRenaming(undefined)}>×</button>
              </span>
            ) : (
              <>
                <button
                  className="session-activate"
                  onClick={() => switchTo(session.id)}
                  aria-current={session.active}
                  disabled={pending !== undefined}
                >
                  <span className="session-heading">
                    {session.active && <span className="session-active-dot" aria-hidden="true" />}
                    <span className="session-title">{pending === session.id ? "loading…" : session.title}</span>
                  </span>
                  <span className="session-time" title={new Date(session.updatedAt).toLocaleString()}>{formatRelativeTime(session.updatedAt)}</span>
                </button>
                <button
                  className="session-dismiss session-rename-trigger"
                  onClick={() => setRenaming({ id: session.id, title: session.title })}
                  aria-label={`Rename ${session.title}`}
                  disabled={pending !== undefined}
                >
                  ✎
                </button>
                <button
                  className="session-dismiss"
                  onClick={() => dismissSession(session.id, refresh)}
                  aria-label={`Dismiss ${session.title}`}
                  disabled={pending !== undefined}
                >
                  ×
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Collects a message's visible text (skips data parts) for copy/edit. User
 * messages render plain `.msg-text`; assistant messages render markdown into
 * `.aui-md`, so both containers contribute (rendered text, not source).
 */
function messageTextOf(root: Element | null): string {
  if (root === null) return "";
  const collected = [...root.querySelectorAll<HTMLElement>(".msg-text, .aui-md")];
  return collected
    .map((element) => element.innerText || (element.textContent ?? ""))
    .join("\n\n")
    .trim();
}

/** Loads text into the aui composer via the native setter so React picks it up. */
function setComposerText(text: string): void {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(".composer-input");
  if (input === null) return;
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
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
      <div className="msg-actions">
        <button
          type="button"
          className="copy-button"
          title="Copy message"
          onClick={(event) => navigator.clipboard.writeText(messageTextOf(event.currentTarget.closest(".msg"))).catch(() => undefined)}
        >
          Copy
        </button>
        <button
          type="button"
          className="copy-button"
          title="Edit and resubmit"
          onClick={(event) => setComposerText(messageTextOf(event.currentTarget.closest(".msg")))}
        >
          Edit
        </button>
      </div>
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
              plan: PlanPart,
              thinking: ThinkingPart,
              tool: ToolPart,
            },
          },
        }}
      />
      <div className="msg-actions">
        <button
          type="button"
          className="copy-button"
          title="Copy message"
          onClick={(event) => navigator.clipboard.writeText(messageTextOf(event.currentTarget.closest(".msg"))).catch(() => undefined)}
        >
          Copy
        </button>
      </div>
    </MessagePrimitive.Root>
  );
}

/** Tail affordance after a finished turn: re-sends the last prompt through the
 * same send path as the composer, so a slow-to-settle turn parks it in the
 * queue instead of silently losing it. */
function RegenerateAction() {
  const { isRunning, items, queuePrompt } = useSessionState();
  if (isRunning) return null;
  const lastUser = [...items].reverse().find((item) => item.kind === "user");
  const last = items.at(-1);
  if (lastUser === undefined || lastUser.kind !== "user") return null;
  if (last === undefined || (last.kind !== "completion" && last.kind !== "assistant")) return null;
  return (
    <div className="thread-tail">
      <button className="btn btn-ghost" onClick={() => queuePrompt(lastUser.text)}>
        Regenerate
      </button>
    </div>
  );
}

/** Queued-prompt indicator: held while a turn runs, auto-sent when it settles.
 * Echoes the queued text so the operator never wonders what will be sent. */
function QueueIndicator() {
  const { queuedPrompt, discardQueue } = useSessionState();
  if (queuedPrompt === undefined) return null;
  const preview = queuedPrompt.length > 80 ? `${queuedPrompt.slice(0, 80)}…` : queuedPrompt;
  return (
    <div className="queue-indicator" role="status">
      <span>
        Queued — <strong>{preview}</strong> — sends when the agent finishes
      </span>
      <button className="btn btn-ghost" aria-label="Discard queued prompt" onClick={discardQueue}>Discard</button>
    </div>
  );
}

/** Exports the active session transcript as a markdown download. */
function ExportSessionButton() {
  const { items } = useSessionState();
  return (
    <button
      className="btn btn-ghost export-button"
      title="Export this session as markdown"
      onClick={() => downloadMarkdown(exportMarkdownOf(items))}
    >
      Export
    </button>
  );
}

function exportMarkdownOf(items: readonly OperatorSessionItem[]): { readonly name: string; readonly text: string } {
  const lines: string[] = ["# Workflow session", ""];
  for (const item of items) {
    switch (item.kind) {
      case "user":
        lines.push("## Prompt", "", item.text, "");
        break;
      case "assistant":
        lines.push("## Assistant", "", item.text, "");
        break;
      case "thinking":
        lines.push("<details><summary>Thinking</summary>", "", fencedBlock(item.text), "");
        break;
      case "plan":
        lines.push("### Plan", "");
        for (const entry of item.entries) {
          lines.push(`- [${entry.status === "completed" ? "x" : " "}] ${entry.content}`);
        }
        lines.push("");
        break;
      case "tool":
        lines.push(`**Tool — ${item.title}** (${item.status})`);
        if (item.rawInput !== undefined) lines.push("", "Input:", "", fencedBlock(item.rawInput));
        if (item.rawOutput !== undefined) lines.push("", "Output:", "", fencedBlock(item.rawOutput));
        lines.push("");
        break;
      case "action":
        lines.push(`**Action:** ${item.action}${item.subjects.length > 0 ? ` — ${item.subjects.join(", ")}` : ""}`, "");
        break;
      case "outcome":
        lines.push(`**Outcome:** ${item.action} — ${item.outcome}`, "");
        break;
      case "attention":
        lines.push(`> ${item.text}`, "");
        break;
      case "completion":
        lines.push(`---`, "", `*Turn ${item.outcome}${item.text.length > 0 ? `: ${item.text}` : ""}*`, "");
        break;
    }
  }
  return { name: `workflow-session-${new Date().toISOString().slice(0, 10)}.md`, text: lines.join("\n") };
}

/** Wraps text in a fence one longer than any backtick run inside it, so
 * re-exported transcripts (round-tripped through the agent) cannot break it. */
function fencedBlock(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function downloadMarkdown(exported: { readonly name: string; readonly text: string }): void {
  const blob = new Blob([exported.text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exported.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Composer({ options, setOption }: {
  readonly options: readonly WebConfigOption[];
  readonly setOption: (id: string, value: string | boolean) => void;
}) {
  const { isRunning, queuePrompt } = useSessionState();
  return (
    <ComposerPrimitive.Root
      className="composer"
      onKeyDown={(event) => {
        // While a turn runs, the framework composer swallows Enter; route the
        // follow-up through the queue path instead (sent when the turn ends).
        if (!isRunning || event.key !== "Enter" || event.shiftKey) return;
        // IME composition (Chinese/Japanese input) owns its Enter commits.
        if (event.nativeEvent.isComposing) return;
        const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(".composer-input");
        const text = (input?.value ?? "").trim();
        if (text.length === 0) return;
        event.preventDefault();
        queuePrompt(text);
        setComposerText("");
      }}
    >
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
      <ComposerPrimitive.Input
        className="composer-input"
        placeholder={isRunning ? "Queue a follow-up — sends when the agent finishes" : "Describe the work to perform"}
        submitMode="enter"
        aria-label="Prompt"
      />
      <div className="composer-footer">
        <ConfigChips options={options} setOption={setOption} />
        <div className="composer-actions">
          <ComposerPrimitive.AddAttachment className="composer-icon-btn" aria-label="Attach image" multiple>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.5 3.5l3 3L7 13H4v-3l6.5-6.5z" />
              <path d="M12.5 5.5l-1.8-1.8" />
            </svg>
          </ComposerPrimitive.AddAttachment>
          <AuiIf condition={(state) => state.thread.isRunning}>
            <ComposerPrimitive.Cancel className="composer-icon-btn composer-stop-btn" aria-label="Cancel the running turn">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                <rect x="4" y="4" width="8" height="8" rx="1.5" />
              </svg>
            </ComposerPrimitive.Cancel>
          </AuiIf>
          <AuiIf condition={(state) => !state.thread.isRunning}>
            <ComposerPrimitive.Send className="composer-send-btn" aria-label="Send">
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 12.5v-9" />
                <path d="M4.5 7L8 3.5 11.5 7" />
              </svg>
            </ComposerPrimitive.Send>
          </AuiIf>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function Panels({ snapshot, refresh }: {
  readonly snapshot: Snapshot | undefined;
  readonly refresh: () => Promise<void>;
}) {
  return (
    <aside className="panels">
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
              <button className="task-action" onClick={() => advance(task.id, NEXT_STATE[task.state]!, refresh)}>
                {NEXT_STATE_ACTION[task.state]}
              </button>
            )}
            {task.state === "FAILED" && (
              <button className="task-action" onClick={() => retryTask(task.id, refresh)}>Retry</button>
            )}
          </div>
        ))}
        <AddTaskForm refresh={refresh} />
      </section>
      <details className="panel-disclosure">
        <summary><span>Evidence</span><span className="panel-summary-meta">{snapshot?.evidence.length ?? 0}</span></summary>
        <section className="panel-disclosure-body">
        {snapshot === undefined || snapshot.evidence.length === 0
          ? <p className="muted">none observed</p>
          : snapshot.evidence.map((entry, index) => (
            <p className={entry.freshness === "stale" ? "muted" : ""} key={index}>
              {entry.subject}: {entry.result} / {entry.freshness}
            </p>
          ))}
        <RecordEvidenceForm refresh={refresh} />
        </section>
      </details>
      <details className="panel-disclosure">
        <summary><span>History</span><span className="panel-summary-meta">{snapshot?.history.length ?? 0}</span></summary>
        <section className="panel-disclosure-body">
        {snapshot === undefined || snapshot.history.length === 0
          ? <p className="muted">no transitions</p>
          : snapshot.history.slice(-8).map((entry, index) => (
            <p key={index}>{entry.taskId}: {entry.from} → {entry.to}</p>
          ))}
        </section>
      </details>
    </aside>
  );
}

const GIT_STATUS_MARK: Record<GitChange["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
  untracked: "?",
};

function GitRail({ status }: { readonly status: GitStatus | undefined }) {
  const [open, setOpen] = useState<{ path: string; diff: string | undefined } | undefined>(undefined);
  const diffRequestRef = useRef(0);
  const openDiff = async (path: string): Promise<void> => {
    const request = ++diffRequestRef.current;
    setOpen({ path, diff: undefined });
    try {
      const response = await fetch(`/api/git/diff?path=${encodeURIComponent(path)}`);
      const nextDiff = response.ok
        ? (await response.json() as { diff: string }).diff
        : `Diff unavailable (HTTP ${response.status})`;
      if (request === diffRequestRef.current) setOpen({ path, diff: nextDiff });
    } catch {
      if (request === diffRequestRef.current) setOpen({ path, diff: "Diff unavailable (network error)" });
    }
  };
  // Closing invalidates any in-flight fetch so a late response cannot reopen
  // the popout the operator just dismissed.
  const closeDiff = (): void => {
    diffRequestRef.current += 1;
    setOpen(undefined);
  };
  return (
    <aside className="git-rail" aria-label="Repository changes">
      <div className="git-rail-head">
        <span className="git-branch" title={status?.branch}>⌘ {status?.branch ?? "repository"}</span>
        <span className="git-count">{status?.changes.length ?? 0}</span>
      </div>
      <div className="git-changes">
        {status !== undefined && status.changes.length === 0 && <p className="muted">working tree clean</p>}
        {(status?.changes ?? []).map((change) => (
          <button key={change.path} className="git-change" aria-haspopup="dialog" onClick={() => void openDiff(change.path)}>
            <span className={`git-status git-status-${change.status}`}>{GIT_STATUS_MARK[change.status]}</span>
            <span className="git-path" title={change.path}>{change.path}</span>
          </button>
        ))}
      </div>
      {open !== undefined && (
        <DiffDialog path={open.path} diff={open.diff} onClose={closeDiff} />
      )}
    </aside>
  );
}

/** Full diff for one changed file in a proper popout — the sidebar is too
 * narrow to read a diff inline. Shares the settings dialog's chrome. */
function DiffDialog({ path, diff, onClose }: {
  readonly path: string;
  readonly diff: string | undefined;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      openerRef.current?.focus();
    };
  }, []);
  return (
    <div
      className="settings-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="settings-dialog diff-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Diff for ${path}`}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="settings-head">
          <h2 className="diff-dialog-title"><code>{path}</code></h2>
          <button type="button" className="btn btn-ghost settings-close" aria-label="Close diff" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="settings-body diff-dialog-body">
          {diff === undefined
            ? <p className="muted">loading diff…</p>
            : looksLikeDiff(diff) ? <DiffText text={diff} /> : <pre className="git-diff">{diff}</pre>}
        </div>
      </div>
    </div>
  );
}

function retryTask(taskId: string, refresh: () => Promise<void>): void {
  void fetch("/api/tasks/retry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId }),
  }).then(() => refresh());
}

/** Compact form for the hub's addTask: id + title, added BLOCKED. */
function AddTaskForm({ refresh }: { readonly refresh: () => Promise<void> }) {
  const [taskId, setTaskId] = useState("");
  const [title, setTitle] = useState("");
  const submit = (): void => {
    void fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, title }),
    }).then((response) => {
      if (response.ok) {
        setTaskId("");
        setTitle("");
      }
      void refresh();
    });
  };
  return (
    <form
      className="task-add"
      onSubmit={(event) => {
        event.preventDefault();
        if (taskId.trim().length > 0 && title.trim().length > 0) submit();
      }}
    >
      <input aria-label="New task id" placeholder="id" value={taskId} onChange={(event) => setTaskId(event.target.value)} />
      <input aria-label="New task title" placeholder="title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <button className="btn btn-ghost" type="submit">Add task</button>
    </form>
  );
}

/** Compact form for the hub's recordEvidence (reviewer authority, fresh). */
function RecordEvidenceForm({ refresh }: { readonly refresh: () => Promise<void> }) {
  const [subject, setSubject] = useState("");
  const [result, setResult] = useState<"passed" | "failed">("passed");
  const submit = (): void => {
    void fetch("/api/evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject, result }),
    }).then((response) => {
      if (response.ok) setSubject("");
      void refresh();
    });
  };
  return (
    <form
      className="evidence-add"
      onSubmit={(event) => {
        event.preventDefault();
        if (subject.trim().length > 0) submit();
      }}
    >
      <input aria-label="Evidence subject" placeholder="subject" value={subject} onChange={(event) => setSubject(event.target.value)} />
      <select aria-label="Evidence result" value={result} onChange={(event) => setResult(event.target.value === "failed" ? "failed" : "passed")}>
        <option value="passed">passed</option>
        <option value="failed">failed</option>
      </select>
      <button className="btn btn-ghost" type="submit">Record</button>
    </form>
  );
}

const ENFORCEMENT_COPY: Record<string, string> = {
  advisory: "Advisory: the agent's actions are reviewed and recorded, but file and command mutations are not pre-authorized before they run.",
  enforced: "Enforced: agent file and command mutations require Workflow authorization before they run.",
};

/**
 * Safety-relevant fact, styled as one: advisory can never render equivalent
 * to enforced (PRODUCT.md invariant), so advisory is a persistent amber
 * outline badge and enforced a neutral filled one in the header.
 */
function EnforcementBadge({ level, transport, copy }: {
  readonly level: string | undefined;
  readonly transport: string | undefined;
  readonly copy: string | undefined;
}) {
  if (level === undefined) return <span className="shell-host">connecting</span>;
  return (
    <span
      className={`enforcement-badge enforcement-${level}`}
      title={copy}
      aria-label={copy ?? "enforcement level unavailable"}
    >
      {level.toUpperCase()}
      {transport !== undefined && <span className="enforcement-transport"> / {transport}</span>}
    </span>
  );
}

export function App() {
  const { snapshot, refresh } = useSnapshot();
  const gitStatus = useGitStatus();
  const { sessions, refresh: refreshSessions } = useSessions();
  const { options, setOption } = useConfigOptions();
  const permissions = usePermissions();
  const capabilities = useCapabilities();
  const { isRunning } = useSessionState();
  const theme = useTheme();
  const usage = useSessionUsage();
  const enforcementCopy = snapshot === undefined ? undefined : ENFORCEMENT_COPY[snapshot.enforcementLevel];
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Focus mode state lives here so the header button and the settings dialog
  // read and write one setting (pre-paint application happens in main.tsx).
  const [railsOff, setRailsOff] = useState((): boolean => {
    try {
      return window.localStorage.getItem(RAILS_KEY) === "off";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.dataset.rails = railsOff ? "off" : "on";
    try {
      window.localStorage.setItem(RAILS_KEY, railsOff ? "off" : "on");
    } catch {
      // Storage unavailable: the toggle applies for this session only.
    }
  }, [railsOff]);

  // Keyboard shortcuts: "/" focuses the composer, Escape cancels a running
  // turn (when no popover/input has focus), Alt+N starts a new session,
  // Ctrl/Cmd+, opens settings. While the settings dialog is open it owns the
  // keyboard — focus never jumps out from behind the modal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const active = document.activeElement;
      const typing = active instanceof HTMLElement &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (event.key === "/" && !typing && document.querySelector(".settings-dialog") === null) {
        event.preventDefault();
        document.querySelector<HTMLElement>(".composer-input")?.focus();
      } else if (
        event.key === "Escape" && isRunning && !typing &&
        // Any open chrome (settings dialog, model combobox) owns this Escape;
        // cancelling a running turn must never ride along with closing it.
        document.querySelector(".settings-dialog, .config-combobox-pop") === null
      ) {
        void fetch("/api/cancel", { method: "POST" });
      } else if (
        event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "n" && !typing &&
        document.querySelector(".settings-dialog") === null
      ) {
        event.preventDefault();
        createSession(refreshSessions);
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isRunning, refreshSessions]);

  const activeTitle = sessions?.find((session) => session.active)?.title;

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-header-left">
          <RailsToggle off={railsOff} onToggle={setRailsOff} />
          <h1 className="shell-wordmark">Workflow</h1>
          {activeTitle !== undefined && (
            <span className="shell-session-title" title={activeTitle}>{activeTitle}</span>
          )}
        </div>
        <div className="shell-header-actions">
          <EnforcementBadge level={snapshot?.enforcementLevel} transport={snapshot?.transport} copy={enforcementCopy} />
          <button
            type="button"
            className="btn btn-ghost config-gear"
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <GearIcon />
          </button>
        </div>
      </header>
      <div className="shell-body">
        <aside className="sidebar" aria-label="Sessions and repository changes">
          {sessions !== undefined && <SessionsPanel sessions={sessions} refresh={refreshSessions} />}
          <GitRail status={gitStatus} />
        </aside>
        <section className="chat-column">
          <ThreadPrimitive.Root className="thread-root">
            <ThreadPrimitive.Viewport className="thread-viewport">
              <AuiIf condition={(state) => state.thread.isEmpty}>
                <div className="welcome">
                  <p className="welcome-lede">Describe the work to perform. Every action the agent takes is proposed and authorized through Workflow.</p>
                  <div className="welcome-suggestions">
                    {SUGGESTED_PROMPTS.map((prompt) => (
                      <button type="button" className="welcome-chip" key={prompt} onClick={() => setComposerText(prompt)}>
                        {prompt}
                      </button>
                    ))}
                  </div>
                  <p className="welcome-hints">
                    <kbd>/</kbd> focus · <kbd>Enter</kbd> send · <kbd>Esc</kbd> cancel · <kbd>Alt</kbd>+<kbd>N</kbd> new session · <kbd>Ctrl</kbd>+<kbd>,</kbd> settings
                  </p>
                </div>
              </AuiIf>
              <ThreadPrimitive.Messages>
                {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
              </ThreadPrimitive.Messages>
              {permissions.pending !== null && (
                <PermissionPrompt
                  pending={permissions.pending}
                  answer={permissions.answer}
                  remembered={permissions.patterns.alwaysAllow.length + permissions.patterns.alwaysReject.length}
                />
              )}
              <RegenerateAction />
              <AuiIf condition={(state) => state.thread.isRunning}>
                <WorkingStatus />
              </AuiIf>
            </ThreadPrimitive.Viewport>
            <div className="composer-dock">
              <Composer options={options} setOption={setOption} />
              <QueueIndicator />
              <div className="composer-meta">
                {usage !== undefined && <UsageMeter />}
                <ExportSessionButton />
              </div>
            </div>
          </ThreadPrimitive.Root>
        </section>
        <aside className="inspector" aria-label="Workflow supervision">
          <Panels snapshot={snapshot} refresh={refresh} />
        </aside>
      </div>
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          themeChoice={theme.choice}
          onThemeChoice={theme.setChoice}
          railsOff={railsOff}
          onRailsToggle={setRailsOff}
          options={options}
          setOption={setOption}
          permissions={permissions}
          capabilities={capabilities}
          enforcement={{ level: snapshot?.enforcementLevel, transport: snapshot?.transport, copy: enforcementCopy }}
        />
      )}
    </div>
  );
}
