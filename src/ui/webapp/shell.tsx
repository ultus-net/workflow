/**
 * W174 phase 1a — the dashboard shell: three regions (rail / header /
 * content) that app.tsx composes. The shell owns chrome only: the rail's
 * grouped navigation, the per-page header (title + enforcement fact + the
 * focus-mode toggle), and the plain hash routing (`#/` + slug, default
 * `#/overview`, no router dependency). Presentation never owns canonical
 * state: every badge count arrives as a prop computed from the shell's
 * existing polls — the rail derives nothing, and an entry with no record
 * renders no badge (never a fabricated zero).
 *
 * The collapsed rail preference persists per browser through rail-state.ts
 * (the two-shape guarded-localStorage pattern).
 *
 * (Template literals are deliberately absent: string concatenation keeps
 * the source patchable under the guard shell classifier.)
 */

import type { ReactNode } from "react";

/**
 * Top-bar views. Agents (renamed from "Sessions" 2026-09-19) and Schedules
 * are pages (nav slugs); session history stays reachable from the composer
 * via the /agents command, with /sessions kept as an alias. The settings
 * panel (W077-era operator surfaces) is reachable from the gear and the
 * Ctrl/Cmd+, command. W174 phase 1a adds the dashboard pages (overview at
 * the rail's top, plus runs / reviews / activity / audit); their content
 * arrives with the next phase — routes live now.
 */
export type AppView =
  | "overview"
  | "chat"
  | "agents"
  | "board"
  | "runs"
  | "reviews"
  | "schedules"
  | "projects"
  | "usage"
  | "activity"
  | "audit"
  | "settings";

/** Every route the shell honors, in rail order. */
export const APP_VIEWS: readonly AppView[] = [
  "overview", "chat", "agents", "board", "runs", "reviews",
  "schedules", "projects", "usage", "activity", "audit", "settings",
];

/** The view a first paint lands on when no hash (or no known hash) says
 * otherwise: the Overview dashboard. */
export const defaultAppView: AppView = "overview";

/** Plain hash routing: the view's location hash is "#/" + its slug. */
export function hashForView(view: AppView): string {
  return "#/" + view;
}

/** The view a location hash routes to — strict "#/<slug>" membership;
 * anything else (no hash, empty, bare slug, unknown slug) is not a route
 * and the caller keeps its default. */
export function viewForHash(hash: string | undefined): AppView | undefined {
  if (hash === undefined || !hash.startsWith("#/")) return undefined;
  const slug = hash.slice(2);
  return (APP_VIEWS as readonly string[]).includes(slug) ? (slug as AppView) : undefined;
}

/** The slash command a dispatch word routes to. "/sessions" stays the
 * documented "/agents" alias; only the first word names the command; an
 * unknown command falls through to the session (undefined). */
export function commandView(command: string): AppView | undefined {
  const name = command.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (name === "/overview") return "overview";
  if (name === "/runs") return "runs";
  if (name === "/reviews") return "reviews";
  if (name === "/activity") return "activity";
  if (name === "/audit") return "audit";
  if (name === "/agents" || name === "/sessions") return "agents";
  if (name === "/schedules") return "schedules";
  if (name === "/board") return "board";
  if (name === "/projects") return "projects";
  if (name === "/usage") return "usage";
  if (name === "/settings") return "settings";
  if (name === "/chat") return "chat";
  return undefined;
}

/** The header's per-page title. */
export function shellViewTitle(view: AppView): string {
  return SHELL_VIEW_TITLES[view] ?? view;
}

const SHELL_VIEW_TITLES: Record<AppView, string> = {
  overview: "Overview",
  chat: "Chat",
  agents: "Agents",
  board: "Board",
  runs: "Runs",
  reviews: "Reviews",
  schedules: "Schedules",
  projects: "Projects",
  usage: "Usage",
  activity: "Activity",
  audit: "Audit",
  settings: "Settings",
};

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.1" />
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.2v1.7M8 13.1v1.7M14.8 8h-1.7M2.9 8H1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2M12.7 12.7l-1.2-1.2M4.5 4.5L3.3 3.3" />
    </svg>
  );
}

/** Nav slug glyphs — the icon sits beside the label in the rail. */
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
function AgentsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="4.2" />
      <rect x="2.5" y="9.3" width="11" height="4.2" />
      <circle cx="5" cy="4.6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="5" cy="11.4" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Three-column kanban glyph for the Board slug. */
function BoardIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="3.2" height="11" />
      <rect x="6.4" y="2.5" width="3.2" height="7.5" />
      <rect x="10.3" y="2.5" width="3.2" height="9.5" />
    </svg>
  );
}

/** Calendar glyph for the Schedules slug. */
function SchedulesIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="10" />
      <path d="M2.5 6.5h11" />
      <path d="M5.5 2v3M10.5 2v3" />
      <path d="M5.5 9.5h2M5.5 11.5h5" />
    </svg>
  );
}

/** Container glyph for the Projects slug — a box holding one pinned record. */
function ProjectsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 5.5 8 2.5l5.5 3v5L8 13.5 2.5 10.5z" />
      <path d="M2.5 5.5 8 8.5l5.5-3" />
      <path d="M8 8.5v5" />
    </svg>
  );
}

/** Four-quadrant dashboard glyph for the Overview slug. */
function OverviewIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.6" height="4.6" />
      <rect x="8.9" y="2.5" width="4.6" height="4.6" />
      <rect x="2.5" y="8.9" width="4.6" height="4.6" />
      <rect x="8.9" y="8.9" width="4.6" height="4.6" />
    </svg>
  );
}

/** Run-arrow glyph for the Runs slug. */
function RunsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 3.5v9l7-4.5z" />
      <path d="M2.5 3.5v9" />
    </svg>
  );
}

/** Check-in-box glyph for the Reviews slug. */
function ReviewsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M5.5 8.2l2 2 3.2-3.9" />
    </svg>
  );
}

/** Pulse glyph for the Activity slug. */
function ActivityIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" />
    </svg>
  );
}

/** Ledger-plus-magnifier glyph for the Audit slug. */
function AuditIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M3 3.5h10M3 6.5h10M3 9.5h5" />
      <circle cx="11.2" cy="11.2" r="2.3" />
      <path d="M13 13l1.6 1.6" />
    </svg>
  );
}

export const ENFORCEMENT_COPY: Record<string, string> = {
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
      className={"enforcement-badge enforcement-" + level}
      title={copy}
      aria-label={copy ?? "enforcement level unavailable"}
    >
      {level.toUpperCase()}
      {transport !== undefined && <span className="enforcement-transport"> / {transport}</span>}
    </span>
  );
}

/** Focus-mode toggle (the side panels of the chat page). The setting itself
 * lives in App so the settings dialog's Focus mode row and this button
 * always read/write the same setting. */
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

/** One rail entry: the page, its glyph and label, and — when a record says
 * so — its badge count. The badge is the ONLY count source: undefined means
 * no record exists, and no badge renders (never a fabricated zero). */
export interface RailEntry {
  readonly view: AppView;
  readonly label: string;
  readonly icon: ReactNode;
  readonly badge?: number | undefined;
}

/** A titled group of rail entries (Working / Runs / Automation / Insight);
 * the untitled sections pin Overview at the rail's top and Settings at its
 * bottom. */
export interface RailSection {
  readonly title?: string;
  readonly entries: readonly RailEntry[];
}

/** The record-backed badge counts the rail renders — each one is a count a
 * poll answered (the board payload's in_progress keys, the session
 * registry, a pending permission prompt); undefined means no record, and
 * no badge renders (never a fabricated zero). */
export interface RailBadges {
  readonly chat?: number | undefined;
  readonly board?: number | undefined;
  readonly agents?: number | undefined;
}

/** The rail's page groups in their recorded order. */
export function shellRailSections(badges: RailBadges = {}): readonly RailSection[] {
  return [
    { entries: [{ view: "overview", label: "Overview", icon: <OverviewIcon /> }] },
    {
      title: "Working",
      entries: [
        { view: "chat", label: "Chat", icon: <ChatIcon />, badge: badges.chat },
        { view: "board", label: "Board", icon: <BoardIcon />, badge: badges.board },
        { view: "agents", label: "Agents", icon: <AgentsIcon />, badge: badges.agents },
      ],
    },
    {
      title: "Runs",
      entries: [
        { view: "runs", label: "Runs", icon: <RunsIcon /> },
        { view: "reviews", label: "Reviews", icon: <ReviewsIcon /> },
      ],
    },
    {
      title: "Automation",
      entries: [
        { view: "schedules", label: "Schedules", icon: <SchedulesIcon /> },
        { view: "projects", label: "Projects", icon: <ProjectsIcon /> },
      ],
    },
    {
      title: "Insight",
      entries: [
        { view: "usage", label: "Usage", icon: <UsageIcon /> },
        { view: "activity", label: "Activity", icon: <ActivityIcon /> },
        { view: "audit", label: "Audit", icon: <AuditIcon /> },
      ],
    },
    { entries: [{ view: "settings", label: "Settings", icon: <GearIcon /> }] },
  ];
}

/** The navigation rail. Collapsed, it narrows to the icon column (the
 * label's title attribute keeps each entry reachable); the collapsed
 * preference persists per browser through rail-state.ts. */
export function ShellRail({ view, onSelect, sections, collapsed, onToggleCollapsed }: {
  readonly view: AppView;
  readonly onSelect: (view: AppView) => void;
  readonly sections: readonly RailSection[];
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
}) {
  return (
    <nav className={"rail" + (collapsed ? " rail-collapsed" : "")} aria-label="Pages">
      <div className="rail-head">
        <h1 className="shell-wordmark">{collapsed ? "W" : "Workflow"}</h1>
        <button
          type="button"
          className="rail-collapse"
          title={collapsed ? "Expand the rail" : "Collapse the rail"}
          aria-label={collapsed ? "Expand the navigation rail" : "Collapse the navigation rail"}
          aria-pressed={collapsed}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5.5 3.5 10 8l-4.5 4.5" />
              <path d="M10.5 3.5 15 8l-4.5 4.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.5 3.5 6 8l4.5 4.5" />
              <path d="M5.5 3.5 1 8l4.5 4.5" />
            </svg>
          )}
        </button>
      </div>
      <div className="rail-groups">
        {sections.map((section, index) => (
          <div className="rail-section" key={section.title ?? ("tail-" + index)}>
            {section.title !== undefined && !collapsed && (
              <div className="rail-section-title">{section.title}</div>
            )}
            {section.entries.map((entry) => {
              const on = view === entry.view;
              return (
                <button
                  key={entry.view}
                  type="button"
                  className={"rail-entry" + (on ? " rail-entry-on" : "")}
                  aria-current={on ? "page" : undefined}
                  title={collapsed ? entry.label : undefined}
                  onClick={() => onSelect(entry.view)}
                >
                  <span className="rail-entry-icon" aria-hidden="true">{entry.icon}</span>
                  <span className="rail-entry-label">{entry.label}</span>
                  {entry.badge === undefined ? null : <span className="rail-badge">{entry.badge}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

/** The page header: the per-page title on the left; the focus-mode toggle
 * and the enforcement fact on the right. The posture strip renders directly
 * under this header (app.tsx composes the pair). */
export function ShellHeader({ title, railsOff, onRailsToggle, enforcement }: {
  readonly title: string;
  readonly railsOff: boolean | undefined;
  readonly onRailsToggle: ((off: boolean) => void) | undefined;
  readonly enforcement: {
    readonly level: string | undefined;
    readonly transport: string | undefined;
    readonly copy: string | undefined;
  };
}) {
  return (
    <header className="shell-header">
      <div className="shell-header-left">
        <h2 className="shell-page-title">{title}</h2>
      </div>
      <div className="shell-header-actions">
        {railsOff !== undefined && onRailsToggle !== undefined && (
          <RailsToggle off={railsOff} onToggle={onRailsToggle} />
        )}
        <EnforcementBadge level={enforcement.level} transport={enforcement.transport} copy={enforcement.copy} />
      </div>
    </header>
  );
}