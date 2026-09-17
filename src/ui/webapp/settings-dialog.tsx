import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";

import type { WebConfigOption } from "../web-config-options.js";
import { ConfigField } from "./config-field.js";
import { formatTokens } from "./presenters.js";
import { useSessionState, useSessionUsage } from "./runtime.js";
import type { ThemeChoice } from "./theme.js";

/** Structural slices of the app hooks the dialog needs; App passes its own. */
export interface SettingsPermissions {
  readonly available: boolean;
  readonly mode: "auto" | "ask";
  readonly update: (body: { mode?: "auto" | "ask"; reset?: boolean }) => Promise<void>;
  readonly patterns: { readonly alwaysAllow: readonly string[]; readonly alwaysReject: readonly string[] };
}

export interface SettingsCapabilities {
  readonly capabilities: { readonly capabilities: readonly string[]; readonly workspaceConfinement: boolean } | undefined;
  readonly setCapability: (capability: "process" | "network", enabled: boolean) => Promise<void>;
}

export interface SettingsDialogProps {
  readonly onClose: () => void;
  readonly themeChoice: ThemeChoice;
  readonly onThemeChoice: (choice: ThemeChoice) => void;
  readonly railsOff: boolean;
  readonly onRailsToggle: (off: boolean) => void;
  readonly options: readonly WebConfigOption[];
  readonly setOption: (id: string, value: string | boolean) => void;
  readonly permissions: SettingsPermissions;
  readonly capabilities: SettingsCapabilities;
  readonly enforcement: { readonly level: string | undefined; readonly transport: string | undefined; readonly copy: string | undefined };
}

/**
 * Every operator-facing preference in one place: appearance and UI layout,
 * all agent-advertised options (model, effort, mode, tool toggles),
 * approvals and capabilities, transcript/notifications, the keyboard map,
 * and the session's authority facts. One surface, one source of truth per
 * setting — each control writes the same state its composer-adjacent twin
 * uses, so the two never diverge.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Open: focus the first control; close: focus returns to the opener.
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("button, select, input")?.focus();
    return () => {
      openerRef.current?.focus();
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      // This Escape closes the dialog only; the global handler's open-chrome
      // DOM guard is the primary defense against cancelling a running turn.
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
    if (focusables === undefined || focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="settings-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="settings-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="btn btn-ghost settings-close" aria-label="Close settings" onClick={props.onClose}>
            ×
          </button>
        </header>
        <div className="settings-body">
          <AppearanceSection {...props} />
          <AgentOptionsSection options={props.options} setOption={props.setOption} />
          {props.permissions.available && (
            <ApprovalsSection permissions={props.permissions} capabilities={props.capabilities} />
          )}
          <TranscriptSection />
          <NotificationsSection />
          <ShortcutsSection />
          <SessionSection enforcement={props.enforcement} />
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, description, control, title }: {
  readonly label: string;
  readonly description?: string | undefined;
  readonly title?: string | undefined;
  readonly control: ReactNode;
}) {
  return (
    <div className="settings-row" title={title}>
      <span className="settings-row-label">
        {label}
        {description !== undefined && <span className="settings-desc">{description}</span>}
      </span>
      {control}
    </div>
  );
}

/** One toggle row: hidden checkbox + the shared track/thumb presentation. */
function Toggle({ checked, disabled, onChange, ariaLabel, inputRef }: {
  readonly checked: boolean;
  readonly disabled?: boolean | undefined;
  readonly onChange: (checked: boolean) => void;
  readonly ariaLabel: string;
  readonly inputRef?: Ref<HTMLInputElement> | undefined;
}) {
  return (
    <label className="config-toggle settings-toggle" title={ariaLabel}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        ref={inputRef}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="config-toggle-track" aria-hidden="true"><span className="config-toggle-thumb" /></span>
    </label>
  );
}

function AppearanceSection({ themeChoice, onThemeChoice, railsOff, onRailsToggle }: {
  readonly themeChoice: ThemeChoice;
  readonly onThemeChoice: (choice: ThemeChoice) => void;
  readonly railsOff: boolean;
  readonly onRailsToggle: (off: boolean) => void;
}) {
  return (
    <Section title="Appearance">
      <Row
        label="Color theme"
        description="System follows your OS setting"
        control={
          <div className="theme-choice" role="radiogroup" aria-label="Color theme">
            {(["system", "dark", "light"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={themeChoice === option}
                className={`theme-option ${themeChoice === option ? "theme-option-on" : ""}`}
                onClick={() => onThemeChoice(option)}
              >
                {option === "system" ? "System" : option === "dark" ? "Dark" : "Light"}
              </button>
            ))}
          </div>
        }
      />
      <Row
        label="Focus mode"
        description="Hide the git rail and inspector; the thread centers"
        title="Toggle with the header button too"
        control={
          <Toggle
            checked={railsOff}
            onChange={(off) => onRailsToggle(off)}
            ariaLabel="Focus mode — hide the git rail and inspector panels"
          />
        }
      />
    </Section>
  );
}

function AgentOptionsSection({ options, setOption }: {
  readonly options: readonly WebConfigOption[];
  readonly setOption: (id: string, value: string | boolean) => void;
}) {
  if (options.length === 0) {
    return (
      <Section title="Agent options">
        <p className="settings-desc">The agent advertises no session options yet. Model, effort, and mode pickers appear here when it does.</p>
      </Section>
    );
  }
  return (
    <Section title="Agent options">
      {options.map((option) => {
        if (option.type === "boolean") {
          return (
            <Row
              key={option.id}
              label={option.name}
              description={option.description}
              control={
                <Toggle
                  checked={option.currentValue === true}
                  onChange={(enabled) => setOption(option.id, enabled)}
                  ariaLabel={option.name}
                />
              }
            />
          );
        }
        return (
          <Row
            key={option.id}
            label={option.name}
            description={option.description}
            control={
              <span className="settings-field">
                <ConfigField option={option} setOption={setOption} />
              </span>
            }
          />
        );
      })}
    </Section>
  );
}

function ApprovalsSection({ permissions, capabilities }: {
  readonly permissions: SettingsPermissions;
  readonly capabilities: SettingsCapabilities;
}) {
  const confinement = capabilities.capabilities?.workspaceConfinement ?? false;
  const processEnabled = capabilities.capabilities?.capabilities.includes("process") ?? false;
  const networkEnabled = capabilities.capabilities?.capabilities.includes("network") ?? false;
  const remembered = permissions.patterns.alwaysAllow.length + permissions.patterns.alwaysReject.length;
  // The Forget button unmounts itself when the count drops to zero; focus
  // then returns to the section's first control so the modal never strands
  // focus on the body (where the Tab trap would stop engaging).
  const askToggleRef = useRef<HTMLInputElement>(null);
  const forget = (): void => {
    void permissions.update({ reset: true }).then(() => askToggleRef.current?.focus());
  };
  return (
    <Section title="Approvals">
      <Row
        label="Ask before tool runs"
        description="Prompt in-thread before each gated tool the policy would allow; hard denials never prompt"
        control={
          <Toggle
            checked={permissions.mode === "ask"}
            onChange={(ask) => void permissions.update({ mode: ask ? "ask" : "auto" })}
            ariaLabel="Ask before tool runs"
            inputRef={askToggleRef}
          />
        }
      />
      <Row
        label="Shell commands"
        description={confinement ? "run_commands execution" : "requires workspace confinement"}
        control={
          <Toggle
            checked={processEnabled}
            disabled={!confinement}
            onChange={(enabled) => void capabilities.setCapability("process", enabled)}
            ariaLabel="Shell commands"
          />
        }
      />
      <Row
        label="Web access"
        description={confinement ? "Web search and fetch tools" : "requires workspace confinement"}
        control={
          <Toggle
            checked={networkEnabled}
            disabled={!confinement}
            onChange={(enabled) => void capabilities.setCapability("network", enabled)}
            ariaLabel="Web access"
          />
        }
      />
      {remembered > 0 && (
        <button
          type="button"
          className="btn btn-ghost settings-reset"
          onClick={forget}
        >
          Forget {remembered} remembered decision{remembered === 1 ? "" : "s"}
        </button>
      )}
    </Section>
  );
}

function TranscriptSection() {
  const { showThinking, setShowThinking } = useSessionState();
  return (
    <Section title="Transcript">
      <Row
        label="Show thinking blocks"
        description="The agent still reasons; only the display changes"
        control={
          <Toggle
            checked={showThinking}
            onChange={(value) => setShowThinking(value)}
            ariaLabel="Show thinking blocks"
          />
        }
      />
    </Section>
  );
}

const NOTIFY_KEY = "workflow.notify-completion";

function useNotifyOnCompletion(): readonly [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState((): boolean => {
    try {
      return window.localStorage.getItem(NOTIFY_KEY) === "true";
    } catch {
      return false;
    }
  });
  const update = useCallback((value: boolean): void => {
    try {
      window.localStorage.setItem(NOTIFY_KEY, String(value));
    } catch {
      // Storage unavailable: the preference applies for this session only.
    }
    if (value && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    setEnabled(value);
  }, []);
  return [enabled, update];
}

function NotificationsSection() {
  const [notify, setNotify] = useNotifyOnCompletion();
  return (
    <Section title="Notifications">
      <Row
        label="Notify on completion"
        description="Desktop notification and chime when a turn finishes while the tab is hidden"
        control={
          <Toggle
            checked={notify}
            onChange={setNotify}
            ariaLabel="Notify on completion"
          />
        }
      />
    </Section>
  );
}

const SHORTCUTS: readonly { readonly keys: readonly string[]; readonly description: string }[] = [
  { keys: ["/"], description: "Focus the prompt" },
  { keys: ["Enter"], description: "Send the prompt" },
  { keys: ["Shift", "Enter"], description: "New line in the prompt" },
  { keys: ["Esc"], description: "Cancel a running turn, close menus and dialogs" },
  { keys: ["Alt", "N"], description: "New session" },
  { keys: ["Ctrl", ","], description: "Open these settings" },
];

function ShortcutsSection() {
  return (
    <Section title="Keyboard shortcuts">
      {SHORTCUTS.map((shortcut) => (
        <div className="settings-kbd-row" key={shortcut.description}>
          <span className="settings-kbd">
            {shortcut.keys.map((key, index) => (
              <kbd key={key}>{index === 0 ? key : `+${key}`}</kbd>
            ))}
          </span>
          <span className="settings-kbd-desc">{shortcut.description}</span>
        </div>
      ))}
    </Section>
  );
}

function SessionSection({ enforcement }: {
  readonly enforcement: { readonly level: string | undefined; readonly transport: string | undefined; readonly copy: string | undefined };
}) {
  const usage = useSessionUsage();
  return (
    <Section title="Session and authority">
      <div className="settings-meta">
        {enforcement.level === undefined ? (
          <span className="shell-host">connecting</span>
        ) : (
          <span
            className={`enforcement-badge enforcement-${enforcement.level}`}
            title={enforcement.copy}
            aria-label={enforcement.copy ?? "enforcement level unavailable"}
          >
            {enforcement.level.toUpperCase()}
            {enforcement.transport !== undefined && <span className="enforcement-transport"> / {enforcement.transport}</span>}
          </span>
        )}
        {usage !== undefined && (
          <span title={`${usage.requests} metered model request(s)`}>
            ↑{formatTokens(usage.promptTokens)} ↓{formatTokens(usage.completionTokens)} tokens · ${usage.costUsd.toFixed(4)}
            {usage.latestPromptTokens !== undefined && <> · context {formatTokens(usage.latestPromptTokens)}</>}
          </span>
        )}
      </div>
      <p className="settings-desc">Every action the agent takes is proposed and authorized through Workflow before it runs.</p>
      <p className="settings-desc settings-docs">
        docs/OPERATOR_GUIDE.md · docs/CHAT_UI_RESEARCH_2026.md · docs/web-ui-feature-tiers.md
      </p>
    </Section>
  );
}
