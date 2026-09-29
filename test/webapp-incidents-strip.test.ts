import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentsView, BudgetIncidentRows } from "../src/ui/webapp/agents-view.js";
import { BoardView, WORKSPACE_STRIP_FRAMING, WorkspaceStrip } from "../src/ui/webapp/board-view.js";
import { postureBudgetIncidents } from "../src/ui/webapp/posture-strip.js";
import { operatorPosture } from "../src/integrations/operator-posture.js";
import type { BoardOutcome } from "../src/integrations/task-provider.js";
import type { GitStatus, GitWorktree, SessionMeta } from "../src/ui/webapp/app.js";

// W176 (issue #347, phase 3) — budget incident rows beside the AgentsView
// budget cards + the Board header's workspace strip. Red-first pins so the
// slice cannot silently fabricate state:
//   (a) incidents are sourced from the POSTURE POLL's records only — the
//       selector answers the posture block's rows verbatim and never
//       fabricates one from anything else (a fabricated incident fails);
//   (b) the empty record set renders the pinned empty copy;
//   (c) the strip's workspace-level framing element is present verbatim;
//   (d) the degraded git state names why.
// Focused-run discipline: node --import tsx --test test/webapp-incidents-strip.test.ts.
// (Template literals are deliberately absent: string concatenation keeps the
// source patchable under the guard shell classifier.)

const noop = (): void => {};

const INCIDENT_RECORDS = [
  { sessionId: "sess-1", title: "the loop", tier: "abort" as const, mechanism: "local guard", reason: "2x the cap" },
  { sessionId: "sess-2", tier: "warn" as const },
];

const RUN_TASKS = [{ runId: "author-1", title: "a run", state: "VERIFYING" }];

const healthyPosture = operatorPosture({
  runTasks: RUN_TASKS,
  reviewOutcomes: new Map(),
  blockingReasons: new Map(),
  budgetIncidents: INCIDENT_RECORDS,
});

// The REAL hub wire shape today: the hub composes no incident records, so the
// projection emits none — the selector must fabricate nothing from that.
const barePosture = operatorPosture({
  runTasks: RUN_TASKS,
  reviewOutcomes: new Map(),
  blockingReasons: new Map(),
});

test("W176: incidents come from the posture poll's records only — absent rows answer null, present rows answer verbatim", () => {
  assert.equal(postureBudgetIncidents(undefined), undefined, "the poll has not answered yet — no rows and no claim");
  assert.equal(postureBudgetIncidents({ posture: null, reason: "hub unavailable" }), null, "a degraded poll answers the named absence, never a fabricated row");
  assert.equal("budgetIncidents" in barePosture, false, "the projection emits no rows for data it was never given");
  assert.equal(postureBudgetIncidents({ posture: barePosture }), null, "a posture that carries no incident rows fabricates none — a fabricated incident fails here");
  assert.deepEqual(postureBudgetIncidents({ posture: healthyPosture }), INCIDENT_RECORDS, "the records ride verbatim — no reshaping");
});

test("W176: an incident row renders the record's fields verbatim; the empty record set renders the pinned copy", () => {
  const rows = renderToStaticMarkup(createElement(BudgetIncidentRows, { incidents: INCIDENT_RECORDS }));
  assert.ok(rows.includes("budget-incident-row"), "each record renders as a row");
  assert.ok(rows.includes("budget-incident-row-abort"), "the row carries the record's tier class");
  assert.ok(rows.includes("budget-incident-row-warn"), "both tiers render from their records");
  assert.ok(rows.includes("sess-1"), "the record's sessionId renders");
  assert.ok(rows.includes("the loop"), "the record's title renders");
  assert.ok(rows.includes("local guard"), "the record's mechanism renders");
  assert.ok(rows.includes("2x the cap"), "the record's reason renders");
  assert.ok(rows.includes("sess-2"), "a title-less record renders its sessionId verbatim");

  const empty = renderToStaticMarkup(createElement(BudgetIncidentRows, { incidents: [] }));
  assert.ok(empty.includes("no budget incidents recorded"), "the pinned empty copy");
  assert.ok(!empty.includes("budget-incident-row"), "an empty record set fabricates no rows");

  const absent = renderToStaticMarkup(createElement(BudgetIncidentRows, { incidents: null }));
  assert.ok(absent.includes("state unavailable"), "a poll that carries no records renders the named absence, never the empty claim");

  const loading = renderToStaticMarkup(createElement(BudgetIncidentRows, { incidents: undefined }));
  assert.ok(!loading.includes("Budget incidents"), "the poll has not answered — the panel renders nothing yet");
});

test("W176: the panel beside the cards sources only posture records — a card's recorded violation fabricates no row", () => {
  const session: SessionMeta = {
    id: "s1",
    title: "capped session",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    active: false,
    agent: "opencode",
    budget: { tier: "abort", mechanism: "local guard", violation: "budget exceeded: total tokens 101 > cap 100" },
  };
  const agentsView = (incidents: typeof INCIDENT_RECORDS | null | undefined): string =>
    renderToStaticMarkup(createElement(AgentsView, {
      sessions: [session],
      agents: [],
      onActivate: noop,
      onCreate: noop,
      onSwitchAgent: noop,
      onRename: noop,
      onDismiss: noop,
      onClearUnused: noop,
      onOpenChat: noop,
      onBudgetRaise: async () => undefined,
      ...(incidents === undefined ? {} : { budgetIncidents: incidents }),
    }));

  const cardOnly = agentsView(undefined);
  assert.ok(cardOnly.includes("session-budget-incident"), "the W151 card renders its recorded violation beside the bar");
  assert.ok(!cardOnly.includes("budget-incident-row"), "no posture records, no panel rows — the card's violation is NOT an incident row");

  const emptyRecords = agentsView([]);
  assert.ok(emptyRecords.includes("no budget incidents recorded"), "the empty record set says so beside the cards");
  assert.ok(!emptyRecords.includes("budget-incident-row"), "an empty posture record set fabricates no row even while a card shows a violation");

  const fromPosture = agentsView(INCIDENT_RECORDS);
  assert.ok(fromPosture.includes("budget-incident-row"), "rows render beside the cards only when the posture poll carried them");
});

const GIT: GitStatus = {
  branch: "feat/w176-incidents-strip",
  changes: [
    { path: "a.ts", status: "modified" },
    { path: "b.ts", status: "added" },
    { path: "c.ts", status: "untracked" },
  ],
};

const WORKTREES: readonly GitWorktree[] = [
  { path: "/repo", branch: "feat/w176-incidents-strip", bare: false, detached: false, current: true },
  { path: "/repo/.wave/w175", branch: null, bare: false, detached: true, current: false },
];

test("W176: the workspace strip renders the framing element and the polled workspace records verbatim", () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceStrip, { gitStatus: GIT, worktrees: WORKTREES }));
  assert.ok(markup.includes(WORKSPACE_STRIP_FRAMING), "the workspace-level framing rides the strip's title/hint element verbatim");
  assert.ok(markup.includes("workspace-level live state"), "the framing is visible as the strip's hint, not only an attribute");
  assert.ok(markup.includes("feat/w176-incidents-strip"), "the workspace branch renders from the polled git status");
  assert.ok(markup.includes("3 changed paths"), "the workspace changes summary renders from the polled git status");
  assert.ok(markup.includes("workspace-worktree"), "each worktree renders a row");
  assert.ok(markup.includes("current"), "the recorded current flag renders");
  assert.ok(markup.includes("detached HEAD"), "the recorded detached flag renders");
  assert.ok(markup.includes("/repo/.wave/w175"), "the worktree row carries its recorded path");
});

test("W176: the degraded workspace strip names why — git unavailable, never a fabricated workspace state", () => {
  const absent = renderToStaticMarkup(createElement(WorkspaceStrip, {}));
  assert.ok(absent.includes("git unavailable"), "the degraded strip names git unavailability");
  assert.ok(!absent.includes("workspace-worktree-branch"), "no fabricated worktree rows");

  const statusOnly = renderToStaticMarkup(createElement(WorkspaceStrip, { gitStatus: GIT }));
  assert.ok(statusOnly.includes("worktree list unavailable"), "a missing worktree record is named");
  const treesOnly = renderToStaticMarkup(createElement(WorkspaceStrip, { worktrees: WORKTREES }));
  assert.ok(treesOnly.includes("git status unavailable"), "a missing git status record is named");
});

const BOARD: BoardOutcome = {
  state: "ok",
  board: { provider: "github", repo: "ultus-net/Workflow", tasks: [], skipped: 0, pullRequestsExcluded: 0 },
};

test("W176: the strip rides the Board header — workspace state, not a per-run record", () => {
  const markup = renderToStaticMarkup(createElement(BoardView, {
    board: BOARD,
    gitStatus: GIT,
    worktrees: WORKTREES,
  }));
  assert.ok(markup.includes("workspace-strip"), "the strip renders on the board header");
  assert.ok(markup.includes(WORKSPACE_STRIP_FRAMING), "the framing rides the header strip");
  assert.ok(markup.includes("board-columns"), "the board columns still render");
});