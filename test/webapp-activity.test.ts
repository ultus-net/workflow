import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ActivityPage, ActivityPageView } from "../src/ui/webapp/activity-page.js";
import { KIND_LABELS, type TimelineRow, type TimelineState } from "../src/ui/webapp/activity-timeline.js";
import { AppShell } from "../src/ui/webapp/app.js";
import type { AppView } from "../src/ui/webapp/shell.js";
import { TIMELINE_RETENTION } from "../src/integrations/activity-timeline.js";

// W176 phase 3 (issue #347) — the Activity page: the W152 unified timeline
// promoted from the chat panel to a full page with kind filters. Red-first
// pins so the page cannot drift from the W152 panel's honest render
// contract:
//   (a) the kind filter is a view-side SLICE of the relayed record list —
//       selecting a kind renders only that kind's rows, defaulting to all;
//   (b) an empty filtered result names the filter ("no <kind> rows
//       recorded"), never the generic empty copy;
//   (c) the retention statement copies the projection's exported constant
//       (TIMELINE_RETENTION) verbatim into the markup — imported, never
//       retyped, and never taken from the relayed copy;
//   (d) degraded states name why (loading / hub unavailable / degraded
//       registries), and the page OWNS its poll instance;
//   (e) the shell wires the page for #/activity — the phase placeholder is
//       retired.
// Focused-run discipline: node --import tsx --test test/webapp-activity.test.ts.
// (Template literals are deliberately absent: string concatenation keeps
// the source patchable under the guard shell classifier.)

const noop = (): void => {};

const ROWS: readonly TimelineRow[] = [
  { kind: "transition", actor: "unattributed", authority: "unattributed", summary: "Nightly audit: READY → IN_PROGRESS", at: null },
  { kind: "review", actor: "agent (reviewer)", authority: "review-gate verdict record (admitted)", summary: "run author-1: review approved", at: null },
  { kind: "usage", actor: "system", authority: "metering-proxy usage record", summary: "run author-5 usage: 150 tokens", at: "2026-09-27T11:00:00.000Z" },
];

const FEED: TimelineState = {
  timeline: { rows: ROWS, degraded: ["per-session budget state"], retention: TIMELINE_RETENTION },
};

/** React's server escape applied to a literal — lets a pin match the exact
 * exported constant inside SSR markup (apostrophes render as &#x27;). */
const escaped = (value: string): string => value.split("&").join("&").split("'").join("&#x27;");

const renderPage = (kind: string | null, state: TimelineState | undefined): string =>
  renderToStaticMarkup(createElement(ActivityPageView, { state, kind, onKind: noop }));

/** A healthy window whose localStorage is a real map — the seat for the
 * AppShell SSR renders (the shell reads its rail state at mount). */
function installWindowStorage(): { readonly restore: () => void } {
  const backing = new Map<string, string>();
  const previous = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    },
  } as unknown as typeof globalThis.window;
  return { restore: () => void (globalThis.window = previous) };
}

test("the kind filter's options are the panel's own kind labels — the page invents no kind", () => {
  const labels = Object.keys(KIND_LABELS).map((kind) => KIND_LABELS[kind] ?? kind);
  assert.deepEqual(
    labels,
    ["kernel", "review", "gate", "claim", "usage", "schedule", "budget"],
    "the filter vocabulary is exactly the W152 panel's KIND_LABELS set",
  );
});

test("the kind filter slices the relayed record list — selecting a kind renders only that kind's rows", () => {
  const all = renderPage(null, FEED);
  assert.equal(all.split("activity-row activity-row-").length - 1, 3, "the default (no filter) renders every relayed row");
  assert.ok(all.includes("Nightly audit: READY → IN_PROGRESS"), "the kernel transition row renders by default");
  assert.ok(all.includes("run author-1: review approved"), "the review row renders by default");
  assert.ok(all.includes("run author-5 usage: 150 tokens"), "the usage row renders by default");
  assert.equal(all.split('aria-pressed="true"').length - 1, 1, "exactly one filter is active");
  assert.equal(all.split('aria-pressed="false"').length - 1, 7, "the group exposes all kinds plus the all affordance");
  for (const label of ["kernel", "review", "gate", "claim", "usage", "schedule", "budget"]) {
    assert.ok(all.includes(">" + label + "</button>"), "the filter carries the \"" + label + "\" kind");
  }

  const reviewOnly = renderPage("review", FEED);
  assert.equal(reviewOnly.split("activity-row activity-row-").length - 1, 1, "a selected kind renders only its rows");
  assert.ok(reviewOnly.includes("run author-1: review approved"), "the review row survives the slice");
  assert.ok(!reviewOnly.includes("Nightly audit: READY → IN_PROGRESS"), "the kernel row is sliced out, not reordered");
  assert.ok(!reviewOnly.includes("run author-5 usage: 150 tokens"), "the usage row is sliced out");
  assert.ok(reviewOnly.includes('aria-pressed="true"'), "the active filter is marked");

  const kernelOnly = renderPage("transition", FEED);
  assert.ok(kernelOnly.includes("Nightly audit: READY → IN_PROGRESS"), "the transition kind's raw value filters too");
  assert.ok(!kernelOnly.includes("run author-1: review approved"), "the review row is sliced out");
});

test("an empty filtered result names the filter — the generic empty copy never lies about a filter", () => {
  const budgetOnly = renderPage("budget", FEED);
  assert.match(budgetOnly, /no budget rows recorded/, "a kind with zero relayed rows names the filter honestly");
  assert.ok(!budgetOnly.includes("no recorded activity yet"), "the feed is NOT empty — the generic copy would lie under a filter");

  const scheduleOnly = renderPage("origin", FEED);
  assert.match(scheduleOnly, /no schedule rows recorded/, "the filter names its display label (origin renders as schedule)");

  const emptyFeed = renderPage(null, { timeline: { rows: [], degraded: [], retention: TIMELINE_RETENTION } });
  assert.match(emptyFeed, /no recorded activity yet/, "an empty feed with no filter keeps the panel's honest empty copy");

  const emptyFeedFiltered = renderPage("review", { timeline: { rows: [], degraded: [], retention: TIMELINE_RETENTION } });
  assert.match(emptyFeedFiltered, /no review rows recorded/, "a filter over an empty feed still names the filter");
});

test("the retention statement copies the projection's exported constant verbatim — imported, not relayed, not retyped", () => {
  // The fixture's retention field deliberately DIFFERS from the exported
  // constant: the page must render TIMELINE_RETENTION itself, proving the
  // import is the source of the line (the relay's copy is not trusted).
  const doctored: TimelineState = {
    timeline: {
      rows: ROWS,
      degraded: [],
      retention: "a retype would be a lie",
    },
  };
  const markup = renderPage(null, doctored);
  assert.ok(
    markup.includes(escaped(TIMELINE_RETENTION)),
    "the exported TIMELINE_RETENTION constant appears in the markup verbatim (apostrophe-escaped as React renders it)",
  );
  assert.ok(!markup.includes("a retype would be a lie"), "the page renders the projection's constant, never the relayed string");
  assert.match(markup, /reset when the hub process restarts/, "the retention statement's substance renders");
  assert.match(markup, /never claims a permanent record/, "the retention statement's honesty tail renders");
});

test("degraded states name why — the page fails closed like the W152 panel", () => {
  const loading = renderPage(null, undefined);
  assert.match(loading, /hub timeline: loading/, "no answer yet renders the loading state");

  const unavailable = renderPage(null, { timeline: null, reason: "hub unavailable" });
  assert.match(unavailable, /hub timeline unavailable \(hub unavailable\)/, "a hub that cannot answer names the reason");

  const degraded = renderPage(null, FEED);
  assert.match(degraded, /state unavailable: per-session budget state/, "the relay's named absences render beside the rows");
});

test("the page owns its poll instance and the shell wires it for #/activity — the placeholder is retired", () => {
  const page = renderToStaticMarkup(createElement(ActivityPage));
  assert.match(page, /hub timeline: loading/, "the page's own poll renders its loading state before the hub answers");

  const { restore } = installWindowStorage();
  try {
    const shell = renderToStaticMarkup(createElement(AppShell, {
      view: "activity" as AppView,
      setView: noop,
      focusedSessionId: undefined,
      setFocusedSessionId: noop,
    }));
    assert.ok(shell.includes("activity-page"), "the activity view renders the Activity page");
    assert.ok(shell.includes("hub timeline: loading"), "the page's own poll instance answers the shell render");
    assert.ok(!shell.includes("phase-placeholder"), "the activity phase placeholder is retired");
    assert.ok(shell.includes(">Activity</h2>"), "the header still titles the Activity page");
  } finally {
    restore();
  }
});
