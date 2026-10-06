import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";

import type { AgentRuntimePreference, McpServerSetting, McpTransport } from "../../integrations/workflow-settings.js";
import type { LiveMcpState } from "../../integrations/opencode-live-state.js";
import type { WebConfigOption } from "../web-config-options.js";
import { ConfigField } from "./config-field.js";
import { describeGrantLifecycle, formatTokens, type GrantRecord } from "./presenters.js";
import { useSessionState, useSessionUsage } from "./runtime.js";
import type { PaletteSummary } from "./theme/palettes.js";

/** Structural slices of the app hooks the dialog needs; App passes its own. */
export interface SettingsPermissions {
  readonly available: boolean;
  readonly mode: "auto" | "ask";
  readonly update: (body: { mode?: "auto" | "ask"; reset?: boolean }) => Promise<void>;
  readonly patterns: { readonly alwaysAllow: readonly string[]; readonly alwaysReject: readonly string[]; readonly grants?: readonly GrantRecord[] | undefined };
}

export interface SettingsCapabilities {
  readonly capabilities: { readonly capabilities: readonly string[]; readonly workspaceConfinement: boolean } | undefined;
  readonly setCapability: (capability: "process" | "network", enabled: boolean) => Promise<void>;
}

export interface SettingsAgentInfo {
  readonly id: string;
  readonly name: string;
  readonly containment: "contained" | "advisory";
  readonly available: boolean;
  readonly reason?: string;
}

/**
 * The Workflow-owned MCP catalog controller. Servers live in the canonical
 * settings document (global base + workspace overlay) and are projected into
 * each agent's launch config when a session starts — never hot-applied, since
 * ACP fixes `mcpServers` at session creation.
 */
export interface SettingsMcpCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly transport: "stdio";
  readonly serverPath: string;
  readonly available: boolean;
}

export interface SettingsMcp {
  readonly servers: readonly McpServerSetting[];
  readonly catalog: readonly SettingsMcpCatalogEntry[];
  readonly scope: "global" | "workspace";
  readonly workspaceOverlay: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
  /** Live server-side MCP state through the enforced gateway (dual data lane);
   * `undefined` until the read resolves — never a fabricated connection. */
  readonly live?: LiveMcpState;
  readonly setScope: (scope: "global" | "workspace") => void;
  readonly upsert: (server: McpServerSetting) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
  readonly toggle: (name: string, enabled: boolean) => Promise<void>;
}

/** Environment-dictated routing facts, surfaced read-only in the routing section. */
export interface RoutingFacts {
  readonly upstream: string;
  readonly envModelOpencode: boolean;
  readonly envModelGoose: boolean;
  readonly managementKey: boolean;
}

export interface SettingsRouting {
  readonly agents: Readonly<Record<string, AgentRuntimePreference>>;
  readonly facts: RoutingFacts;
  readonly loading: boolean;
  readonly error: string | undefined;
  /** Persists one agent's launch defaults (same doc the runtime consumes).
   * Resolves `true` only when the save succeeded. */
  readonly onSave: (agent: string, preference: AgentRuntimePreference) => Promise<boolean>;
}

// The schedule surface lives on main's Schedules page (hub proxy, live
// registry with pause/resume/delete/run-now) — the settings section from this
// branch was superseded and removed in the merge.

export interface SettingsDialogProps {
  readonly onClose: () => void;
  readonly palette: string | undefined;
  readonly onPalette: (palette: string | undefined) => void;
  readonly palettes: readonly PaletteSummary[];
  readonly railsOff: boolean;
  readonly onRailsToggle: (off: boolean) => void;
  readonly options: readonly WebConfigOption[];
  readonly setOption: (id: string, value: string | boolean) => void;
  readonly routing: SettingsRouting;
  readonly permissions: SettingsPermissions;
  readonly capabilities: SettingsCapabilities;
  readonly mcp: SettingsMcp;
  readonly enforcement: { readonly level: string | undefined; readonly transport: string | undefined; readonly copy: string | undefined };
  readonly agents: readonly SettingsAgentInfo[];
  readonly currentAgent: string;
  readonly onSwitchAgent: (agent: string) => void;
}

const NAV: readonly { readonly id: string; readonly label: string }[] = [
  { id: "settings-appearance", label: "Appearance" },
  { id: "settings-agent", label: "Agent" },
  { id: "settings-options", label: "Agent options" },
  { id: "settings-routing", label: "Model routing" },
  { id: "settings-mcp", label: "MCP servers" },
  { id: "settings-approvals", label: "Approvals" },
  { id: "settings-transcript", label: "Transcript" },
  { id: "settings-notifications", label: "Notifications" },
  { id: "settings-shortcuts", label: "Shortcuts" },
  { id: "settings-session", label: "Session" },
];

/**
 * The fullscreen operator settings page: dedicated sections behind the left
 * rail — appearance and UI layout, all agent-advertised options (model,
 * effort, mode, tool toggles), the Workflow-owned MCP catalog, approvals and
 * capabilities, transcript and notifications, the keyboard map, and the
 * session's authority facts. One surface, one source of truth per setting —
 * each control writes the same state its composer-adjacent twin uses, so the
 * two never diverge. The nav SWITCHES the visible section (2026-09-21,
 * operator request) instead of anchor-scrolling one long page; Appearance
 * leads so the palette catalog is immediately reachable.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Dedicated sections: the nav switches the visible section instead of
  // anchor-scrolling one long page. Appearance leads (the e2e opens settings
  // and reaches the palette chips immediately).
  const [section, setSection] = useState<string>(NAV[0]!.id);

  // Open: focus the first control; close: focus returns to the opener.
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pageRef.current?.querySelector<HTMLElement>("button, select, input")?.focus();
    return () => {
      openerRef.current?.focus();
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      // This Escape closes the page only; the global handler's open-chrome
      // DOM guard is the primary defense against cancelling a running turn.
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = pageRef.current?.querySelectorAll<HTMLElement>(
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

  const selectSection = (id: string): void => {
    setSection(id);
    // A fresh section starts at its top, never at the previous section's
    // scroll position.
    if (contentRef.current !== null) contentRef.current.scrollTop = 0;
  };

  const sections: ReadonlyMap<string, ReactNode> = new Map<string, ReactNode>([
    ["settings-appearance", <AppearanceSection {...props} />],
    ["settings-agent", <AgentSection agents={props.agents} currentAgent={props.currentAgent} onSwitchAgent={props.onSwitchAgent} />],
    ["settings-options", <AgentOptionsSection options={props.options} setOption={props.setOption} patterns={props.permissions.patterns} />],
    ["settings-routing", <RoutingSection routing={props.routing} />],
    ["settings-mcp", <McpSection mcp={props.mcp} />],
    ...(props.permissions.available
      ? [["settings-approvals", <ApprovalsSection permissions={props.permissions} capabilities={props.capabilities} />] as const]
      : []),
    ["settings-transcript", <TranscriptSection />],
    ["settings-notifications", <NotificationsSection />],
    ["settings-shortcuts", <ShortcutsSection />],
    ["settings-session", <SessionSection enforcement={props.enforcement} />],
  ]);
  const navItems = NAV.filter((entry) => sections.has(entry.id));
  const active = sections.has(section) ? section : navItems[0]!.id;

  return (
    <div
      className="settings-dialog settings-page"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      ref={pageRef}
      onKeyDown={onKeyDown}
    >
      <header className="settings-head settings-page-head">
        <button type="button" className="btn btn-ghost settings-back" onClick={props.onClose}>
          ← Back to session
        </button>
        <div className="settings-page-title">
          <h2 id="settings-title">Settings</h2>
          <span className="settings-desc">The control plane's own settings, and what it pushes to each coding agent</span>
        </div>
        <button type="button" className="btn btn-ghost settings-close" aria-label="Close settings" onClick={props.onClose}>
          ×
        </button>
      </header>
      <div className="settings-page-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {navItems.map((entry) => (
            <button
              type="button"
              className={`settings-nav-item ${section === entry.id ? "settings-nav-item-on" : ""}`}
              key={entry.id}
              aria-current={section === entry.id ? "true" : undefined}
              onClick={() => selectSection(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="settings-content" ref={contentRef}>
          <div id={active}>{sections.get(active)}</div>
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

function Row({ label, description, control, title, stacked }: {
  readonly label: string;
  readonly description?: string | undefined;
  readonly title?: string | undefined;
  readonly stacked?: boolean | undefined;
  readonly control: ReactNode;
}) {
  return (
    <div className={`settings-row ${stacked === true ? "settings-row-stacked" : ""}`} title={title}>
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

export function AppearanceSection({ palette, onPalette, palettes, railsOff, onRailsToggle }: {
  readonly palette: string | undefined;
  readonly onPalette: (palette: string | undefined) => void;
  readonly palettes: readonly PaletteSummary[];
  readonly railsOff: boolean;
  readonly onRailsToggle: (off: boolean) => void;
}) {
  return (
    <Section title="Appearance">
      <Row
        stacked
        label="Palette"
        description="Catalog themes over the Workflow amber identity — the default when none is chosen"
        control={
          <div className="palette-choice" role="listbox" aria-label="Color palette">
            <button
              type="button"
              role="option"
              aria-selected={palette === undefined}
              className={`palette-chip ${palette === undefined ? "palette-chip-on" : ""}`}
              onClick={() => onPalette(undefined)}
            >
              <span className="palette-swatch" aria-hidden="true">
                <span style={{ background: "#14161a" }} />
                <span style={{ background: "#e8a33d" }} />
                <span style={{ background: "#e6e8eb" }} />
              </span>
              Workflow amber
            </button>
            {palettes.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={palette === entry.id}
                className={`palette-chip ${palette === entry.id ? "palette-chip-on" : ""}`}
                onClick={() => onPalette(entry.id)}
              >
                <span className="palette-swatch" aria-hidden="true">
                  <span style={{ background: entry.swatch.bg }} />
                  <span style={{ background: entry.swatch.accent }} />
                  <span style={{ background: entry.swatch.text }} />
                </span>
                {entry.name}
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

/** Which agent the session runs on. The containment posture is stated
 * honestly per agent — a contained launch and advisory transport never read
 * as equivalent. Exported for the UI-surface regression pin. */
export function AgentSection({ agents, currentAgent, onSwitchAgent }: {
  readonly agents: readonly SettingsAgentInfo[];
  readonly currentAgent: string;
  readonly onSwitchAgent: (agent: string) => void;
}) {
  if (agents.length === 0) return null;
  return (
    <Section title="Agent">
      <div className="agent-list" role="radiogroup" aria-label="Agent">
        {agents.map((agent) => {
          const current = agent.id === currentAgent;
          return (
            <label
              className={`agent-row ${current ? "agent-row-current" : ""} ${agent.available ? "" : "agent-row-unavailable"}`}
              key={agent.id}
            >
              <input
                type="radio"
                name="agent"
                checked={current}
                disabled={!agent.available}
                aria-label={`${agent.name} (${agent.containment === "contained" ? "contained launch" : "advisory transport"})`}
                onChange={() => onSwitchAgent(agent.id)}
              />
              <span className="agent-row-text">
                <span className="agent-row-name">{agent.name}</span>
                <span className="settings-desc">
                  {agent.containment === "contained"
                    ? "contained launch — enforced boundary"
                    : "advisory transport — no pre-mutation interception"}
                  {!agent.available && agent.reason !== undefined && ` — ${agent.reason}`}
                </span>
              </span>
              {current && <span className="agent-row-badge">current</span>}
            </label>
          );
        })}
      </div>
    </Section>
  );
}

/** Every advertised agent option, in full — the canonical complete set
 * (operator preference #2). Select options (model, effort, mode, provider)
 * render as fields; boolean options are grouped as tool toggles with the
 * remembered per-tool decisions the resolver already holds. Exported for the
 * UI-surface regression pin. */
export function AgentOptionsSection({ options, setOption, patterns }: {
  readonly options: readonly WebConfigOption[];
  readonly setOption: (id: string, value: string | boolean) => void;
  readonly patterns?: { readonly alwaysAllow: readonly string[]; readonly alwaysReject: readonly string[]; readonly grants?: readonly GrantRecord[] | undefined } | undefined;
}) {
  if (options.length === 0) {
    return (
      <Section title="Agent options">
        <p className="settings-desc">The agent advertises no session options yet. Model, effort, and mode pickers appear here when it does.</p>
      </Section>
    );
  }
  const selects = options.filter((option) => option.type !== "boolean");
  const toggles = options.filter((option) => option.type === "boolean");
  const grants = patterns?.grants ?? [];
  return (
    <Section title="Agent options">
      {selects.map((option) => (
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
      ))}
      {toggles.length > 0 && (
        <div className="settings-subgroup">
          <h4>Tools</h4>
          <p className="settings-desc">Agent-advertised tool toggles. Hard denials stay enforced server-side regardless of this setting.</p>
          {toggles.map((option) => (
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
          ))}
        </div>
      )}
      {patterns !== undefined && (patterns.alwaysAllow.length > 0 || patterns.alwaysReject.length > 0 || grants.length > 0) && (
        <div className="settings-subgroup">
          <h4>Remembered tool decisions</h4>
          {patterns.alwaysAllow.length > 0 && (
            <p className="settings-desc">Always allowed: <span className="settings-pattern-list">{patterns.alwaysAllow.join(", ")}</span></p>
          )}
          {patterns.alwaysReject.length > 0 && (
            <p className="settings-desc">Always rejected: <span className="settings-pattern-list">{patterns.alwaysReject.join(", ")}</span></p>
          )}
          {grants.length > 0 && (
            <p className="settings-desc">
              Grant lifecycle:{" "}
              <span className="settings-pattern-list">
                {grants.map((grant, index) => (
                  <span key={`${grant.tool}-${index}`}>{index > 0 ? " · " : ""}{describeGrantLifecycle(grant)}</span>
                ))}
              </span>
            </p>
          )}
          <p className="settings-desc">Clear these from Approvals below.</p>
        </div>
      )}
    </Section>
  );
}

interface McpDraft {
  readonly originalName: string | undefined;
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string;
  readonly argsText: string;
  readonly envText: string;
  readonly url: string;
  readonly enabled: boolean;
}

function emptyDraft(): McpDraft {
  return { originalName: undefined, name: "", transport: "stdio", command: "", argsText: "", envText: "", url: "", enabled: true };
}

function draftFor(server: McpServerSetting): McpDraft {
  return {
    originalName: server.name,
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    argsText: (server.args ?? []).join("\n"),
    envText: Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"),
    url: server.url ?? "",
    enabled: server.enabled,
  };
}

function parseArgs(text: string): string[] {
  return text.split(/[\n,]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function parseEnv(text: string): Record<string, string> | undefined {
  const entries = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).flatMap((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) return [];
    return [[line.slice(0, separator).trim(), line.slice(separator + 1)] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function draftToServer(draft: McpDraft): McpServerSetting | string {
  const name = draft.name.trim();
  if (name.length === 0) return "a server name is required";
  if (draft.transport === "stdio") {
    const command = draft.command.trim();
    if (command.length === 0) return "a command is required for stdio servers";
    const args = parseArgs(draft.argsText);
    const env = parseEnv(draft.envText);
    return {
      name,
      enabled: draft.enabled,
      transport: "stdio",
      command,
      ...(args.length === 0 ? {} : { args }),
      ...(env === undefined ? {} : { env }),
    };
  }
  const url = draft.url.trim();
  if (url.length === 0) return "a URL is required for HTTP servers";
  return { name, enabled: draft.enabled, transport: "http", url };
}

export function McpSection({ mcp }: { readonly mcp: SettingsMcp }) {
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const editing = draft !== null;

  const save = (): void => {
    if (draft === null) return;
    const server = draftToServer(draft);
    if (typeof server === "string") {
      setFormError(server);
      return;
    }
    setFormError(undefined);
    void mcp.upsert(server).then(() => setDraft(null));
  };

  return (
    <Section title="MCP servers">
      <p className="settings-desc">
        The Workflow-owned catalog. Servers are projected into each agent's launch config — they apply when a
        session starts, not to the running one. Enabled servers only; the global list is the base and the
        workspace list overrides on name conflicts.
      </p>
      <div className="settings-scope" role="radiogroup" aria-label="MCP settings scope">
        {(["global", "workspace"] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            role="radio"
            aria-checked={mcp.scope === scope}
            disabled={scope === "workspace" && !mcp.workspaceOverlay}
            className={`theme-option ${mcp.scope === scope ? "theme-option-on" : ""}`}
            onClick={() => mcp.setScope(scope)}
            title={scope === "workspace" && !mcp.workspaceOverlay ? "No workspace root for this service" : undefined}
          >
            {scope === "global" ? "Global" : "Workspace"}
          </button>
        ))}
      </div>
      {mcp.loading && <p className="settings-desc">Loading MCP servers…</p>}
      {mcp.error !== undefined && <p className="settings-error" role="alert">{mcp.error}</p>}
      {mcp.servers.length === 0 && !mcp.loading && (
        <p className="settings-desc">No MCP servers configured. Add one below to expose its tools to the agent.</p>
      )}
      {mcp.live !== undefined && (
        <div className="settings-subgroup">
          <h4>Live state</h4>
          {mcp.live.live ? (
            <>
              <p className="settings-desc">
                Server-side MCP state read through the enforced gateway ({mcp.live.gatewayUrl}) — the live
                view ACP does not expose. States are the server's own.
              </p>
              {mcp.live.servers.length === 0 && <p className="settings-desc">No MCP servers are mounted on the running topology.</p>}
              {mcp.live.servers.map((server) => (
                <Row key={server.name} label={server.name} description={`live status: ${server.status}`} control={<span className="settings-desc">{server.status}</span>} />
              ))}
            </>
          ) : (
            <p className="settings-desc">No live MCP state — {mcp.live.reason}. Configured servers apply at the next session.</p>
          )}
        </div>
      )}
      {mcp.servers.map((server) => (
        <Row
          key={server.name}
          label={server.name}
          description={
            server.transport === "stdio"
              ? `stdio · ${server.command ?? ""} ${(server.args ?? []).join(" ")}`.trim()
              : `http · ${server.url ?? ""}`
          }
          control={
            <span className="mcp-row-controls">
              <Toggle
                checked={server.enabled}
                onChange={(enabled) => void mcp.toggle(server.name, enabled)}
                ariaLabel={`Enable ${server.name}`}
              />
              <button type="button" className="btn btn-ghost settings-reset" onClick={() => { setFormError(undefined); setDraft(draftFor(server)); }}>
                Edit
              </button>
              <button type="button" className="btn btn-ghost settings-reset" onClick={() => void mcp.remove(server.name)}>
                Remove
              </button>
            </span>
          }
        />
      ))}
      <ConnectorsSection mcp={mcp} />
      {!editing && (
        <button type="button" className="btn btn-ghost settings-reset" onClick={() => { setFormError(undefined); setDraft(emptyDraft()); }}>
          Add MCP server
        </button>
      )}
      {draft !== null && (
        <form
          className="mcp-editor"
          onSubmit={(event) => { event.preventDefault(); save(); }}
        >
          <div className="settings-subgroup">
            <h4>{draft.originalName === undefined ? "New MCP server" : `Edit ${draft.originalName}`}</h4>
            <label className="mcp-field">
              <span>Name</span>
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoFocus />
            </label>
            <label className="mcp-field">
              <span>Transport</span>
              <select value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value === "http" ? "http" : "stdio" })}>
                <option value="stdio">stdio (local command)</option>
                <option value="http">http (remote URL)</option>
              </select>
            </label>
            {draft.transport === "stdio" ? (
              <>
                <label className="mcp-field">
                  <span>Command</span>
                  <input value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="node" />
                </label>
                <label className="mcp-field">
                  <span>Arguments (one per line)</span>
                  <textarea value={draft.argsText} onChange={(event) => setDraft({ ...draft, argsText: event.target.value })} rows={3} />
                </label>
                <label className="mcp-field">
                  <span>Environment (KEY=value per line)</span>
                  <textarea value={draft.envText} onChange={(event) => setDraft({ ...draft, envText: event.target.value })} rows={3} />
                </label>
              </>
            ) : (
              <label className="mcp-field">
                <span>URL</span>
                <input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://mcp.example/mcp" />
              </label>
            )}
            <label className="mcp-field mcp-field-inline">
              <span>Enabled</span>
              <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
            </label>
            {formError !== undefined && <p className="settings-error" role="alert">{formError}</p>}
            <span className="mcp-editor-actions">
              <button type="submit" className="btn">{draft.originalName === undefined ? "Add" : "Save"}</button>
              <button type="button" className="btn btn-ghost" onClick={() => { setFormError(undefined); setDraft(null); }}>Cancel</button>
            </span>
          </div>
        </form>
      )}
    </Section>
  );
}

/**
 * The vendored connector catalog (settings MVP): every mcp-toolbox app, with
 * truthful build availability, enabled with one toggle. A connector already
 * present in the configured list shows as added rather than duplicating it —
 * the configured row above remains the single control for it.
 */
function ConnectorsSection({ mcp }: { readonly mcp: SettingsMcp }) {
  const configured = new Set(mcp.servers.map((server) => server.name));
  if (mcp.catalog.length === 0) return null;
  return (
    <div className="settings-subgroup">
      <h4>Available connectors</h4>
      <p className="settings-desc">
        Vendored Workflow MCP servers. Adding one writes the same launch config the
        servers above write — it takes effect on the next session.
      </p>
      {mcp.catalog.map((entry) => {
        const added = configured.has(entry.name);
        return (
          <Row
            key={entry.name}
            label={entry.name}
            description={entry.available ? entry.description : `${entry.description} · not built (npm run toolbox:build)`}
            control={
              <button
                type="button"
                className={`btn btn-ghost settings-reset ${added ? "" : "mcp-catalog-add"}`}
                disabled={added || !entry.available}
                onClick={() => {
                  if (added || !entry.available) return;
                  void mcp.upsert({
                    name: entry.name,
                    enabled: true,
                    transport: entry.transport,
                    command: "node",
                    args: [entry.serverPath],
                  });
                }}
                title={added ? "Already configured — control it in the list above" : undefined}
              >
                {added ? "Added" : (entry.available ? "Add" : "Unbuilt")}
              </button>
            }
          />
        );
      })}
    </div>
  );
}

/**
 * Model routing: the persisted per-agent launch defaults (model + reasoning
 * effort) written to the settings document, plus the routing facts the
 * environment currently dictates, stated read-only and honestly — an env-set
 * model override wins over the panel default, so it is shown, not hidden.
 * Launch consumption is claimed per agent, never wholesale: only `model`
 * reaches a launch config today (OpenCode's metered config, goose's launch);
 * `thoughtLevel` and the whole cline preference are persisted with no launch
 * consumer yet.
 */
const ROUTING_AGENTS: readonly { readonly id: string; readonly label: string; readonly hint: string }[] = [
  { id: "opencode", label: "OpenCode", hint: "model is consumed at launch into the metered opencode config" },
  { id: "goose", label: "Goose", hint: "model is consumed at launch by the contained goose agent" },
  { id: "cline", label: "Cline", hint: "persisted launch default; no launch-time consumer yet" },
];

const THOUGHT_LEVELS: readonly string[] = ["none", "low", "medium", "high", "xhigh"];

export function RoutingSection({ routing }: { readonly routing: SettingsRouting }) {
  return (
    <Section title="Model routing">
      <p className="settings-desc">
        Per-agent launch defaults. The model default is written into the launch
        config for OpenCode and goose on the next session; reasoning effort is
        persisted now — no engine consumes it at launch yet. Live changes still
        ride the agent's own config options.
      </p>
      {routing.loading && <p className="settings-desc">Loading routing defaults…</p>}
      {routing.error !== undefined && <p className="settings-error" role="alert">{routing.error}</p>}
      {ROUTING_AGENTS.map((agent) => {
        const preference = routing.agents[agent.id] ?? {};
        return (
          <div className="settings-subgroup" key={agent.id}>
            <h4>{agent.label}</h4>
            <p className="settings-desc">{agent.hint}</p>
            <RoutingAgentForm agent={agent.id} preference={preference} onSave={routing.onSave} />
          </div>
        );
      })}
      <div className="settings-subgroup">
        <h4>Environment facts</h4>
        <Row
          label="Model traffic upstream"
          description={routing.facts.upstream}
          control={<span className="settings-desc">set via WORKFLOW_ACP_UPSTREAM</span>}
        />
        <Row
          label="Env model overrides"
          description={
            routing.facts.envModelOpencode || routing.facts.envModelGoose
              ? "present — an env-set model wins over the panel default for that agent"
              : "none — the panel defaults apply to every agent"
          }
          control={<span className="settings-desc">{[routing.facts.envModelOpencode ? "opencode" : "", routing.facts.envModelGoose ? "goose" : ""].filter(Boolean).join(", ") || "—"}</span>}
        />
        <Row
          label="Usage management key"
          description="WORKFLOW_OPENROUTER_MANAGEMENT_KEY"
          control={<span className="settings-desc">{routing.facts.managementKey ? "present" : "absent"}</span>}
        />
      </div>
    </Section>
  );
}

function RoutingAgentForm({ agent, preference, onSave }: {
  readonly agent: string;
  readonly preference: AgentRuntimePreference;
  readonly onSave: (agent: string, preference: AgentRuntimePreference) => Promise<boolean>;
}) {
  const [model, setModel] = useState(preference.model ?? "");
  const [thoughtLevel, setThoughtLevel] = useState(preference.thoughtLevel ?? "");
  // W082: the config-side auto-compaction trigger — opencode only, the only
  // agent whose launch config composes it today.
  const [autoCompact, setAutoCompact] = useState(preference.autoCompact === true);
  const [saved, setSaved] = useState(false);
  // Re-sync from the refreshed document after every load/save so the form
  // reflects what actually persisted, never a stale local draft.
  useEffect(() => {
    setModel(preference.model ?? "");
    setThoughtLevel(preference.thoughtLevel ?? "");
    setAutoCompact(preference.autoCompact === true);
    setSaved(false);
  }, [preference.model, preference.thoughtLevel, preference.autoCompact]);
  const dirty = (preference.model ?? "") !== model.trim() || (preference.thoughtLevel ?? "") !== thoughtLevel || (preference.autoCompact === true) !== autoCompact;
  // The merge persists per key and cannot clear string keys: an all-empty save
  // would be rejected, so it is disabled here and the limitation is stated,
  // not hidden. autoCompact is an exception by construction — an explicit
  // boolean persists, so unchecking sticks.
  const persistedAnything = preference.model !== undefined || preference.mode !== undefined || preference.thoughtLevel !== undefined || preference.autoCompact !== undefined;
  // Strings cannot clear (per-key merge), but autoCompact can: an unchanged
  // boolean with empty string fields and something persisted means the save
  // would change nothing — the honest disable. A CHANGED boolean always
  // persists something real.
  const clearsEverything = persistedAnything && model.trim() === "" && thoughtLevel === "" && (preference.autoCompact === true) === autoCompact;
  const canPersist = dirty && !clearsEverything;
  return (
    <div className="mcp-editor" role="group" aria-label={`${agent} launch defaults`}>
      <label className="mcp-field">
        <span>Model</span>
        <input
          value={model}
          placeholder="engine default"
          onChange={(event) => { setModel(event.target.value); setSaved(false); }}
        />
      </label>
      <label className="mcp-field">
        <span>Reasoning effort</span>
        <select value={thoughtLevel} onChange={(event) => { setThoughtLevel(event.target.value); setSaved(false); }}>
          <option value="">engine default</option>
          {THOUGHT_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
      {agent === "opencode" && (
        <label className="mcp-field mcp-check">
          <input
            type="checkbox"
            checked={autoCompact}
            onChange={(event) => { setAutoCompact(event.target.checked); setSaved(false); }}
          />
          <span>Compact automatically when context runs low</span>
        </label>
      )}
      <span className="mcp-editor-actions">
        <button
          type="button"
          className="btn"
          disabled={!canPersist}
          onClick={() => {
            const next: AgentRuntimePreference = {
              ...(model.trim() === "" ? {} : { model: model.trim() }),
              ...(thoughtLevel === "" ? {} : { thoughtLevel }),
              // An explicit boolean: the operator's choice persists (so an
              // uncheck sticks), and only true arms the launch composition.
              ...(agent === "opencode" ? { autoCompact } : {}),
            };
            void onSave(agent, next).then((ok) => { if (ok) setSaved(true); });
          }}
        >
          {saved ? "Saved" : "Save"}
        </button>
      </span>
      {persistedAnything && (
        <p className="settings-desc">
          Saved values merge per key; string keys cannot be cleared yet — edit
          the settings file to return an agent to its engine default. The
          auto-compact checkbox can be switched off directly.
        </p>
      )}
    </div>
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
          <span title={usage.source === "metered" ? `${usage.requests ?? 0} metered model request(s)` : "agent-reported usage (ACP usage_update)"}>
            {usage.promptTokens !== undefined && usage.completionTokens !== undefined && <>↑{formatTokens(usage.promptTokens)} ↓{formatTokens(usage.completionTokens)} tokens</>}
            {usage.costUsd !== undefined && <> · ${usage.costUsd.toFixed(4)}</>}
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
