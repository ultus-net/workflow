import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { describeActivity, formatElapsed, formatTokens } from "./presenters.js";
import { useSessionState, useSessionUsage, useAgentIdentity, WorkflowRuntimeProvider, type SessionUsage } from "./runtime.js";
import { SettingsDialog } from "./settings-dialog.js";
import { SessionsView } from "./sessions-view.js";
import { UsageView } from "./usage-view.js";
import { listPalettes } from "./theme/palettes.js";
import { usePalette, useTheme } from "./theme.js";
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

export interface GitWorktree {
  readonly path: string;
  readonly head?: string;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly current: boolean;
}

/** Polls the repository's git worktree list; undefined when unavailable. */
function useWorktrees() {
  const [worktrees, setWorktrees] = useState<readonly GitWorktree[] | undefined>(undefined);
  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/worktrees");
        if (response.ok) setWorktrees((await response.json() as { worktrees: readonly GitWorktree[] }).worktrees);
      } catch {
        // Keep the last good list; the next poll retries.
      }
    };
    void load();
    const timer = setInterval(() => void load(), PANEL_POLL_MS);
    return () => clearInterval(timer);
  }, []);
  return worktrees;
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

export interface SessionMeta {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly active: boolean;
  readonly agent: string;
  /** A live ACP runtime is spawned for this session (parallel sessions). */
  readonly live?: boolean;
  /** The live runtime's turn is in flight. */
  readonly busy?: boolean;
  /** The ACP handshake version, when this session's runtime reported one. */
  readonly version?: string;
}

export interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly containment: "contained" | "advisory";
  readonly available: boolean;
  readonly reason?: string;
}

/** Polls the agents the server can compose (availability + posture). */
function useAgents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/agents");
        if (response.ok) setAgents((await response.json() as { agents: AgentInfo[] }).agents);
      } catch {
        // Keep the last good list; the next poll retries.
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);
  return agents;
}

/** Switches the active session's agent server-side, then refreshes the registry. */
function switchAgent(agent: string, refresh: () => Promise<void>): void {
  void fetch("/api/sessions/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent }),
  }).then((response) => {
    // Refresh either way: on success the new agent shows; on 409/503 the list
    // re-syncs to the agent the server actually kept, so the radio never lies.
    if (!response.ok) console.warn(`agent switch rejected: ${response.status}`);
    void refresh();
  }).catch(() => {});
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
function usePermissions(sessionId: string | undefined) {
  const [state, setState] = useState<PermissionsState>({
    available: false,
    mode: "auto",
    pending: null,
    patterns: { alwaysAllow: [], alwaysReject: [] },
  });
  const sessionSuffix = sessionId === undefined ? "" : `?session=${encodeURIComponent(sessionId)}`;
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/permission${sessionSuffix}`);
      if (response.ok) setState(await response.json() as PermissionsState);
    } catch {
      // Keep the last good state; the next poll retries.
    }
  }, [sessionSuffix]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), PERMISSION_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  const answer = useCallback(async (id: string, decision: PermissionDecision): Promise<void> => {
    await fetch(`/api/permission${sessionSuffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    await load();
  }, [load, sessionSuffix]);
  const update = useCallback(async (body: { mode?: "auto" | "ask"; reset?: boolean }): Promise<void> => {
    await fetch(`/api/permission-mode${sessionSuffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await load();
  }, [load, sessionSuffix]);
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
/** Last-used value per ACP option, persisted locally so the operator's choices
 * survive reload and the agent reconnecting with its factory default. */
const LAST_USED_KEY = "workflow.config-last-used";

function readLastUsed(): Record<string, string | boolean> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(LAST_USED_KEY) ?? "{}");
    return stored !== null && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, string | boolean> : {};
  } catch {
    return {};
  }
}

function writeLastUsed(id: string, value: string | boolean): void {
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify({ ...readLastUsed(), [id]: value }));
  } catch {
    // Private browsing or quota: persistence is best-effort.
  }
}

function useConfigOptions(sessionId: string | undefined) {
  const [options, setOptions] = useState<WebConfigOption[]>([]);
  // Option ids whose last-used value we already pushed to the agent this
  // session, so a reconnect can't loop restore→default→restore.
  const restoredRef = useRef<Set<string>>(new Set());
  const sessionSuffix = sessionId === undefined ? "" : `?session=${encodeURIComponent(sessionId)}`;
  // A different session is a fresh restore scope: its agent may have reverted
  // to factory defaults and deserves the operator's last-used values again.
  useEffect(() => {
    restoredRef.current = new Set();
  }, [sessionSuffix]);
  const setOption = useCallback((id: string, value: string | boolean): void => {
    // Optimistic: reflect the choice now, reconcile with the server response.
    writeLastUsed(id, value);
    setOptions((previous) => previous.map((option) => option.id === id ? { ...option, currentValue: value } : option));
    void fetch(`/api/config-options${sessionSuffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, value }),
    }).then(async (response) => {
      if (response.ok) setOptions((await response.json() as { options: WebConfigOption[] }).options);
    }).catch(() => {});
  }, [sessionSuffix]);
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/config-options${sessionSuffix}`);
      if (!response.ok) return;
      const fresh = (await response.json() as { options: WebConfigOption[] }).options;
      // Restore the operator's last-used value wherever the agent reverted to
      // its factory default. Each option is restored at most once per session,
      // and the restored value is merged into the displayed list at once so
      // there is no factory-default flash while the agent catches up.
      const lastUsed = readLastUsed();
      const toRestore = new Map<string, string | boolean>();
      for (const option of fresh) {
        const saved = lastUsed[option.id];
        if (saved === undefined || restoredRef.current.has(option.id)) continue;
        restoredRef.current.add(option.id);
        if (String(option.currentValue) === String(saved)) continue;
        if (option.type === "select" && option.choices !== undefined && !option.choices.some((choice) => choice.value === saved)) continue;
        toRestore.set(option.id, saved);
      }
      if (toRestore.size > 0) {
        setOptions(fresh.map((option) => toRestore.has(option.id) ? { ...option, currentValue: toRestore.get(option.id) as string | boolean } : option));
        for (const [id, value] of toRestore) setOption(id, value);
      } else {
        setOptions(fresh);
      }
    } catch {
      // Keep the last good list; the next poll retries.
    }
  }, [setOption]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), PANEL_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { options, setOption };
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.1" />
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.2v1.7M8 13.1v1.7M14.8 8h-1.7M2.9 8H1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2M12.7 12.7l-1.2-1.2M4.5 4.5L3.3 3.3" />
    </svg>
  );
}

/** Nav slug glyphs — the icon sits over the label (icons over names). */
function ChatIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5h11v7h-5l-3 3v-3h-3z" />
    </svg>
  );
}

/** Coin-stack glyph for the Usage slug. */
function UsageIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="8" cy="4.2" rx="5" ry="2.2" />
      <path d="M3 4.2v3.6c0 1.2 2.24 2.2 5 2.2s5-1 5-2.2V4.2" />
      <path d="M3 7.8v3.6c0 1.2 2.24 2.2 5 2.2s5-1 5-2.2V7.8" />
    </svg>
  );
}
function SessionsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="4.2" />
      <rect x="2.5" y="9.3" width="11" height="4.2" />
      <circle cx="5" cy="4.6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="5" cy="11.4" r="0.7" fill="currentColor" stroke="none" />
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
 * the SettingsDialog. Exported for the UI-surface regression pin. */
export function ConfigChips({ options, setOption }: {
  readonly options: readonly WebConfigOption[];
  readonly setOption: (id: string, value: string | boolean) => void;
}) {
  const pickers = options.filter((option) => option.type === "select");
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

/** The session's usage readout, rendered inside the status bar (far left):
 * a context-window fill bar plus cumulative tokens and cost. Context fill
 * needs both the latest context input (proxy) and the agent-reported window
 * (ACP usage_update); without the window the used count still shows, honestly. */
function UsageMeter({ usage }: { readonly usage: SessionUsage }) {
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

/** The operator's chosen model: the current value of the model config option,
 * shown by friendly name when the agent advertises choices. */
function currentModelName(options: readonly WebConfigOption[]): string | undefined {
  const model = options.find((option) => option.category === "model" || option.id === "model");
  if (model === undefined) return undefined;
  return model.choices?.find((choice) => choice.value === model.currentValue)?.name ?? String(model.currentValue);
}

/** Bottom status bar: context/tokens far left, model + branch in the middle,
 * the agent's handshake version far right. Live facts only — a slot whose
 * data is unknown renders nothing rather than a placeholder. */
function StatusBar({ identity, model, branch, usage }: {
  readonly identity: { readonly agent?: string | undefined; readonly version?: string | undefined };
  readonly model: string | undefined;
  readonly branch: string | undefined;
  readonly usage: SessionUsage | undefined;
}) {
  return (
    <footer className="status-bar" aria-label="Session status">
      <div className="status-bar-group">
        {usage !== undefined && <UsageMeter usage={usage} />}
        {/* Running is already unmistakable in the composer (stop control) and
            the thread (live activity line); the bar stays factual. */}
      </div>
      <div className="status-bar-group status-bar-middle">
        {model !== undefined && <span className="status-bar-item status-bar-model" title={model}>{model}</span>}
        {branch !== undefined && <span className="status-bar-item status-bar-branch" title={branch}>{branch}</span>}
      </div>
      <div className="status-bar-group status-bar-right">
        {identity.agent !== undefined && (
          <span className="status-bar-item status-bar-agent">
            {identity.agent}
            {identity.version !== undefined && <span className="status-bar-version"> {identity.version}</span>}
          </span>
        )}
      </div>
    </footer>
  );
}

/** Collapsible git worktree list for the left rail: starts closed — the list
 * is reference, not a control. The current worktree is marked; others are
 * read-only facts (switching stays an operator git command). */
function WorktreeRail({ worktrees }: { readonly worktrees: readonly GitWorktree[] | undefined }) {
  const [open, setOpen] = useState(false);
  if (worktrees === undefined || worktrees.length === 0) return null;
  return (
    <details className="worktree-rail panel-disclosure" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>
        <span>Worktrees</span>
        <span className="panel-summary-meta">{worktrees.length}</span>
      </summary>
      <div className="worktree-list">
        {worktrees.map((worktree) => (
          <span
            key={worktree.path}
            className={`worktree-row ${worktree.current ? "worktree-current" : ""}`}
            title={worktree.path}
          >
            <span className="worktree-branch">{worktree.branch ?? (worktree.bare ? "bare" : "detached")}</span>
            {worktree.current && <span className="worktree-here" aria-label="current worktree">here</span>}
          </span>
        ))}
      </div>
    </details>
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" />
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

/** Top-bar views. Sessions is a page (nav slug); session history stays
 * reachable from the composer via the /sessions command. */
export type AppView = "chat" | "sessions" | "usage";

export function App() {
  // The chat view focuses one parallel session at a time; undefined = the
  // server's focused session. State lives above the runtime provider so the
  // poll and every session-scoped fetch carry the same session id.
  const [view, setView] = useState<AppView>("chat");
  const [focusedSessionId, setFocusedSessionId] = useState<string | undefined>(undefined);
  const handleCommand = useCallback((command: string): boolean => {
    const name = command.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (name === "/sessions") {
      setView("sessions");
      return true;
    }
    if (name === "/usage") {
      setView("usage");
      return true;
    }
    if (name === "/chat") {
      setView("chat");
      return true;
    }
    return false;
  }, []);
  return (
    <WorkflowRuntimeProvider sessionId={focusedSessionId} onCommandSession={handleCommand}>
      <AppShell view={view} setView={setView} focusedSessionId={focusedSessionId} setFocusedSessionId={setFocusedSessionId} />
    </WorkflowRuntimeProvider>
  );
}

function AppShell({ view, setView, focusedSessionId, setFocusedSessionId }: {
  readonly view: AppView;
  readonly setView: (view: AppView) => void;
  readonly focusedSessionId: string | undefined;
  readonly setFocusedSessionId: (id: string | undefined) => void;
}) {
  const { snapshot, refresh } = useSnapshot();
  const gitStatus = useGitStatus();
  const worktrees = useWorktrees();
  const { sessions, refresh: refreshSessions } = useSessions();
  const agents = useAgents();
  // The registry leads with the default agent (OpenCode); fall back to it while
  // the agents list is still loading so the switcher never marks the wrong one.
  const currentAgent = sessions?.find((session) => session.active)?.agent ?? agents[0]?.id ?? "opencode";
  const { options, setOption } = useConfigOptions(focusedSessionId);
  const permissions = usePermissions(focusedSessionId);
  const capabilities = useCapabilities();
  const { isRunning } = useSessionState();
  const identity = useAgentIdentity();
  const theme = useTheme();
  const { palette, setPalette } = usePalette();
  const palettes = useMemo(() => listPalettes(), []);
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
        // Escape cancels the session the operator is viewing, not whichever
        // session the server happens to have focused.
        const cancelUrl = focusedSessionId === undefined ? "/api/cancel" : `/api/cancel?session=${encodeURIComponent(focusedSessionId)}`;
        void fetch(cancelUrl, { method: "POST" });
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
  }, [isRunning, refreshSessions, focusedSessionId]);

  const activeTitle = sessions?.find((session) => session.active)?.title;

  const createSessionWithAgent = useCallback((agent: string): void => {
    void fetch("/api/sessions", { method: "POST" }).then((created) => {
      if (!created.ok) return;
      void created.clone().json().then((meta) => {
        const id = (meta as { id?: string }).id;
        if (id === undefined) return;
        return fetch("/api/sessions/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent, session: id }),
        }).then(() => {
          setFocusedSessionId(id);
          void refreshSessions();
        });
      }).catch(() => {});
    }).then(() => refreshSessions());
  }, [refreshSessions, setFocusedSessionId]);

  const switchSession = useCallback((id: string): void => {
    void fetch("/api/sessions/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).then(() => {
      setFocusedSessionId(id);
      void refreshSessions();
    }).catch(() => {});
  }, [refreshSessions, setFocusedSessionId]);

  const runInSession = useCallback(async (id: string, action: () => Promise<Response>): Promise<void> => {
    await action();
    await refreshSessions();
  }, [refreshSessions]);

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-header-left">
          <RailsToggle off={railsOff} onToggle={setRailsOff} />
          <h1 className="shell-wordmark">Workflow</h1>
          <nav className="shell-nav" aria-label="Views">
            {([
              ["chat", "Chat", <ChatIcon key="c" />],
              ["sessions", "Sessions", <SessionsIcon key="s" />],
              ["usage", "Usage", <UsageIcon key="u" />],
            ] as const).map(([slug, label, icon]) => (
              <button
                key={slug}
                type="button"
                className={`shell-nav-slug ${view === slug ? "shell-nav-slug-on" : ""}`}
                aria-current={view === slug ? "page" : undefined}
                onClick={() => setView(slug)}
              >
                {icon}
                <span>{label}</span>
              </button>
            ))}
          </nav>
          {view === "chat" && activeTitle !== undefined && (
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
      {view === "sessions" ? (
        <SessionsView
          sessions={sessions}
          agents={agents}
          onActivate={(id) => switchSession(id)}
          onCreate={(agent) => createSessionWithAgent(agent)}
          onSwitchAgent={(id, agent) => {
            void fetch("/api/sessions/agent", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ agent, session: id }),
            }).then(() => refreshSessions());
          }}
          onRename={(id, title) => {
            void fetch("/api/sessions/rename", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id, title }),
            }).then(() => refreshSessions());
          }}
          onDismiss={(id) => {
            void runInSession(id, () => fetch("/api/sessions/dismiss", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id }),
            })).catch(() => {});
          }}
          onClearUnused={() => {
            void fetch("/api/sessions/dismiss", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ clearUnused: true }),
            }).then(() => refreshSessions());
          }}
          onOpenChat={(id) => {
            switchSession(id);
            setView("chat");
          }}
        />
      ) : view === "usage" ? (
        <UsageView />
      ) : (
      <div className="shell-body">
        <aside className="sidebar" aria-label="Repository changes">
          <WorktreeRail worktrees={worktrees} />
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
                <ExportSessionButton />
              </div>
            </div>
          </ThreadPrimitive.Root>
        </section>
        <aside className="inspector" aria-label="Workflow supervision">
          <Panels snapshot={snapshot} refresh={refresh} />
        </aside>
      </div>
      )}
      <StatusBar
        identity={identity}
        model={currentModelName(options)}
        branch={gitStatus?.branch}
        usage={usage}
      />
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          themeChoice={theme.choice}
          onThemeChoice={theme.setChoice}
          palette={palette}
          onPalette={setPalette}
          palettes={palettes}
          railsOff={railsOff}
          onRailsToggle={setRailsOff}
          options={options}
          setOption={setOption}
          permissions={permissions}
          capabilities={capabilities}
          enforcement={{ level: snapshot?.enforcementLevel, transport: snapshot?.transport, copy: enforcementCopy }}
          agents={agents}
          currentAgent={currentAgent}
          onSwitchAgent={(agent) => switchAgent(agent, refreshSessions)}
        />
      )}
    </div>
  );
}
