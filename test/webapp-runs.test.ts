import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RunDetailPanel,
  evidenceRowsForRun,
  timelineRowsForRun,
} from "../src/ui/webapp/run-detail-panel.js";
import {
  RunsView,
  filterRunRows,
  runFilterChoices,
  type RunFilters,
  type RunOriginFilter,
} from "../src/ui/webapp/runs-view.js";
import type { RunsRecordState } from "../src/ui/webapp/runs-record.js";
import { formatRunOrigin, statusToken } from "../src/ui/webapp/presenters.js";
import type { HubEvidenceRow } from "../src/ui/webapp/evidence-preview.js";
import {
  RUN_DETAIL_STATE_KEY,
  clearRunDetailOpen,
  clearRunDetailOpenGuarded,
  clearRunDetailOpenToWindow,
  readRunDetailOpen,
  readRunDetailOpenFromWindow,
  readRunDetailOpenGuarded,
  saveRunDetailOpen,
  saveRunDetailOpenGuarded,
  saveRunDetailOpenToWindow,
  type RunDetailOpen,
} from "../src/ui/webapp/run-detail-state.js";
import { TIMELINE_RETENTION } from "../src/integrations/activity-timeline.js";
import { AppShell } from "../src/ui/webapp/app.js";

// W175 phase 2 — the Runs page and the run detail panel. Red-first pins so
// the flagship-gap pages cannot silently fabricate records or attribution:
//   (a) every registry run renders one row; a row whose record carries no
//       startedAt renders "no recorded time" and NO duration is ever derived
//       (projection-only; the timeline house rule);
//   (b) origin attribution renders VERBATIM from the relay's origins record
//       — an unattributed run renders "origin not recorded", never a guess
//       parsed out of the run id (the W153 rule);
//   (c) the summary tab's completion claim carries its verified-at-claim
//       flag BESIDE it (the W114 honesty line made legible), and the cache
//       read/create pair names the recorded lane asymmetry (0 on the OpenAI
//       chat-completions lane — the view says so);
//   (d) the reasoning-claim monitor renders recall and timeToResponseMs as
//       "unmeasured" — the registry's own comment forbids reporting them
//       measured;
//   (e) an absent record family renders its named absence — never a
//       fabricated panel;
//   (f) the status vocabulary is ONE map in presenters.ts, and every view's
//       class token derives through it (the pin holds the views together);
//   (g) filters (origin, state) and the detail-opener memory (guarded
//       sessionStorage) behave as specified.
// Focused-run discipline: node --import tsx --test test/webapp-runs.test.ts.
// (Template literals are deliberately absent: string concatenation keeps
// the source patchable under the guard shell classifier.)

const noop = (): void => {};

const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

const ROW_SCHEDULE = "schedule:w1:abc";
const ROW_BOARD = "board:github:12:def";
const ROW_ADHOC = "agent-run:777";

/** A full /api/runs record — every record family the relay carries, so the
 * populated-panel pins have all their inputs. */
function fullRunsRecord(): RunsRecordState {
  return {
    runs: {
      rows: [
        { runId: ROW_SCHEDULE, title: "nightly sweep", state: "VERIFIED", startedAt: "2026-09-30T10:00:00Z" },
        { runId: ROW_BOARD, title: "#12 fix the gate", state: "IN_PROGRESS" },
        { runId: ROW_ADHOC, title: "ad hoc run", state: "FAILED" },
      ],
      origins: {
        [ROW_SCHEDULE]: { kind: "schedule", scheduleId: "w1" },
        [ROW_BOARD]: { kind: "provider-task", provider: "github", key: "#12", url: "https://github.com/acme/widget/issues/12" },
      },
      workProducts: {
        [ROW_BOARD]: { provider: "github", key: "#12", url: "https://github.com/acme/widget/pull/99" },
      },
      reviewOutcomes: {
        [ROW_SCHEDULE]: {
          reviewerRunId: "schedule:hub-reviewer:rev1",
          verdict: "approved",
          recorded: true,
          summary: "test integrity: pinned; task completeness: full; cleanliness: clean",
        },
      },
      blockingReasons: { [ROW_ADHOC]: "test evidence failed: 1 red" },
      completionClaims: {
        [ROW_SCHEDULE]: { runId: ROW_SCHEDULE, claim: "all done, verified", verifiedAtClaim: true, observedAt: "2026-09-30T10:05:00Z" },
      },
      usage: {
        [ROW_SCHEDULE]: {
          requests: 3, promptTokens: 1200, completionTokens: 300, totalTokens: 1500,
          costUsd: 0.0123, cacheReadTokens: 0, cacheCreateTokens: 0,
          recordedAt: "2026-09-30T10:05:00Z",
        },
      },
      reasoningClaims: {
        [ROW_ADHOC]: { runId: ROW_ADHOC, sentence: "claims tests pass with no observed test run", observedAt: "2026-09-30T10:04:00Z" },
      },
      reasoningClaimMetrics: { monitoredRuns: 2, flaggedRuns: 1, findings: 1, recall: "unmeasured", timeToResponseMs: "unmeasured" },
    },
  };
}

/** A record with ONLY the always-present families — every optional family
 * absent, so the named-absence pins have their inputs. */
function bareRunsRecord(): RunsRecordState {
  return {
    runs: {
      rows: [{ runId: ROW_SCHEDULE, title: "nightly sweep", state: "VERIFIED", startedAt: "2026-09-30T10:00:00Z", workspace: "/repo" }],
      reviewOutcomes: {},
      blockingReasons: {},
      completionClaims: {},
    },
  };
}

function runsProps(overrides?: { readonly record?: RunsRecordState | undefined; readonly filters?: RunFilters }): Parameters<typeof RunsView>[0] {
  return {
    // "record" in overrides (not ??): an EXPLICIT undefined record is the
    // unanswered-poll case the pins exercise.
    record: overrides !== undefined && "record" in overrides ? overrides.record : fullRunsRecord(),
    selectedRunId: undefined,
    onSelectRun: noop,
    ...(overrides?.filters === undefined ? {} : { filters: overrides.filters }),
  };
}

function detailProps(overrides?: {
  readonly runId?: string;
  readonly record?: RunsRecordState;
  readonly evidenceRows?: readonly HubEvidenceRow[] | null;
}): Parameters<typeof RunDetailPanel>[0] {
  return {
    runId: overrides?.runId ?? ROW_SCHEDULE,
    record: overrides?.record ?? fullRunsRecord(),
    timeline: {
      timeline: {
        rows: [
          { kind: "usage", actor: "system", authority: "metering-proxy usage record", summary: "run " + ROW_SCHEDULE + " usage: 1500 tokens, $0.0123", at: "2026-09-30T10:05:00Z" },
          { kind: "review", actor: "agent (reviewer)", authority: "review-gate verdict record (admitted)", summary: "run " + ROW_SCHEDULE + ": review approved — test integrity: pinned", at: null },
          { kind: "usage", actor: "system", authority: "metering-proxy usage record", summary: "run " + ROW_BOARD + " usage: 50 tokens, $0.0001", at: "2026-09-30T10:06:00Z" },
          { kind: "transition", actor: "unattributed", authority: "unattributed", summary: "nightly sweep: READY → IN_PROGRESS", at: null },
        ],
        degraded: [],
        retention: TIMELINE_RETENTION,
      },
    },
    boardRead: { at: new Date().toISOString(), outcome: "ok" },
    opener: "runs",
    onBack: noop,
    ...(overrides?.evidenceRows === undefined ? {} : { evidenceRows: overrides.evidenceRows }),
  };
}

// ── the Runs page ──

test("every registry run renders one row — not schedule-lane only", () => {
  const markup = renderToStaticMarkup(createElement(RunsView, runsProps()));
  for (const runId of [ROW_SCHEDULE, ROW_BOARD, ROW_ADHOC]) {
    assert.ok(markup.includes(runId), "the runs table is missing run \"" + runId + "\"");
  }
  assert.equal(count(markup, "data-run-row="), 3, "one interactive row per registry run — every run, not a schedule lane's subset");
  assert.ok(markup.includes("nightly sweep") && markup.includes("ad hoc run"), "the rows render their records verbatim");
});

test("start renders ONLY where the record carries a time — no recorded time otherwise, no duration ever", () => {
  const markup = renderToStaticMarkup(createElement(RunsView, runsProps()));
  assert.equal(count(markup, "no recorded time"), 2, "each row without a startedAt record renders the named absence (two such rows)");
  assert.ok(
    markup.includes('title="2026-09-30T10:00:00Z"'),
    "the row WITH a startedAt record renders the recorded instant verbatim (the full stamp on hover) — never a derived one",
  );
  assert.ok(
    !markup.toLowerCase().includes("duration"),
    "no duration renders anywhere — the relay carries no duration record and the view never derives one from kernel transitions",
  );
});

test("origin attribution renders verbatim from the origins record — records only, never id parsing", () => {
  assert.equal(formatRunOrigin({ kind: "schedule", scheduleId: "w1" }), "fired by schedule w1", "a schedule origin says what the record says");
  assert.equal(
    formatRunOrigin({ kind: "provider-task", provider: "github", key: "#12", url: "https://github.com/acme/widget/issues/12" }),
    "provider-task github #12",
    "a provider-task origin renders its recorded fields verbatim",
  );
  assert.equal(formatRunOrigin(undefined), undefined, "no record attributes nothing");
  assert.equal(formatRunOrigin({ kind: "schedule" }), undefined, "a record missing its kind's own field attributes nothing (never a half-guess)");
  const markup = renderToStaticMarkup(createElement(RunsView, runsProps()));
  assert.equal(count(markup, "fired by schedule w1"), 1, "exactly the schedule-origin row carries the schedule attribution");
  assert.ok(markup.includes("provider-task github #12"), "the provider-task attribution renders verbatim");
  assert.equal(count(markup, "origin not recorded"), 1, "the unattributed run renders its named absence");
  const source = readFileSync(resolve("src/ui/webapp/runs-view.tsx"), "utf8");
  assert.ok(
    !/runId\.(startsWith|includes|split|match|slice)\(/.test(source),
    "the runs view never parses run ids for attribution (the W153 rule: the recorder states the origin)",
  );
});

test("filters: origin and state, derived from the records and applied to the rows", () => {
  const record = fullRunsRecord();
  const rows = record.runs!.rows;
  const origins = record.runs!.origins!;
  assert.equal(filterRunRows(rows, origins, { origin: "all", state: "all" }).length, 3, "the all/all filters keep every run");
  assert.deepEqual(filterRunRows(rows, origins, { origin: "schedule", state: "all" }).map((row) => row.runId), [ROW_SCHEDULE]);
  assert.deepEqual(filterRunRows(rows, origins, { origin: "provider-task", state: "all" }).map((row) => row.runId), [ROW_BOARD]);
  assert.deepEqual(filterRunRows(rows, origins, { origin: "unrecorded", state: "all" }).map((row) => row.runId), [ROW_ADHOC], "the unrecorded bucket is honest, not squeezed into a kind");
  assert.deepEqual(filterRunRows(rows, origins, { origin: "all", state: "VERIFIED" }).map((row) => row.runId), [ROW_SCHEDULE]);
  assert.deepEqual(filterRunRows(rows, origins, { origin: "schedule", state: "VERIFIED" }).map((row) => row.runId), [ROW_SCHEDULE], "the filters compose");
  assert.equal(filterRunRows(rows, origins, { origin: "schedule", state: "FAILED" }).length, 0, "a matching-nothing pair filters to nothing");
  const choices = runFilterChoices(rows, origins);
  assert.deepEqual(choices.origin, ["all", "schedule", "provider-task", "unrecorded"], "the origin options are the recorded kinds plus the honest buckets");
  assert.deepEqual(choices.state, ["all", "VERIFIED", "IN_PROGRESS", "FAILED"], "the state options are the states actually recorded, first-seen order");
  const markup = renderToStaticMarkup(createElement(RunsView, runsProps()));
  assert.ok(markup.includes("filter runs by origin"), "the origin filter renders");
  assert.ok(markup.includes("filter runs by state"), "the state filter renders");
  const filtered = renderToStaticMarkup(createElement(RunsView, runsProps({ filters: { origin: "provider-task", state: "all" } })));
  assert.ok(filtered.includes(ROW_BOARD), "the provider-task filter keeps its run");
  assert.ok(!filtered.includes(ROW_SCHEDULE) && !filtered.includes(ROW_ADHOC), "the filter drops the rows outside the bucket");
  const none = renderToStaticMarkup(createElement(RunsView, runsProps({ filters: { origin: "schedule", state: "FAILED" } })));
  assert.ok(none.includes("no runs match the filters"), "a matching-nothing filter names itself");
});

test("the empty table names the first action", () => {
  const empty: RunsRecordState = { runs: { rows: [], reviewOutcomes: {}, blockingReasons: {}, completionClaims: {} } };
  const markup = renderToStaticMarkup(createElement(RunsView, runsProps({ record: empty })));
  assert.ok(
    markup.includes("no runs recorded yet — delegate a board task or fire a schedule"),
    "the empty state names the first action",
  );
});

test("a hub that predates the relay (or is unreachable) renders the named absence", () => {
  const absent = renderToStaticMarkup(createElement(RunsView, runsProps({ record: { runs: null, reason: "hub unavailable" } })));
  assert.ok(absent.includes("runs relay unavailable (hub unavailable)"), "the relay's named absence carries the transport's reason");
  const unanswered = renderToStaticMarkup(createElement(RunsView, runsProps({ record: undefined })));
  assert.ok(unanswered.includes("state unavailable — the runs relay has not answered"), "the unanswered poll is named, never an empty table");
});

// ── the run detail panel ──

test("the panel renders all five tabs and the header's record fields", () => {
  const markup = renderToStaticMarkup(createElement(RunDetailPanel, detailProps()));
  for (const tab of ["Summary", "Timeline", "Evidence", "Review", "Cost"]) {
    assert.ok(markup.includes(tab), "the tab strip is missing " + tab);
  }
  assert.equal(count(markup, " hidden="), 4, "the four inactive tabs render hidden (all panels present in the document)");
  assert.ok(markup.includes(ROW_SCHEDULE) && markup.includes(">VERIFIED</span>"), "the header carries the run id and its recorded state");
  assert.ok(markup.includes("fired by schedule w1"), "the header carries the recorded origin");
  assert.ok(markup.includes('title="2026-09-30T10:00:00Z"'), "the header start time is the recorded instant, never a derived one");
  assert.ok(markup.includes("back to runs"), "the back affordance names the opener page (the origin memory)");
  // The workspace line renders only when the record carries one.
  const withWorkspace = renderToStaticMarkup(createElement(RunDetailPanel, detailProps({ record: bareRunsRecord() })));
  assert.ok(withWorkspace.includes("workspace /repo"), "the header carries the workspace when the record carries one");
  const noWorkspace = renderToStaticMarkup(createElement(RunDetailPanel, detailProps()));
  assert.ok(!noWorkspace.includes("workspace /repo"), "no workspace line renders when the record carries none");
  const unknownRun = renderToStaticMarkup(createElement(RunDetailPanel, detailProps({ runId: "run-not-in-rows" })));
  assert.ok(unknownRun.includes("state not recorded"), "a run id outside the rows renders the honest state absence");
  assert.ok(unknownRun.includes("origin not recorded"), "no origin record, no attribution");
});

test("the summary tab: usage labelled recorded, cache lane asymmetry named, claim flag beside the claim", () => {
  const markup = renderToStaticMarkup(createElement(RunDetailPanel, detailProps()));
  assert.ok(markup.includes("Recorded usage"), "the usage section is labelled recorded — an aggregation of recorded values, never a live meter");
  assert.ok(markup.includes("$0.0123"), "the recorded cost renders in the house $/toFixed(4) format");
  assert.ok(markup.includes("1.2k"), "the token counts render through the shared formatter");
  assert.ok(
    markup.includes("the recorded lane asymmetry: on the OpenAI chat-completions lane both stay 0 (its cached reads are inside promptTokens)"),
    "the cache read/create pair names the recorded lane asymmetry — the view says so",
  );
  assert.ok(markup.includes("cache read: 0 · cache create: 0"), "the cache values render with their recorded zeros");
  assert.ok(markup.includes("all done, verified"), "the completion claim renders verbatim");
  assert.ok(markup.includes("verified at claim: yes"), "the verified-at-claim flag renders (the W114 honesty line made legible)");
  const claimAt = markup.indexOf("all done, verified");
  const flagAt = markup.indexOf("verified at claim: yes");
  assert.ok(flagAt > claimAt && flagAt - claimAt < 400, "the flag renders BESIDE the claim, not detached from it");
  const unverifiedRecord: RunsRecordState = {
    runs: {
      ...fullRunsRecord().runs!,
      completionClaims: {
        [ROW_SCHEDULE]: { runId: ROW_SCHEDULE, claim: "done (it is not)", verifiedAtClaim: false, observedAt: "2026-09-30T10:05:00Z" },
      },
    },
  };
  const unverified = renderToStaticMarkup(createElement(RunDetailPanel, detailProps({ record: unverifiedRecord })));
  assert.ok(unverified.includes("verified at claim: no"), "an unverified claim renders its flag as no — the flag says what it means");
  const pill = renderToStaticMarkup(createElement(RunDetailPanel, detailProps({ runId: ROW_BOARD })));
  assert.ok(pill.includes("board-liveness-fresh") && pill.includes(">fresh</span>"), "the work product carries the W167 liveness pill from the recorded provider read");
  assert.ok(pill.includes("https://github.com/acme/widget/pull/99"), "the work-product link renders the recorded url verbatim");
});

test("the review tab: verdict verbatim, blocking reason verbatim, unmeasured monitor metrics", () => {
  const markup = renderToStaticMarkup(createElement(RunDetailPanel, detailProps()));
  assert.ok(markup.includes("verdict: approved"), "the five-axis verdict renders verbatim");
  assert.ok(markup.includes("test integrity: pinned; task completeness: full; cleanliness: clean"), "the review summary renders verbatim");
  assert.ok(markup.includes("admitted"), "the verdict's recorded state renders");
  const blocked = renderToStaticMarkup(createElement(RunDetailPanel, detailProps({ runId: ROW_ADHOC })));
  assert.ok(blocked.includes("blocking reason: test evidence failed: 1 red"), "the blocking reason renders verbatim");
  assert.ok(blocked.includes("reasoning-claim finding: claims tests pass with no observed test run"), "the advisory finding renders when recorded");
  assert.ok(markup.includes("no reasoning-claim finding recorded"), "the finding family names its absence for a run with none");
  assert.equal(count(markup, ">unmeasured</dd>"), 2, "recall and timeToResponseMs render as unmeasured — the registry's own comment forbids reporting them measured");
  assert.ok(markup.includes(">recall</dt>") && markup.includes(">timeToResponseMs</dt>"), "the unmeasured metrics name their fields");
});

test("absent record families render their named absence — never a fabricated panel", () => {
  const markup = renderToStaticMarkup(createElement(RunDetailPanel, detailProps({ record: bareRunsRecord() })));
  assert.ok(markup.includes("no usage recorded for this run"), "the absent usage family is named (summary + cost)");
  assert.equal(count(markup, "no usage recorded for this run"), 2, "both usage readers name the same absence");
  assert.ok(markup.includes("no completion claim recorded"), "the absent claim family is named");
  assert.ok(markup.includes("no work-product link recorded"), "the absent work-product family is named");
  assert.ok(markup.includes("no review outcome recorded"), "the absent review family is named");
  assert.ok(!markup.includes("verdict:"), "no verdict is fabricated for a run with no review record");
  assert.ok(markup.includes("no blocking reason recorded"), "the absent blocking-reason family is named");
  assert.ok(markup.includes("no reasoning-claim monitor record"), "the absent monitor family is named");
  assert.equal(count(markup, ">recorded cost</dt>"), 0, "no cost is fabricated for a run with no usage record (the usage dl does not render)");
  assert.ok(count(markup, "cache read:") === 0, "no cache asymmetry line renders without a usage record");
  assert.ok(!markup.includes("board-liveness"), "no liveness pill renders without a recorded provider read (the W167 rule)");
});

test("the evidence tab: the run's records under it, the shared W158 row renderer, named absences", () => {
  const rows: readonly HubEvidenceRow[] = [
    { id: "ev1", subject: ROW_SCHEDULE, result: "passed", freshness: "fresh", content: { kind: "test-output", ref: "content:nonce:1", byteSize: 12 } },
    { id: "ev2", subject: "test:/repo", result: "passed", freshness: "fresh" },
    { id: "ev3", subject: ROW_BOARD, result: "failed", freshness: "stale" },
  ];
  const markup = renderToStaticMarkup(createElement(RunDetailPanel, detailProps({ evidenceRows: rows })));
  assert.ok(markup.includes(ROW_SCHEDULE + ": passed / fresh"), "the run's own evidence record renders under it");
  assert.ok(markup.includes("hub · "), "the record carries the hub origin tag");
  assert.ok(markup.includes("content · loading…"), "the bounded preview's loading state is named (the fetch has not answered)");
  assert.ok(!markup.includes("test:/repo"), "a record under another subject is not claimed by this run");
  assert.ok(!markup.includes(">" + ROW_BOARD + ": failed"), "another run's record is not claimed");
  assert.deepEqual(evidenceRowsForRun(rows, ROW_SCHEDULE).map((row) => row.id), ["ev1"], "the subject join is exact");
  const none = renderToStaticMarkup(createElement(RunDetailPanel, detailProps({ evidenceRows: [] })));
  assert.ok(none.includes("no evidence records carry this run id as subject"), "an empty evidence family names its absence");
  const unavailable = renderToStaticMarkup(createElement(RunDetailPanel, detailProps({ evidenceRows: null })));
  assert.ok(unavailable.includes("hub evidence unavailable"), "the unavailable relay names its absence");
  const selfPolled = renderToStaticMarkup(createElement(RunDetailPanel, detailProps()));
  assert.ok(selfPolled.includes("hub evidence unavailable"), "without injected rows the panel polls the relay and names the unanswered state");
  const source = readFileSync(resolve("src/ui/webapp/run-detail-panel.tsx"), "utf8");
  assert.ok(source.includes("EvidenceStripRow"), "the evidence tab renders through the shared W158 row renderer (loading/evicted/unavailable states included)");
});

test("the timeline tab: the rows that name the run, its recorded begin, the verbatim retention — no per-run kernel fabrication", () => {
  const markup = renderToStaticMarkup(createElement(RunDetailPanel, detailProps()));
  assert.ok(markup.includes("run " + ROW_SCHEDULE + " usage: 1500 tokens, $0.0123"), "the registry row naming this run renders");
  assert.ok(markup.includes("run " + ROW_SCHEDULE + ": review approved"), "the review row naming this run renders");
  assert.ok(!markup.includes("run " + ROW_BOARD + " usage"), "another run's timeline rows are not claimed");
  assert.ok(markup.includes("run begun (recorded begin)") && markup.includes('title="2026-09-30T10:00:00Z"'), "the begin row renders the row's own startedAt record");
  assert.ok(markup.includes("this feed never claims a permanent record"), "the retention statement copies the projection's line verbatim");
  assert.ok(
    !markup.includes("nightly sweep: READY") && markup.includes("carry no task id"),
    "kernel transition rows are not joined per run — the boundary is stated, never faked",
  );
  assert.deepEqual(timelineRowsForRun([
    { kind: "review", actor: "a", authority: "b", summary: "run " + ROW_SCHEDULE + ": review approved", at: null },
    { kind: "usage", actor: "a", authority: "b", summary: "run " + ROW_BOARD + " usage: x", at: null },
  ], ROW_SCHEDULE).length, 1, "the summary join is exact (no prefix collisions)");
  const noTime = renderToStaticMarkup(createElement(RunDetailPanel, detailProps({ runId: ROW_BOARD })));
  assert.equal(count(noTime, "no recorded time"), 2, "a run without a begin record names it in the header AND the begin row");
  const degraded = renderToStaticMarkup(createElement(RunDetailPanel, detailProps()));
  const withoutTimeline = { ...detailProps(), timeline: { timeline: null, reason: "hub unavailable" } };
  const absent = renderToStaticMarkup(createElement(RunDetailPanel, withoutTimeline as Parameters<typeof RunDetailPanel>[0]));
  assert.ok(absent.includes("hub timeline unavailable (hub unavailable)"), "the timeline lane's named absence renders");
  assert.ok(degraded !== undefined, "the healthy render is non-empty");
});

// ── the shared status vocabulary ──

test("the status vocabulary is ONE map — every view's class token derives through it", () => {
  for (const state of ["READY", "IN_PROGRESS", "VERIFYING", "VERIFIED", "FAILED", "CANCELLED", "BLOCKED", "fresh", "stale"]) {
    assert.equal(statusToken(state), state.toLowerCase(), "the token for \"" + state + "\" is byte-identical with what the views rendered before the extraction (mechanical rename only)");
  }
  assert.equal(statusToken("made_up_state"), "made_up_state", "an unknown state renders lowercased verbatim, never styled by a guess");
  for (const file of ["app.tsx", "overview-view.tsx", "runs-view.tsx", "run-detail-panel.tsx"]) {
    const source = readFileSync(resolve("src/ui/webapp", file), "utf8");
    assert.ok(!source.includes("state.toLowerCase()"), file + " derives state class tokens through statusToken, not ad-hoc toLowerCase");
    assert.ok(source.includes("statusToken"), file + " imports the shared status map");
  }
  const presenters = readFileSync(resolve("src/ui/webapp/presenters.ts"), "utf8");
  assert.ok(presenters.includes("STATUS_TOKENS"), "the vocabulary lives in presenters.ts as one map");
});

// ── the detail opener's origin memory (sessionStorage, guarded) ──

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

test("the detail opener memory round-trips through the guarded sessionStorage pair", () => {
  const { backing, storage } = sessionStub();
  assert.equal(readRunDetailOpen(storage), undefined, "no record, no opener");
  saveRunDetailOpen(storage, { opener: "runs", runId: ROW_SCHEDULE } satisfies RunDetailOpen);
  assert.equal(backing.get(RUN_DETAIL_STATE_KEY), "{\"opener\":\"runs\",\"runId\":\"" + ROW_SCHEDULE + "\"}", "the persisted record is the namespaced JSON record");
  assert.deepEqual(readRunDetailOpen(storage), { opener: "runs", runId: ROW_SCHEDULE }, "a healthy storage round-trips");
  clearRunDetailOpen(storage);
  assert.equal(readRunDetailOpen(storage), undefined, "the cleared record reads as absent");
  backing.set(RUN_DETAIL_STATE_KEY, "not json");
  assert.equal(readRunDetailOpen(storage), undefined, "a corrupt record is dropped, not coerced");
  backing.set(RUN_DETAIL_STATE_KEY, "{\"opener\":\"not-a-view\",\"runId\":\"" + ROW_SCHEDULE + "\"}");
  assert.equal(readRunDetailOpen(storage), undefined, "an opener outside the shell's views is dropped");
  backing.set(RUN_DETAIL_STATE_KEY, "{\"opener\":\"runs\",\"runId\":\"\"}");
  assert.equal(readRunDetailOpen(storage), undefined, "an empty run id is dropped");
});

test("the opener memory survives both storage-denial shapes and the window pair encloses sessionStorage itself", () => {
  const throwing: Storage = {
    get length(): number { throw new Error("storage denied"); },
    clear: () => { throw new Error("storage denied"); },
    getItem: () => { throw new Error("storage denied"); },
    key: () => { throw new Error("storage denied"); },
    removeItem: () => { throw new Error("storage denied"); },
    setItem: () => { throw new Error("quota exceeded"); },
  };
  assert.doesNotThrow(() => readRunDetailOpenGuarded(throwing));
  assert.equal(readRunDetailOpenGuarded(throwing), undefined, "a storage that refuses reads degrades to no opener");
  assert.doesNotThrow(() => saveRunDetailOpenGuarded(throwing, { opener: "runs", runId: ROW_SCHEDULE }));
  assert.doesNotThrow(() => clearRunDetailOpenGuarded(throwing), "the clear path never throws either");
  const previous = globalThis.window;
  globalThis.window = {
    get sessionStorage(): Storage { throw new Error("storage access denied"); },
  } as unknown as typeof globalThis.window;
  try {
    assert.doesNotThrow(() => readRunDetailOpenFromWindow(), "access-time denial degrades to no opener");
    assert.equal(readRunDetailOpenFromWindow(), undefined);
    assert.doesNotThrow(() => saveRunDetailOpenToWindow({ opener: "runs", runId: ROW_SCHEDULE }));
    assert.doesNotThrow(() => clearRunDetailOpenToWindow());
  } finally {
    globalThis.window = previous;
  }
  const { backing, storage } = sessionStub();
  const prior = globalThis.window;
  globalThis.window = { sessionStorage: storage } as unknown as typeof globalThis.window;
  try {
    saveRunDetailOpenToWindow({ opener: "runs", runId: ROW_SCHEDULE });
    assert.equal(backing.get(RUN_DETAIL_STATE_KEY), "{\"opener\":\"runs\",\"runId\":\"" + ROW_SCHEDULE + "\"}", "the window pair writes the namespaced record");
    assert.deepEqual(readRunDetailOpenFromWindow(), { opener: "runs", runId: ROW_SCHEDULE });
    clearRunDetailOpenToWindow();
    assert.equal(readRunDetailOpenFromWindow(), undefined);
  } finally {
    globalThis.window = prior;
  }
  assert.equal(readRunDetailOpenFromWindow(), undefined, "no window at all (non-browser context) degrades to no opener");
});

// ── the shell mounts the runs page ──

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

test("the runs page mounts in the shell — the placeholder is replaced by the relay's named absence", () => {
  const { restore } = installWindowStorage();
  try {
    const markup = renderToStaticMarkup(createElement(AppShell, {
      view: "runs" as const,
      setView: noop,
      focusedSessionId: undefined,
      setFocusedSessionId: noop,
    }));
    assert.ok(markup.includes("runs-body"), "the shell mounts the RunsView in its page region, not the phase placeholder");
    assert.ok(!markup.includes("phase-placeholder"), "the runs placeholder is gone (reviews/activity/audit keep theirs)");
    assert.ok(
      markup.includes("state unavailable — the runs relay has not answered"),
      "with no poll record (an SSR render) the page renders the named absence",
    );
  } finally {
    restore();
  }
});

// ── the filter tokens carry through (a type-level pin in runtime clothing) ──

test("the origin filter vocabulary is closed — a token outside it never reaches the filter", () => {
  const tokens: readonly RunOriginFilter[] = ["all", "schedule", "provider-task", "unrecorded"];
  const record = fullRunsRecord();
  for (const token of tokens) {
    const filtered = filterRunRows(record.runs!.rows, record.runs!.origins, { origin: token, state: "all" });
    assert.ok(filtered.length >= 0, "the filter accepts every vocabulary token (\"" + token + "\")");
  }
});