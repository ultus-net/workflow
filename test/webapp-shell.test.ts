import assert from "node:assert/strict";
import { test } from "node:test";

import { AppShell, ChatPageHead, CommandPalette, filterPaletteCommands, isPaletteChord, palettePageEntries, StatusBar, type AppView, type PaletteCommand } from "../src/ui/webapp/app.js";
import {
  ShellHeader,
  ShellRail,
  commandView,
  defaultAppView,
  hashForView,
  shellViewTitle,
  viewForHash,
  type RailEntry,
  type RailSection,
} from "../src/ui/webapp/shell.js";
import {
  RAIL_STATE_KEY,
  readRailStateFromWindow,
  readRailStateGuarded,
  saveRailStateGuarded,
  saveRailStateToWindow,
  withRailCollapsed,
  type RailState,
  type RailStorage,
} from "../src/ui/webapp/rail-state.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewView } from "../src/ui/webapp/overview-view.js";

// W174 phase 1a — the dashboard shell: rail, header, hash routing,
// record-backed badges. Red-first pins so the shell refactor cannot silently
// drop pages, fabricate counts, or throw on a withheld storage:
//   (a) hash routes are plain #/<slug> (default #/overview, no router dep);
//   (b) badges render ONLY the recorded count passed in — the rail derives
//       nothing (a badge with no record renders no pill, never a zero);
//   (c) the rail's collapsed preference survives BOTH storage-denial shapes
//       (the issue-view-state guarded pair + the window-level pair that also
//       encloses the window.localStorage PROPERTY access);
//   (d) the five new pages (overview/runs/reviews/activity/audit) are named
//       absences — routes live, content arrives with its phase.
// Focused-run discipline: node --import tsx --test test/webapp-shell.test.ts.
// (Template literals are deliberately absent: string concatenation keeps the
// source patchable under the guard shell classifier.)

const noop = (): void => {};

const noAsync = async (): Promise<void> => {};

const VIEWS: readonly AppView[] = [
  "overview", "chat", "agents", "board", "runs", "reviews",
  "schedules", "projects", "usage", "activity", "audit", "settings",
];

/** A healthy window whose localStorage is a real map — the round-trip seat
 * for the window-level guarded pair and the AppShell SSR renders. */
function installWindowStorage(): { readonly backing: Map<string, string>; readonly restore: () => void } {
  const backing = new Map<string, string>();
  const previous = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    },
  } as unknown as typeof globalThis.window;
  return { backing, restore: () => void (globalThis.window = previous) };
}

test("hash routes: every view round-trips through #/<slug> and the shell defaults to #/overview", () => {
  for (const view of VIEWS) {
    assert.equal(hashForView(view), "#/" + view, "the hash for \"" + view + "\" is its plain slug");
    assert.equal(viewForHash(hashForView(view)), view, "the hash \"#/" + view + "\" routes back to " + view);
  }
  assert.equal(defaultAppView, "overview", "the shell lands on the Overview dashboard by default (#/overview)");
  assert.equal(viewForHash("#/runs"), "runs", "the documented #/runs route resolves");
  assert.equal(viewForHash("#/audit"), "audit", "the documented #/audit route resolves");
  assert.equal(viewForHash(undefined), undefined, "no hash is not a view");
  assert.equal(viewForHash(""), undefined, "an empty hash is not a view");
  assert.equal(viewForHash("#/nope"), undefined, "an unknown slug is not a view — the shell keeps its default");
  assert.equal(viewForHash("runs"), undefined, "a bare slug without the #/ prefix is not a route");
});

test("the command dispatch routes the new pages and keeps every existing command", () => {
  assert.equal(commandView("/overview"), "overview");
  assert.equal(commandView("/runs"), "runs");
  assert.equal(commandView("/reviews"), "reviews");
  assert.equal(commandView("/activity"), "activity");
  assert.equal(commandView("/audit"), "audit");
  assert.equal(commandView("/chat"), "chat");
  assert.equal(commandView("/agents"), "agents");
  assert.equal(commandView("/sessions"), "agents", "/sessions stays the documented /agents alias");
  assert.equal(commandView("/board"), "board");
  assert.equal(commandView("/projects"), "projects");
  assert.equal(commandView("/schedules"), "schedules");
  assert.equal(commandView("/usage"), "usage");
  assert.equal(commandView("/settings"), "settings");
  assert.equal(commandView("/nope"), undefined, "an unknown command still falls through to the session");
  assert.equal(commandView("/agents extra words"), "agents", "only the first word names the command");
});

test("the rail carries every page in its groups, with the wordmark and the collapse affordance", () => {
  const { restore } = installWindowStorage();
  try {
    const markup = renderToStaticMarkup(createElement(AppShell, {
      view: "overview",
      setView: noop,
      focusedSessionId: undefined,
      setFocusedSessionId: noop,
    }));
    for (const label of ["Overview", "Chat", "Board", "Agents", "Runs", "Reviews", "Schedules", "Projects", "Usage", "Activity", "Audit", "Settings"]) {
      assert.ok(markup.includes(label), "the rail is missing the \"" + label + "\" entry");
    }
    for (const group of ["Working", "Automation", "Insight"]) {
      assert.ok(markup.includes(group), "the rail is missing the \"" + group + "\" group title");
    }
    assert.ok(markup.includes(">Workflow</h1>"), "the shell wordmark still renders");
    assert.ok(markup.includes("rail-collapse"), "the rail carries the collapse affordance");
    assert.ok(!markup.includes("rail-collapsed"), "the rail renders expanded by default");
    assert.ok(markup.includes(">Overview</h2>"), "the header carries the per-page title");
    assert.ok(markup.includes("shell-host"), "the enforcement badge renders its loading posture before the snapshot answers");
    assert.ok(markup.includes("posture-strip"), "the posture strip renders directly under the header");
  } finally {
    restore();
  }
});

test("rail badges render only the recorded count passed in — the rail never derives a count", () => {
  const entry = (view: AppView, label: string, badge?: number): RailEntry => ({
    view,
    label,
    icon: null,
    ...(badge === undefined ? {} : { badge }),
  });
  const sections: readonly RailSection[] = [
    { title: "Working", entries: [entry("board", "Board", 3), entry("chat", "Chat")] },
  ];
  const withBadge = renderToStaticMarkup(createElement(ShellRail, {
    view: "overview",
    onSelect: noop,
    sections,
    collapsed: false,
    onToggleCollapsed: noop,
  }));
  assert.ok(withBadge.includes("rail-badge"), "a record-backed count renders as a badge");
  assert.ok(withBadge.includes(">3</span>"), "the badge carries the recorded count verbatim");
  assert.equal(withBadge.split("rail-badge").length - 1, 1, "only the entry WITH a record renders a badge");
  const bare = renderToStaticMarkup(createElement(ShellRail, {
    view: "overview",
    onSelect: noop,
    sections: [{ title: "Working", entries: [entry("board", "Board")] }],
    collapsed: false,
    onToggleCollapsed: noop,
  }));
  assert.ok(!bare.includes("rail-badge"), "no record, no badge — the rail never fabricates a count");
  const { restore } = installWindowStorage();
  try {
    const shell = renderToStaticMarkup(createElement(AppShell, {
      view: "overview",
      setView: noop,
      focusedSessionId: undefined,
      setFocusedSessionId: noop,
    }));
    assert.ok(!shell.includes("rail-badge"), "with no poll records the shell renders no badges at all — never a fabricated zero");
  } finally {
    restore();
  }
});

test("collapsed-state persistence survives both storage-denial shapes", () => {
  const throwingStorage: RailStorage = {
    getItem: () => {
      throw new Error("storage denied");
    },
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };
  assert.deepEqual(
    readRailStateGuarded(throwingStorage),
    {} satisfies RailState,
    "a storage that refuses reads degrades to the honest default",
  );
  assert.doesNotThrow(
    () => saveRailStateGuarded(throwingStorage, { collapsed: true }),
    "a storage that refuses writes no-ops the save — the shell's update path never throws",
  );
  const deniedWindow = {
    get localStorage(): RailStorage {
      throw new Error("storage access denied");
    },
  } as unknown as typeof globalThis.window;
  const previous = globalThis.window;
  globalThis.window = deniedWindow;
  try {
    assert.doesNotThrow(() => readRailStateFromWindow(), "access-time denial degrades to the honest default");
    assert.deepEqual(readRailStateFromWindow(), {} satisfies RailState);
    assert.doesNotThrow(
      () => saveRailStateToWindow({ collapsed: true }),
      "the save path survives the window.localStorage PROPERTY access throwing too",
    );
  } finally {
    globalThis.window = previous;
  }
  const { backing, restore } = installWindowStorage();
  try {
    assert.doesNotThrow(() => saveRailStateToWindow({ collapsed: true }));
    assert.equal(
      backing.get(RAIL_STATE_KEY),
      "{\"collapsed\":true}",
      "the persisted record is the namespaced JSON record",
    );
    assert.deepEqual(readRailStateFromWindow(), { collapsed: true } satisfies RailState, "a healthy storage round-trips");
  } finally {
    restore();
  }
  assert.deepEqual(
    readRailStateGuarded({ getItem: () => "not json", setItem: () => {} }),
    {} satisfies RailState,
    "a corrupt record is dropped, not coerced",
  );
  assert.deepEqual(
    readRailStateGuarded({ getItem: () => "{\"collapsed\":\"yes\"}", setItem: () => {} }),
    {} satisfies RailState,
    "a non-boolean collapsed flag is dropped, not coerced",
  );
  assert.deepEqual(
    withRailCollapsed({ collapsed: true }, false),
    { collapsed: false } satisfies RailState,
    "the toggle is pure",
  );
});

test("the phase pages are named absences — routes live now, content arrives with its phase", () => {
  // Every dashboard page has shipped except Reviews (batch 3): runs landed
  // with W175 phase 2, Activity with W176, Audit with W177.
  const pages: readonly (readonly [AppView, string])[] = [
    ["reviews", "Reviews"],
  ];
  const { restore } = installWindowStorage();
  try {
    for (const [view, title] of pages) {
      const markup = renderToStaticMarkup(createElement(AppShell, {
        view,
        setView: noop,
        focusedSessionId: undefined,
        setFocusedSessionId: noop,
      }));
      assert.ok(markup.includes("phase-placeholder"), view + " renders the named-absence placeholder");
      assert.ok(
        markup.includes("the page arrives with its phase"),
        view + " states that its content arrives with its phase",
      );
      assert.ok(markup.includes(">" + title + "</h2>"), "the header titles the " + title + " page");
    }
    // W177: the audit page shipped its content — it is no longer a
    // placeholder; the shell renders the AuditView (its own named absences:
    // the boundary element + the unanswered relay), never the phase copy.
    const audit = renderToStaticMarkup(createElement(AppShell, {
      view: "audit",
      setView: noop,
      focusedSessionId: undefined,
      setFocusedSessionId: noop,
    }));
    assert.ok(!audit.includes("phase-placeholder"), "the audit page no longer renders the phase placeholder");
    assert.ok(audit.includes("audit-boundary"), "the audit page renders its boundary element");
    assert.ok(audit.includes(">Audit</h2>"), "the header titles the Audit page");
  } finally {
    restore();
  }
});

test("the header is per-page chrome; the + New thread affordance moved into the chat page head", () => {
  const { restore } = installWindowStorage();
  try {
    const board = renderToStaticMarkup(createElement(AppShell, {
      view: "board",
      setView: noop,
      focusedSessionId: undefined,
      setFocusedSessionId: noop,
    }));
    assert.ok(board.includes(">Board</h2>"), "the header carries the page title");
    assert.ok(board.includes("shell-host"), "the enforcement badge renders in the header");
    assert.ok(!board.includes("new-thread"), "the + New thread button no longer rides the global header");
    assert.ok(!board.includes(">Workflow</h1>") === false, "the wordmark rides the rail");
    assert.ok(board.includes("posture-strip"), "the posture strip renders directly under the header");
    const head = renderToStaticMarkup(createElement(ChatPageHead, { session: undefined, refresh: noAsync, onNew: noop }));
    assert.ok(head.includes("new-thread"), "the chat page head carries the new-thread affordance");
    assert.ok(head.includes("Start a new thread"), "the button keeps its documented title");
  } finally {
    restore();
  }
});

test("the shell header stays presentational chrome — the enforcement fact is carried, not owned", () => {
  const markup = renderToStaticMarkup(createElement(ShellHeader, {
    title: "Runs",
    railsOff: false,
    onRailsToggle: noop,
    enforcement: { level: "advisory", transport: "acp", copy: "advisory copy" },
  }));
  assert.ok(markup.includes(">Runs</h2>"), "the header renders the per-page title");
  assert.ok(markup.includes("enforcement-advisory"), "the header renders the enforcement posture verbatim");
  assert.ok(markup.includes("enforcement-transport"), "the transport rides the badge");
  assert.ok(markup.includes("acp"), "the transport renders verbatim");
  assert.ok(markup.includes("rail-toggle"), "the rails (focus-mode) toggle stays header chrome");
});

// ── W174 phase 1b: the Overview landing — five zones, all fed by records ──

const DECISION_ROW = {
  kind: "review" as const,
  actor: "system" as const,
  authority: "hub-reviewer",
  summary: "run schedule:w1:abc awaits the reviewer verdict",
  action: { label: "open schedules", target: "#schedules" },
};

function overviewProps(): Parameters<typeof OverviewView>[0] {
  return {
    runTasks: [{ id: "run:sched:abc", title: "nightly sweep", state: "IN_PROGRESS", blockers: [] }],
    inProgressCount: 2,
    pendingPermission: true,
    awaitingReview: 1,
    decisions: [DECISION_ROW],
    recentRuns: [{ runId: "run:sched:abc", scheduleId: "w1", scheduleTitle: "nightly sweep", tombstoned: false, title: "nightly sweep", state: "FAILED" }],
    schedules: [{ id: "w1", title: "nightly sweep", nextRunAt: "2026-10-01T03:00:00Z" }],
    timeline: { timeline: { rows: [], degraded: [], retention: "in-memory only: the hub's transition log and the run registry's bounded (64-entry) gate journals reset when the hub process restarts; this feed never claims a permanent record" } },
    runsRecord: { runs: null, reason: "hub unavailable" },
    onNavigate: noop,
  };
}

test("the Overview renders its five zones from the records passed in — never a derivation", () => {
  const markup = renderToStaticMarkup(createElement(OverviewView, overviewProps()));
  assert.ok(markup.includes("overview-stats"), "the stat strip zone renders");
  assert.ok(markup.includes("overview-needs-you"), "the needs-you zone renders");
  assert.ok(markup.includes("overview-live-runs"), "the live-runs zone renders");
  assert.ok(markup.includes("overview-next-fires"), "the next-fires zone renders");
  assert.ok(markup.includes("overview-recent-activity"), "the recent-activity zone renders");
  assert.ok(markup.includes("nightly sweep"), "the live-run row renders its record verbatim");
});

test("the recorded-spend tile aggregates the runs relay's per-run usage and says so — the absent relay renders named absence", () => {
  const withUsage = overviewProps();
  (withUsage as unknown as { runsRecord: unknown }).runsRecord = {
    runs: { rows: [{ runId: "run:a", state: "VERIFIED" }, { runId: "run:b", state: "FAILED" }], usage: { "run:a": { requests: 1, promptTokens: 10, completionTokens: 10, totalTokens: 20, costUsd: 0.25, cacheReadTokens: 0, cacheCreateTokens: 0, recordedAt: "t" }, "run:b": { requests: 1, promptTokens: 5, completionTokens: 5, totalTokens: 10, costUsd: 0.75, cacheReadTokens: 0, cacheCreateTokens: 0, recordedAt: "t" } } },
  };
  const markup = renderToStaticMarkup(createElement(OverviewView, withUsage));
  assert.ok(markup.includes("$1.0000"), "the tile sums the recorded per-run costs (0.25 + 0.75) in the house cost format");
  assert.ok(markup.includes("recorded"), "the tile labels the aggregation recorded — never a live meter");

  const withoutRelay = overviewProps();
  const absent = renderToStaticMarkup(createElement(OverviewView, withoutRelay));
  assert.ok(absent.includes("recorded spend arrives with the runs relay"), "the absent relay renders its named absence");
});

test("needs-you links the parked permission and the review-gated decisions to their surfaces", () => {
  const markup = renderToStaticMarkup(createElement(OverviewView, overviewProps()));
  assert.ok(markup.includes("parked permission"), "the parked prompt rides the needs-you zone");
  assert.ok(markup.includes("awaits the reviewer verdict"), "the posture decision renders its record verbatim");
  assert.ok(markup.includes("open schedules"), "the decision's action label renders as the link");
});

test("empty zones name the first action; absent registries say so", () => {
  const markup = renderToStaticMarkup(createElement(OverviewView, {
    ...overviewProps(),
    runTasks: [],
    decisions: [],
    inProgressCount: undefined,
    awaitingReview: null,
  }));
  assert.ok(markup.includes("no runs recorded yet"), "the empty live-runs zone names the first action");
  assert.ok(markup.includes("state unavailable"), "an absent posture registry renders the honest mark, never a fabricated zero");
});

test("an absent schedules registry renders the honest mark, never a fabricated no-schedules zero", () => {
  const markup = renderToStaticMarkup(createElement(OverviewView, {
    ...overviewProps(),
    schedules: undefined,
  }));
  assert.ok(
    markup.includes("state unavailable — the schedules registry has not answered"),
    "the absent schedules registry is named (the review's P2: no fabricated 'no schedules armed' zero)",
  );
  assert.ok(!markup.includes("no schedules armed"), "the fabricated zero does not render for an absent registry");
});

// ── W174 stretch: the ⌘K palette — the shell's pages join the session's slash
// commands in the ONE existing palette list (no second palette). Red-first
// pins: the chord wiring, the page entries' dispatch through commandView, the
// as-you-type filter, and the modal chrome the global Escape arbitration keys
// on. The palette's Enter-dispatch / Esc-close / focus-return manners predate
// this slice (pinned at component level by webapp-surface) and are unchanged
// here; the repo has no DOM-event harness, so the chord is pinned at its pure
// decision point (isPaletteChord) and the filter at its pure decision point
// (filterPaletteCommands).

test("the ⌘K chord joins ctrl+p — both open the palette; a bare key or Alt never does", () => {
  assert.equal(isPaletteChord({ key: "k", ctrlKey: true, metaKey: false, altKey: false }), true, "Ctrl+K opens the palette");
  assert.equal(isPaletteChord({ key: "k", ctrlKey: false, metaKey: true, altKey: false }), true, "Cmd+K opens the palette (the mac chord)");
  assert.equal(isPaletteChord({ key: "p", ctrlKey: true, metaKey: false, altKey: false }), true, "the OpenCode ctrl+p affordance keeps opening the palette");
  assert.equal(isPaletteChord({ key: "K", ctrlKey: true, metaKey: false, altKey: false }), true, "a shifted K still names the chord");
  assert.equal(isPaletteChord({ key: "k", ctrlKey: false, metaKey: false, altKey: false }), false, "a bare k is composer text, never the chord");
  assert.equal(isPaletteChord({ key: "k", ctrlKey: true, metaKey: false, altKey: true }), false, "Alt is not part of the chord");
  assert.equal(isPaletteChord({ key: "Enter", ctrlKey: true, metaKey: false, altKey: false }), false, "other ctrl chords are not the palette chord");
});

test("the palette gains the shell's pages in rail order, each dispatching through commandView", () => {
  const navigated: AppView[] = [];
  const entries = palettePageEntries((view) => void navigated.push(view));
  assert.equal(entries.length, VIEWS.length, "one entry per shell page — no invented pages");
  assert.ok(entries.every((entry) => entry.group === "page"), "page entries carry the page group");
  for (const [position, view] of VIEWS.entries()) {
    const entry = entries[position]!;
    assert.equal(entry.id, "page-" + view, "the \"" + view + "\" entry keeps its slug id");
    assert.equal(entry.title, "Go to " + shellViewTitle(view), "page entries are labeled \"Go to <page>\"");
    entry.run();
    assert.equal(navigated[position], view, "the \"" + view + "\" entry dispatches to its page, in rail order");
    assert.equal(commandView("/" + view), view, "the palette's route for \"" + view + "\" rides the same commandView mapping the composer's slash dispatch uses");
  }
});

test("pages and the session's slash commands share ONE palette list (one listbox, distinct groups)", () => {
  const commands: readonly PaletteCommand[] = [
    { id: "new-session", title: "New session", group: "command", run: noop },
    ...palettePageEntries(noop),
    { id: "slash-runs", title: "/runs", group: "slash", note: "ask the agent", run: noop },
  ];
  const markup = renderToStaticMarkup(createElement(CommandPalette, { commands, onClose: noop }));
  assert.ok(markup.includes('class="palette-list"') && markup.includes('role="listbox"'), "one list renders every vocabulary");
  assert.ok(markup.includes(">Commands</span>") && markup.includes(">Pages</span>") && markup.includes(">Slash commands</span>"), "group headers separate commands, pages, and slash commands");
  assert.ok(markup.includes("Go to Overview") && markup.includes("Go to Settings"), "the shell's pages render as \"Go to <page>\" entries");
  assert.ok(markup.includes("/runs"), "the session's slash commands share the one list");
  assert.ok(markup.includes('aria-modal="true"') && markup.includes("palette-backdrop"), "the modal chrome the global Escape arbitration keys on renders");
});

test("the palette filters as-you-type — trimmed, case-insensitive, on the title", () => {
  const commands: readonly PaletteCommand[] = [
    { id: "page-runs", title: "Go to Runs", group: "page", run: noop },
    { id: "slash-compact", title: "/compact", group: "slash", run: noop },
  ];
  assert.equal(filterPaletteCommands(commands, "").length, 2, "an empty query keeps the full list");
  assert.equal(filterPaletteCommands(commands, "   ").length, 2, "a whitespace query keeps the full list");
  assert.deepEqual(
    filterPaletteCommands(commands, "RUNS").map((entry) => entry.id),
    ["page-runs"],
    "the filter is case-insensitive on the title",
  );
  assert.deepEqual(
    filterPaletteCommands(commands, " comp ").map((entry) => entry.id),
    ["slash-compact"],
    "a trimmed substring matches",
  );
  assert.deepEqual(
    filterPaletteCommands(commands, "COMPACT").map((entry) => entry.id),
    ["slash-compact"],
    "case-insensitivity holds on the slash-command side too",
  );
  assert.equal(filterPaletteCommands(commands, "nope").length, 0, "no matches empties the list (the component renders its named empty state)");
});

test("the ⌘K hint rides the status bar's keybind strip — the affordance, no new button", () => {
  const markup = renderToStaticMarkup(createElement(StatusBar, {
    agent: undefined,
    model: undefined,
    usage: undefined,
    branch: undefined,
    isRunning: false,
  }));
  assert.ok(markup.includes("status-bar-keys"), "the keybind strip renders");
  assert.ok(markup.includes(">K</kbd>") && markup.includes("palette"), "the Ctrl+K hint rides the strip beside the existing ctrl+p hint");
  assert.ok(markup.includes(">P</kbd>"), "the OpenCode ctrl+p hint stays");
});
