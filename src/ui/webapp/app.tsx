import { useCallback, useEffect, useRef, useState } from "react";
import {
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";

import { ActionPart, AttentionPart, CompletionPart, OutcomePart, PlanPart, ThinkingPart, ToolPart } from "./message-parts.js";
import { MarkdownText } from "./markdown-text.js";
import { useSessionState, useSessionUsage } from "./runtime.js";
import type { OperatorSessionItem } from "../operator-session.js";

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

/** Agents may report a current value outside the advertised choices; show it truthfully. */
function withCurrentChoice(option: ConfigOption): ConfigChoice[] {
  const choices = option.choices ?? [];
  const current = String(option.currentValue);
  return choices.some((choice) => choice.value === current)
    ? [...choices]
    : [{ value: current, name: current }, ...choices];
}

function ConfigSelect({ option, setOption, labelledBy }: {
  readonly option: ConfigOption;
  readonly setOption: (id: string, value: string | boolean) => void;
  readonly labelledBy?: string | undefined;
}) {
  const current = String(option.currentValue);
  return (
    <select
      value={current}
      onChange={(event) => setOption(option.id, event.target.value)}
      aria-label={labelledBy === undefined ? option.name : undefined}
      aria-labelledby={labelledBy}
      title={option.description}
    >
      {withCurrentChoice(option).map((choice) => (
        <option value={choice.value} key={choice.value} title={choice.description}>{choice.name}</option>
      ))}
    </select>
  );
}

/** Long lists get a searchable combobox; short lists keep the native select. */
const COMBOBOX_MIN_CHOICES = 8;

/** Per-option favourite choices, persisted locally (presentation-only; never sent to the agent). */
function useFavourites(optionId: string): readonly [readonly string[], (value: string) => void] {
  const key = `workflow.config-favourites.${optionId}`;
  const [favourites, setFavourites] = useState<readonly string[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  });
  const toggle = useCallback((value: string): void => {
    setFavourites((previous) => {
      const next = previous.includes(value) ? previous.filter((entry) => entry !== value) : [...previous, value];
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private browsing or quota: favourites stay session-local.
      }
      return next;
    });
  }, [key]);
  return [favourites, toggle];
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M1 1l4 4 4-4" />
    </svg>
  );
}

function ConfigCombobox({ option, setOption, labelledBy }: {
  readonly option: ConfigOption;
  readonly setOption: (id: string, value: string | boolean) => void;
  readonly labelledBy?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [favourites, toggleFavourite] = useFavourites(option.id);

  const current = String(option.currentValue);
  const all = withCurrentChoice(option);
  const currentName = all.find((choice) => choice.value === current)?.name ?? current;
  const needle = query.trim().toLowerCase();
  const filtered = needle === ""
    ? all
    : all.filter((choice) => choice.name.toLowerCase().includes(needle) || choice.value.toLowerCase().includes(needle));
  const favouriteMatches = filtered.filter((choice) => favourites.includes(choice.value));
  const otherMatches = filtered.filter((choice) => !favourites.includes(choice.value));
  const selectable = [...favouriteMatches, ...otherMatches];
  const showGroups = favouriteMatches.length > 0 && otherMatches.length > 0;

  const closeList = useCallback((focusButton: boolean): void => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }, []);
  const choose = useCallback((value: string): void => {
    setOption(option.id, value);
    closeList(true);
  }, [option.id, setOption, closeList]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === false) closeList(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, closeList]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const openList = (): void => {
    setQuery("");
    // Recompute the reset list from the unfiltered choices: a stale query
    // must not leak into the reopened active index.
    const nextSelectable = [
      ...all.filter((choice) => favourites.includes(choice.value)),
      ...all.filter((choice) => !favourites.includes(choice.value)),
    ];
    setActiveIndex(Math.max(0, nextSelectable.findIndex((choice) => choice.value === current)));
    setOpen(true);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, selectable.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, selectable.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = selectable[activeIndex];
      if (choice !== undefined) choose(choice.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      // This Escape closes the combobox only; the global shortcut handler
      // must not read it as "cancel the running turn".
      event.stopPropagation();
      closeList(true);
    }
  };

  const listId = `config-list-${option.id}`;
  const renderChoice = (choice: ConfigChoice, index: number) => {
    const starred = favourites.includes(choice.value);
    return (
      <li
        key={choice.value}
        id={`config-opt-${option.id}-${index}`}
        role="option"
        aria-selected={choice.value === current}
        className={`config-combobox-option ${index === activeIndex ? "config-combobox-active" : ""}`}
        onMouseDown={(event) => { event.preventDefault(); choose(choice.value); }}
        onMouseEnter={() => setActiveIndex(index)}
      >
        <button
          type="button"
          className={`config-star ${starred ? "config-starred" : ""}`}
          aria-label={starred ? `Remove ${choice.name} from favourites` : `Add ${choice.name} to favourites`}
          aria-pressed={starred}
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.stopPropagation(); toggleFavourite(choice.value); }}
        >
          {starred ? "★" : "☆"}
        </button>
        <span className="config-combobox-name" title={choice.description}>{choice.name}</span>
        {choice.value === current && <span className="config-combobox-check" aria-hidden="true">✓</span>}
      </li>
    );
  };

  return (
    <span className="config-combobox" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="config-combobox-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={labelledBy === undefined ? option.name : undefined}
        aria-labelledby={labelledBy}
        title={option.description}
        onClick={() => (open ? closeList(false) : openList())}
      >
        <span className="config-combobox-value">{currentName}</span>
        <ChevronIcon />
      </button>
      {open && (
        <span
          className="config-combobox-pop"
          onBlur={(event) => {
            // Tab flows through the search input and star toggles; once focus
            // leaves the popover entirely, close it.
            if (event.currentTarget.contains(event.relatedTarget) === false) closeList(false);
          }}
        >
          <input
            ref={inputRef}
            className="config-combobox-search"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={onSearchKeyDown}
            placeholder={`Search ${option.name.toLowerCase()}…`}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={selectable[activeIndex] === undefined ? undefined : `config-opt-${option.id}-${activeIndex}`}
            aria-autocomplete="list"
            aria-label={`Search ${option.name}`}
          />
          <ul className="config-combobox-list" role="listbox" id={listId} aria-label={option.name} ref={listRef}>
            {selectable.length === 0 && <li className="config-combobox-empty">no matches</li>}
            {showGroups && <li className="config-combobox-group" role="presentation">Favourites</li>}
            {favouriteMatches.map((choice, index) => renderChoice(choice, index))}
            {showGroups && <li className="config-combobox-group" role="presentation">All</li>}
            {otherMatches.map((choice, index) => renderChoice(choice, favouriteMatches.length + index))}
          </ul>
        </span>
      )}
    </span>
  );
}

function ConfigField({ option, setOption, labelledBy }: {
  readonly option: ConfigOption;
  readonly setOption: (id: string, value: string | boolean) => void;
  readonly labelledBy?: string | undefined;
}) {
  return (option.choices?.length ?? 0) >= COMBOBOX_MIN_CHOICES
    ? <ConfigCombobox option={option} setOption={setOption} labelledBy={labelledBy} />
    : <ConfigSelect option={option} setOption={setOption} labelledBy={labelledBy} />;
}

function ConfigControls({ options, setOption, permissions, capabilities }: {
  readonly options: readonly ConfigOption[];
  readonly setOption: (id: string, value: string | boolean) => void;
  readonly permissions: ReturnType<typeof usePermissions>;
  readonly capabilities: ReturnType<typeof useCapabilities>;
}) {
  const [open, setOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // stopPropagation is defense-in-depth for the focused-control case;
        // the global Escape handler's open-chrome DOM guard is the primary fix.
        event.stopPropagation();
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
    // Dialogs open with focus inside them, never stranded on the page body.
    popoverRef.current?.querySelector<HTMLElement>("input, select, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const pickers = options.filter((option) => option.type === "select" && option.category !== undefined && COMPOSER_CATEGORIES.includes(option.category));
  const toggles = options.filter((option) => option.type === "boolean");
  const popoverSelects = options.filter((option) => option.type === "select" && !pickers.includes(option));
  const showSettings = permissions.available || toggles.length > 0 || popoverSelects.length > 0;
  if (!showSettings) return null;

  return (
    <div className="config-row">
      {pickers.length > 0 && (
        <div className="config-pickers">
          {pickers.map((option) => (
            <span className="config-picker" key={option.id}>
              <span className="config-picker-label" id={`config-label-${option.id}`}>{option.name}</span>
              <ConfigField option={option} setOption={setOption} labelledBy={`config-label-${option.id}`} />
            </span>
          ))}
        </div>
      )}
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
            {(popoverSelects.length > 0 || toggles.length > 0) && (
              <span className="config-field-label">Agent options</span>
            )}
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
            {permissions.available && (
              <PermissionSettings permissions={permissions} capabilities={capabilities} />
            )}
            <GeneralSettings />
          </div>
        )}
      </span>
    </div>
  );
}

/** Settings popover: completion notifications (opt-in, persisted locally). */
function GeneralSettings() {
  const [notify, setNotify] = useNotifyOnCompletion();
  return (
    <div className="config-permissions">
      <span className="config-field-label">Notifications</span>
      <label className="config-toggle" title="Desktop notification and chime when a turn finishes while the tab is hidden">
        <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} />
        <span className="config-toggle-track" aria-hidden="true"><span className="config-toggle-thumb" /></span>
        <span className="config-toggle-text">
          Notify on completion
          <span className="config-toggle-desc">fires only while the tab is hidden</span>
        </span>
      </label>
    </div>
  );
}

const NOTIFY_KEY = "workflow.notify-completion";

function useNotifyOnCompletion(): readonly [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(() => window.localStorage.getItem(NOTIFY_KEY) === "true");
  const update = useCallback((value: boolean): void => {
    window.localStorage.setItem(NOTIFY_KEY, String(value));
    if (value && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    setEnabled(value);
  }, []);
  return [enabled, update];
}

/** Ask-mode and capability toggles inside the settings popover. */
function PermissionSettings({ permissions, capabilities }: {
  readonly permissions: ReturnType<typeof usePermissions>;
  readonly capabilities: ReturnType<typeof useCapabilities>;
}) {
  const confinement = capabilities.capabilities?.workspaceConfinement ?? false;
  const processEnabled = capabilities.capabilities?.capabilities.includes("process") ?? false;
  const networkEnabled = capabilities.capabilities?.capabilities.includes("network") ?? false;
  const remembered = permissions.patterns.alwaysAllow.length + permissions.patterns.alwaysReject.length;
  return (
    <div className="config-permissions">
      <span className="config-field-label">Approvals</span>
      <label className="config-toggle" title="Prompt in-thread before each gated tool the policy would allow">
        <input
          type="checkbox"
          checked={permissions.mode === "ask"}
          onChange={(event) => void permissions.update({ mode: event.target.checked ? "ask" : "auto" })}
        />
        <span className="config-toggle-track" aria-hidden="true"><span className="config-toggle-thumb" /></span>
        <span className="config-toggle-text">
          Ask before tool runs
          <span className="config-toggle-desc">Hard policy denials never prompt</span>
        </span>
      </label>
      <span className="config-field-label">Agent capabilities</span>
      <label className="config-toggle" title="Shell command execution (run_commands)">
        <input
          type="checkbox"
          checked={processEnabled}
          disabled={!confinement}
          onChange={(event) => void capabilities.setCapability("process", event.target.checked)}
        />
        <span className="config-toggle-track" aria-hidden="true"><span className="config-toggle-thumb" /></span>
        <span className="config-toggle-text">
          Shell commands
          {!confinement && <span className="config-toggle-desc">requires workspace confinement</span>}
        </span>
      </label>
      <label className="config-toggle" title="Web search and fetch tools">
        <input
          type="checkbox"
          checked={networkEnabled}
          disabled={!confinement}
          onChange={(event) => void capabilities.setCapability("network", event.target.checked)}
        />
        <span className="config-toggle-track" aria-hidden="true"><span className="config-toggle-thumb" /></span>
        <span className="config-toggle-text">
          Web access
          {!confinement && <span className="config-toggle-desc">requires workspace confinement</span>}
        </span>
      </label>
      {remembered > 0 && (
        <button className="btn btn-ghost config-reset-patterns" onClick={() => void permissions.update({ reset: true })}>
          Forget {remembered} remembered decision{remembered === 1 ? "" : "s"}
        </button>
      )}
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

function UsageMeter() {
  const usage = useSessionUsage();
  if (usage === undefined || usage.usageEvents === 0) return null;
  return (
    <div className="usage-meter" title={`${usage.requests} metered model request(s)`}>
      <span className="usage-tokens" aria-label={`${usage.promptTokens} prompt tokens, ${usage.completionTokens} completion tokens`}>
        ↑{formatTokens(usage.promptTokens)} ↓{formatTokens(usage.completionTokens)} tokens
      </span>
      <span className="usage-cost" aria-label={`${usage.costUsd} US dollars`}>${usage.costUsd.toFixed(4)}</span>
    </div>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
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

/** Wraps text in a fence long enough that embedded ``` cannot break the block. */
function fencedBlock(text: string): string {
  const fence = text.includes("```") ? "````" : "```";
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

function Composer() {
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
      <div className="composer-row">
        <ComposerPrimitive.AddAttachment className="btn btn-ghost btn-attach" aria-label="Attach image" multiple>
          +
        </ComposerPrimitive.AddAttachment>
        <ComposerPrimitive.Input
          className="composer-input"
          placeholder={isRunning ? "Queue a follow-up — sends when the agent finishes" : "Describe the work to perform"}
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

/**
 * Safety-relevant fact, styled as one: advisory can never render equivalent
 * to enforced (PRODUCT.md invariant), so advisory is a persistent amber
 * outline badge and enforced a neutral filled one — in the header and again
 * beside the composer where prompts are sent.
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

/** Composer echo of the enforcement badge: visible where prompts are sent. */
function EnforcementEcho({ level }: { readonly level: string | undefined }) {
  if (level !== "advisory") return null;
  return <span className="enforcement-echo" title={ENFORCEMENT_COPY.advisory}>ADVISORY — actions not pre-authorized</span>;
}

export function App() {
  const { snapshot, refresh } = useSnapshot();
  const { sessions, refresh: refreshSessions } = useSessions();
  const { options, setOption } = useConfigOptions();
  const permissions = usePermissions();
  const capabilities = useCapabilities();
  const { isRunning } = useSessionState();
  const enforcementCopy = snapshot === undefined ? undefined : ENFORCEMENT_COPY[snapshot.enforcementLevel];

  // Keyboard shortcuts: "/" focuses the composer, Escape cancels a running
  // turn (when no popover/input has focus), Alt+N starts a new session.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const active = document.activeElement;
      const typing = active instanceof HTMLElement &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.querySelector<HTMLElement>(".composer-input")?.focus();
      } else if (
        event.key === "Escape" && isRunning && !typing &&
        // Any open chrome (settings popover, model combobox) owns this Escape;
        // cancelling a running turn must never ride along with closing it.
        document.querySelector(".config-popover, .config-combobox-pop") === null
      ) {
        void fetch("/api/cancel", { method: "POST" });
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "n" && !typing) {
        event.preventDefault();
        createSession(refreshSessions);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isRunning, refreshSessions]);

  return (
    <div className="shell">
      <header className="shell-header">
        <strong>Workflow Control</strong>
        <EnforcementBadge level={snapshot?.enforcementLevel} transport={snapshot?.transport} copy={enforcementCopy} />
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
              {permissions.pending !== null && (
                <PermissionPrompt
                  pending={permissions.pending}
                  answer={permissions.answer}
                  remembered={permissions.patterns.alwaysAllow.length + permissions.patterns.alwaysReject.length}
                />
              )}
              <RegenerateAction />
              <AuiIf condition={(state) => state.thread.isRunning}>
                <div className="working" role="status" aria-live="polite">
                  <span className="working-dot" aria-hidden="true" />
                  agent is working…
                </div>
              </AuiIf>
            </ThreadPrimitive.Viewport>
            <div className="composer-dock">
              <Composer />
              <QueueIndicator />
              <ConfigControls options={options} setOption={setOption} permissions={permissions} capabilities={capabilities} />
              <div className="composer-utilities">
                <EnforcementEcho level={snapshot?.enforcementLevel} />
                <ExportSessionButton />
                <UsageMeter />
              </div>
            </div>
          </ThreadPrimitive.Root>
        </section>
        <Panels snapshot={snapshot} sessions={sessions} refresh={refresh} refreshSessions={refreshSessions} />
      </main>
    </div>
  );
}
