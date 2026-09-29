import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RunDetailPanel } from "../src/ui/webapp/run-detail-panel.js";
import {
  ReviewsView,
  deriveReviewRows,
  filterReviewRows,
  reviewFilterChoices,
  reviewRowVerdict,
  reviewVerdictToken,
  type ReviewFilters,
} from "../src/ui/webapp/reviews-view.js";
import type { RunsRecordState } from "../src/ui/webapp/runs-record.js";
import {
  RUN_DETAIL_STATE_KEY,
  readRunDetailOpen,
  saveRunDetailOpen,
  type RunDetailOpen,
} from "../src/ui/webapp/run-detail-state.js";
import { AppShell } from "../src/ui/webapp/app.js";

// W176 phase 3 (#347) — the Reviews page: one row per review-gated run. The
// row set derives ONLY from the /api/runs relay's records: a run is
// review-gated when the relay's reviewOutcomes or blockingReasons carry it,
// or its registry row's recorded state is VERIFYING. Red-first pins so the
// page cannot silently fabricate records or verdicts:
//   (a) verdict rendering comes from the outcome RECORD's own vocabulary —
//       approved says itself; changes_requested (the reviewer's rejection
//       verdict, which the fail-closed path records too) renders failed;
//       a run with no outcome record is pending; a verdict outside the
//       recorded vocabulary renders lowercased verbatim (the statusToken
//       rule), never styled by a guess;
//   (b) the axes the verdict names render verbatim from the outcome record's
//       summary — the page never re-parses the record;
//   (c) the blocking reason renders verbatim when the run sits VERIFYING —
//       and not otherwise;
//   (d) un-gated runs fabricate no rows, and no duration is ever derived;
//   (e) the empty state names the first action ("no review-gated runs
//       recorded");
//   (f) the shared run detail panel opens on its Review tab from this page,
//       and the opener memory carries the target tab;
//   (g) the shell mounts the page — the last phase placeholder is retired.
// Focused-run discipline: node --import tsx --test test/webapp-reviews.test.ts.
// (Template literals are deliberately absent: string concatenation keeps
// the source patchable under the guard shell classifier.)

const noop = (): void => {};

const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

const RUN_APPROVED = "schedule:w1:rev-approved";
const RUN_FAILED = "board:github:12:rev-changes";
const RUN_PENDING = "schedule:w2:rev-verifying";
const RUN_UNGATED = "agent-run:777";
const RUN_BLOCKING_ONLY = "schedule:w4:blocking-only";
const RUN_MAP_ONLY = "schedule:w3:map-only";

const APPROVED_AXES = "test integrity: pinned; task completeness: full; cleanliness: clean; security: sound; platform: exact";
const FAILED_AXES = "test integrity: one red; task completeness: partial; security: unsound";
const BLOCKING_REASON = "blocked at the review gate: the reviewer session never answered";

/** A record whose rows mix the three gating sources with an un-gated run —
 * every pin's input in one /api/runs block. */
function fullReviewsRecord(): RunsRecordState {
  return {
    runs: {
      rows: [
        { runId: RUN_APPROVED, title: "nightly sweep", state: "VERIFIED", startedAt: "2026-09-30T10:00:00Z" },
        { runId: RUN_FAILED, title: "#12 fix the gate", state: "FAILED", startedAt: "2026-09-30T09:00:00Z" },
        { runId: RUN_PENDING, title: "awaiting the reviewer", state: "VERIFYING" },
        { runId: RUN_UNGATED, title: "plain run", state: "IN_PROGRESS" },
      ],
      origins: {
        [RUN_APPROVED]: { kind: "schedule", scheduleId: "w1" },
        [RUN_PENDING]: { kind: "provider-task", provider: "github", key: "#9", url: "https://github.com/acme/widget/issues/9" },
      },
      reviewOutcomes: {
        [RUN_APPROVED]: {
          reviewerRunId: "schedule:hub-reviewer:rev1",
          verdict: "approved",
          recorded: true,
          summary: APPROVED_AXES,
        },
        [RUN_FAILED]: {
          reviewerRunId: "schedule:hub-reviewer:rev2",
          verdict: "changes_requested",
          recorded: true,
          summary: FAILED_AXES,
        },
      },
      blockingReasons: { [RUN_PENDING]: BLOCKING_REASON },
      completionClaims: {},
    },
  };
}

function reviewsProps(overrides?: { readonly record?: RunsRecordState | undefined; readonly filters?: ReviewFilters }): Parameters<typeof ReviewsView>[0] {
  return {
    // "record" in overrides (not ??): an EXPLICIT undefined record is the
    // unanswered-poll case the pins exercise.
    record: overrides !== undefined && "record" in overrides ? overrides.record : fullReviewsRecord(),
    selectedRunId: undefined,
    onSelectRun: noop,
    ...(overrides?.filters === undefined ? {} : { filters: overrides.filters }),
  };
}

function detailProps(overrides?: { readonly initialTab?: "summary" | "review" }): Parameters<typeof RunDetailPanel>[0] {
  return {
    runId: RUN_APPROVED,
    record: fullReviewsRecord(),
    timeline: { timeline: null },
    boardRead: null,
    opener: "reviews",
    onBack: noop,
    evidenceRows: [],
    ...(overrides?.initialTab === undefined ? {} : { initialTab: overrides.initialTab }),
  };
}

// ── the row set ──

test("one row per review-gated run — the row set derives from the records, never a guess", () => {
  const markup = renderToStaticMarkup(createElement(ReviewsView, reviewsProps()));
  assert.equal(count(markup, "data-run-row="), 3, "exactly the review-gated runs render rows: the approved verdict, the rejection, and the VERIFYING waiter");
  for (const runId of [RUN_APPROVED, RUN_FAILED, RUN_PENDING]) {
    assert.ok(markup.includes(runId), "the reviews table is missing review-gated run \"" + runId + "\"");
  }
  assert.ok(!markup.includes(RUN_UNGATED), "an un-gated run fabricates no row (the pin's negative: the rows list carries it, the page does not)");
  const record = fullReviewsRecord();
  assert.deepEqual(
    deriveReviewRows(record.runs!).map((row) => row.runId),
    [RUN_APPROVED, RUN_FAILED, RUN_PENDING],
    "the derived row set is the gated union of the rows list and the gate maps, in record order",
  );
});

test("a run carried only by its verdict or blocking record is still review-gated", () => {
  const record: RunsRecordState = {
    runs: {
      rows: [{ runId: RUN_UNGATED, title: "plain run", state: "IN_PROGRESS" }],
      reviewOutcomes: {
        [RUN_MAP_ONLY]: { reviewerRunId: "schedule:hub-reviewer:rev9", verdict: "approved", recorded: true, summary: "test integrity: pinned" },
      },
      blockingReasons: {},
      completionClaims: {},
    },
  };
  const markup = renderToStaticMarkup(createElement(ReviewsView, reviewsProps({ record })));
  assert.ok(markup.includes(RUN_MAP_ONLY), "a recorded verdict gates its run into the page even when no registry row carries it");
  assert.equal(count(markup, "data-run-row="), 1, "exactly the record-gated run renders");
  assert.ok(markup.includes("no recorded time"), "a run without a registry row renders the named absence — never a derived time");

  // The blocking-map-only case (the review's P3: the map-only pin above
  // exercises only the outcomes map): a run in blockingReasons with no
  // registry row and no outcome renders too, verdict pending, blocking
  // absent, time absent — never dropped.
  const blockingOnly: RunsRecordState = {
    runs: {
      rows: [],
      reviewOutcomes: {},
      blockingReasons: { [RUN_BLOCKING_ONLY]: "the reviewer never returned" },
      completionClaims: {},
    },
  };
  const blockingMarkup = renderToStaticMarkup(createElement(ReviewsView, reviewsProps({ record: blockingOnly })));
  assert.ok(blockingMarkup.includes(RUN_BLOCKING_ONLY), "a blocking record alone gates its run into the page");
  assert.equal(reviewRowVerdict(undefined), "pending", "the blocking-only row's verdict is pending");
  assert.ok(blockingMarkup.includes("no recorded time"), "the blocking-only row renders the named absence for time");
});

// ── the verdict column ──

test("verdict renders from the outcome record's vocabulary — approved/failed/pending, never a guess", () => {
  assert.equal(reviewVerdictToken("approved"), "approved", "an approved verdict says itself");
  assert.equal(reviewVerdictToken("changes_requested"), "failed", "the reviewer's rejection verdict renders failed");
  assert.equal(reviewVerdictToken("fail"), "failed");
  assert.equal(reviewVerdictToken("CHANGES_REQUESTED"), "failed", "the vocabulary match is case-insensitive");
  assert.equal(reviewVerdictToken("interrupted"), "interrupted", "a verdict outside the recorded vocabulary renders lowercased verbatim — never styled by a guess (the statusToken rule)");
  assert.equal(reviewRowVerdict(undefined), "pending", "no outcome record — the verdict is pending (it has not been recorded)");
  const markup = renderToStaticMarkup(createElement(ReviewsView, reviewsProps()));
  assert.ok(markup.includes(">approved</span>") && markup.includes("runs-verdict-approved"), "the approved outcome renders its verdict");
  assert.ok(markup.includes(">failed</span>") && markup.includes("runs-verdict-failed"), "the rejection renders failed");
  assert.ok(markup.includes(">pending</span>") && markup.includes("runs-verdict-pending"), "the outcomeless VERIFYING waiter renders pending");
});

// ── the axes column ──

test("the axes the verdict names render verbatim from the outcome record's summary — never re-parsed", () => {
  const markup = renderToStaticMarkup(createElement(ReviewsView, reviewsProps()));
  assert.ok(markup.includes(APPROVED_AXES), "the approved verdict's axes render the recorded summary verbatim");
  assert.ok(markup.includes(FAILED_AXES), "the rejection's axes render verbatim too");
  assert.equal(count(markup, "no verdict axes recorded yet"), 1, "the outcomeless waiter names the absence instead of inventing axes");
  const source = readFileSync(resolve("src/ui/webapp/reviews-view.tsx"), "utf8");
  assert.ok(
    !/summary\.(split|match|slice|trim|includes|toLowerCase)\(/.test(source),
    "the page never re-parses the recorded summary — the record renders whole (CSS clamps the row, not a derivation)",
  );
});

// ── the blocking column ──

test("the blocking reason renders verbatim when the run sits VERIFYING — and not otherwise", () => {
  const markup = renderToStaticMarkup(createElement(ReviewsView, reviewsProps()));
  assert.ok(markup.includes(BLOCKING_REASON), "the VERIFYING waiter's blocking reason renders verbatim");
  assert.equal(count(markup, BLOCKING_REASON), 1, "the reason renders on exactly its row");
  const settledRecord: RunsRecordState = {
    runs: {
      rows: [{ runId: RUN_FAILED, title: "#12 fix the gate", state: "FAILED", startedAt: "2026-09-30T09:00:00Z" }],
      reviewOutcomes: {
        [RUN_FAILED]: { reviewerRunId: "schedule:hub-reviewer:rev2", verdict: "changes_requested", recorded: true, summary: FAILED_AXES },
      },
      blockingReasons: { [RUN_FAILED]: BLOCKING_REASON },
      completionClaims: {},
    },
  };
  const settled = renderToStaticMarkup(createElement(ReviewsView, reviewsProps({ record: settledRecord })));
  assert.ok(!settled.includes(BLOCKING_REASON), "a run no longer sitting VERIFYING does not render the blocking reason in its row (the detail panel's Review tab carries the record)");
  assert.ok(settled.includes(">failed</span>"), "the settled rejection renders its verdict");
  const waiting: RunsRecordState = {
    runs: {
      rows: [{ runId: RUN_PENDING, title: "awaiting the reviewer", state: "VERIFYING" }],
      reviewOutcomes: {},
      blockingReasons: {},
      completionClaims: {},
    },
  };
  const waitingMarkup = renderToStaticMarkup(createElement(ReviewsView, reviewsProps({ record: waiting })));
  assert.equal(count(waitingMarkup, "data-run-row="), 1, "the VERIFYING state ALONE gates the row (no outcome, no blocking record needed)");
  assert.ok(waitingMarkup.includes(">pending</span>"), "a VERIFYING run with no outcome record renders pending");
  assert.ok(waitingMarkup.includes("no blocking reason recorded"), "a VERIFYING run with no blocking record names the absence");
});

// ── the recorded-time column ──

test("recorded time renders ONLY where the run's registry record carries startedAt — no duration ever", () => {
  const markup = renderToStaticMarkup(createElement(ReviewsView, reviewsProps()));
  assert.equal(count(markup, "no recorded time"), 1, "the row without a begin record renders the named absence (the map-only cases ride their own pins)");
  assert.ok(
    markup.includes('title="2026-09-30T10:00:00Z"') && markup.includes('title="2026-09-30T09:00:00Z"'),
    "the rows with begin records render the recorded instants verbatim (the full stamp on hover)",
  );
  assert.ok(
    !markup.toLowerCase().includes("duration"),
    "no duration renders anywhere — the relay carries no duration record and the view never derives one",
  );
});

// ── empty states ──

test("the empty page names the first action — no review-gated runs recorded", () => {
  const empty: RunsRecordState = { runs: { rows: [], reviewOutcomes: {}, blockingReasons: {}, completionClaims: {} } };
  const markup = renderToStaticMarkup(createElement(ReviewsView, reviewsProps({ record: empty })));
  assert.ok(markup.includes("no review-gated runs recorded"), "the empty state names the first action");
});

test("un-gated runs fabricate no rows — an all-un-gated registry renders the same empty page", () => {
  const unGated: RunsRecordState = {
    runs: {
      rows: [
        { runId: RUN_UNGATED, title: "plain run", state: "IN_PROGRESS" },
        { runId: "schedule:w9:done", title: "settled run", state: "VERIFIED", startedAt: "2026-09-30T08:00:00Z" },
      ],
      reviewOutcomes: {},
      blockingReasons: {},
      completionClaims: {},
    },
  };
  const markup = renderToStaticMarkup(createElement(ReviewsView, reviewsProps({ record: unGated })));
  assert.equal(count(markup, "data-run-row="), 0, "no row for a run the records do not gate");
  assert.ok(markup.includes("no review-gated runs recorded"), "an all-un-gated registry renders the empty state, never a fabricated table");
});

// ── degraded states ──

test("a hub that predates the relay (or is unreachable) renders the named absence", () => {
  const absent = renderToStaticMarkup(createElement(ReviewsView, reviewsProps({ record: { runs: null, reason: "hub unavailable" } })));
  assert.ok(absent.includes("runs relay unavailable (hub unavailable)"), "the relay's named absence carries the transport's reason");
  const unanswered = renderToStaticMarkup(createElement(ReviewsView, reviewsProps({ record: undefined })));
  assert.ok(unanswered.includes("state unavailable — the runs relay has not answered"), "the unanswered poll is named, never an empty table");
});

// ── the verdict filter ──

test("the verdict filter slices the derived rows — its choices derive from the records", () => {
  const rows = deriveReviewRows(fullReviewsRecord().runs!);
  assert.deepEqual(filterReviewRows(rows, { verdict: "all" }).map((row) => row.runId), [RUN_APPROVED, RUN_FAILED, RUN_PENDING], "the all filter keeps every gated run");
  assert.deepEqual(filterReviewRows(rows, { verdict: "approved" }).map((row) => row.runId), [RUN_APPROVED]);
  assert.deepEqual(filterReviewRows(rows, { verdict: "failed" }).map((row) => row.runId), [RUN_FAILED]);
  assert.deepEqual(filterReviewRows(rows, { verdict: "pending" }).map((row) => row.runId), [RUN_PENDING]);
  assert.deepEqual(reviewFilterChoices(rows), ["all", "approved", "failed", "pending"], "the options are the verdicts actually derived (first-seen order), never a hardcoded list");
  assert.deepEqual(reviewFilterChoices(filterReviewRows(rows, { verdict: "approved" })), ["all", "approved"], "a record without a bucket offers no such option");
  const filtered = renderToStaticMarkup(createElement(ReviewsView, reviewsProps({ filters: { verdict: "approved" } })));
  assert.ok(filtered.includes(RUN_APPROVED), "the approved filter keeps its run");
  assert.ok(!filtered.includes(RUN_FAILED) && !filtered.includes(RUN_PENDING), "the filter drops the rows outside the bucket");
  const approvedOnly: RunsRecordState = {
    runs: {
      rows: [{ runId: RUN_APPROVED, title: "nightly sweep", state: "VERIFIED", startedAt: "2026-09-30T10:00:00Z" }],
      reviewOutcomes: {
        [RUN_APPROVED]: { reviewerRunId: "schedule:hub-reviewer:rev1", verdict: "approved", recorded: true, summary: APPROVED_AXES },
      },
      blockingReasons: {},
      completionClaims: {},
    },
  };
  const none = renderToStaticMarkup(createElement(ReviewsView, reviewsProps({ record: approvedOnly, filters: { verdict: "pending" } })));
  assert.ok(none.includes("no review-gated runs match the filter"), "a matching-nothing filter names itself");
});

// ── the shared detail panel opens on the Review tab ──

test("the detail panel opens on the Review tab when told — the default stays Summary", () => {
  const reviewOpen = renderToStaticMarkup(createElement(RunDetailPanel, detailProps({ initialTab: "review" })));
  assert.ok(reviewOpen.includes('<section role="tabpanel" aria-label="Review">'), "the Review tabpanel renders visible");
  assert.ok(!reviewOpen.includes('aria-label="Review" hidden'), "the Review tabpanel is not hidden");
  assert.ok(reviewOpen.includes('aria-label="Summary" hidden'), "the Summary tabpanel renders hidden behind it");
  assert.ok(/aria-selected="true"[^>]*>Review</.test(reviewOpen), "the Review tab carries the selection");
  assert.ok(reviewOpen.includes("verdict: approved"), "the Review tab's verdict record renders");
  const defaultOpen = renderToStaticMarkup(createElement(RunDetailPanel, detailProps()));
  assert.ok(defaultOpen.includes('aria-label="Review" hidden'), "without an initial tab the panel opens on Summary (the runs page's default, untouched)");
  assert.ok(/aria-selected="true"[^>]*>Summary</.test(defaultOpen), "the Summary tab carries the selection");
});

// ── the opener memory carries the target tab ──

function sessionStub(): { readonly backing: Map<string, string>; readonly storage: Storage } {
  const backing = new Map<string, string>();
  return {
    backing,
    storage: {
      get length(): number { return backing.size; },
      clear: () => void backing.clear(),
      getItem: (key: string) => backing.get(key) ?? null,
      key: (index: number) => [...backing.keys()][index] ?? null,
      removeItem: (key: string) => void backing.delete(key),
      setItem: (key: string, value: string) => void backing.set(key, value),
    },
  };
}

test("the opener memory carries the target tab — a wrong-typed or unknown tab drops the record", () => {
  const { backing, storage } = sessionStub();
  saveRunDetailOpen(storage, { opener: "reviews", runId: RUN_APPROVED, tab: "review" } satisfies RunDetailOpen);
  assert.equal(backing.get(RUN_DETAIL_STATE_KEY), "{\"opener\":\"reviews\",\"runId\":\"" + RUN_APPROVED + "\",\"tab\":\"review\"}", "the persisted record is the namespaced JSON record with its tab");
  assert.deepEqual(readRunDetailOpen(storage), { opener: "reviews", runId: RUN_APPROVED, tab: "review" }, "a healthy record round-trips with its tab");
  backing.set(RUN_DETAIL_STATE_KEY, "{\"opener\":\"reviews\",\"runId\":\"" + RUN_APPROVED + "\",\"tab\":\"made-up\"}");
  assert.equal(readRunDetailOpen(storage), undefined, "a tab outside the panel's vocabulary drops the record — nothing is coerced");
  backing.set(RUN_DETAIL_STATE_KEY, "{\"opener\":\"reviews\",\"runId\":\"" + RUN_APPROVED + "\",\"tab\":7}");
  assert.equal(readRunDetailOpen(storage), undefined, "a wrong-typed tab drops the record");
  backing.set(RUN_DETAIL_STATE_KEY, "{\"opener\":\"reviews\",\"runId\":\"" + RUN_APPROVED + "\"}");
  assert.deepEqual(readRunDetailOpen(storage), { opener: "reviews", runId: RUN_APPROVED }, "a record without a tab (the runs page's opener) still round-trips");
});

// ── the shell mounts the reviews page ──

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

test("the shell mounts the reviews page — the last phase placeholder is retired", () => {
  const { restore } = installWindowStorage();
  try {
    const markup = renderToStaticMarkup(createElement(AppShell, {
      view: "reviews" as const,
      setView: noop,
      focusedSessionId: undefined,
      setFocusedSessionId: noop,
    }));
    assert.ok(markup.includes("reviews-body"), "the shell mounts the ReviewsView in its page region, not the phase placeholder");
    assert.ok(!markup.includes("phase-placeholder"), "the reviews placeholder is gone — no phase placeholder remains anywhere in the app");
    assert.ok(markup.includes(">Reviews</h2>"), "the header titles the Reviews page");
    assert.ok(
      markup.includes("state unavailable — the runs relay has not answered"),
      "with no poll record (an SSR render) the page renders the named absence",
    );
  } finally {
    restore();
  }
});

test("the wiring: the reviews page's rows open the shared panel on the Review tab", () => {
  const source = readFileSync(resolve("src/ui/webapp/app.tsx"), "utf8");
  assert.ok(!source.includes("PhasePlaceholder"), "the last placeholder page shipped — the PhasePlaceholder component itself is retired");
  assert.ok(
    source.includes("openRunDetail(runId, \"reviews\", \"review\")"),
    "the reviews page's rows open the shared detail panel with the reviews opener and the review tab",
  );
  assert.ok(source.includes("reviews-body"), "the reviews page docks the detail panel like the runs page does");
  const panelSource = readFileSync(resolve("src/ui/webapp/run-detail-panel.tsx"), "utf8");
  assert.ok(panelSource.includes("initialTab"), "the panel accepts which tab to open");
  const stateSource = readFileSync(resolve("src/ui/webapp/run-detail-state.ts"), "utf8");
  assert.ok(stateSource.includes("RUN_DETAIL_TABS"), "the opener memory validates its tab against the panel's ONE tab vocabulary");
});
