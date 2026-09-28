import assert from "node:assert/strict";
import { test } from "node:test";

import { BoardView } from "../src/ui/webapp/board-view.js";
import type { BoardOutcome, ExternalTask } from "../src/integrations/task-provider.js";
import type { IssueViewState, IssueViewStorage } from "../src/ui/webapp/issue-view-state.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// PR #334 review residuals (the fresh-eyes five-axis P3s), pinned in a new
// file so no existing pin moves:
//   (a) app.tsx read the persisted board IssueViewState and saved it through
//       window.localStorage UNGUARDED — a storage-denied or at-quota context
//       threw synchronously in the shell render/update path. The honest
//       behavior mirrors the file's own readLastUsed/writeLastUsed
//       precedent: the read degrades to the module's own default, the save
//       no-ops, nothing throws. The throwing storage below is the exact
//       denied/quota context — every access rejects.
//   (b) (guard) the done/cancelled column filters now exclude the
//       in_progress keys like open/closed already did. Unreachable today —
//       the join emits only open cards — pinned so the asymmetry cannot
//       become a live bug.
// Focused-run discipline: node --import tsx --test test/board-shell-storage.test.ts.
// (Template literals are deliberately absent: string concatenation keeps the
// source patchable under the guard shell classifier.)

const throwingStorage: IssueViewStorage = {
  getItem: () => {
    throw new Error("storage denied");
  },
  setItem: () => {
    throw new Error("quota exceeded");
  },
};

const noop = (): void => {};

const card = (key: string, state: "open" | "closed", overrides: Partial<ExternalTask> = {}): ExternalTask => ({
  provider: "github",
  key,
  title: "Issue " + key.slice(1),
  state,
  url: "https://github.com/o/r/issues/" + key.slice(1),
  labels: [],
  updatedAt: "2026-09-28T00:00:00Z",
  ...overrides,
});

test("review #334 residual (a): a storage that throws yields the honest defaults on read and no-ops the save — never a thrown error", async () => {
  const { readIssueViewStateGuarded, saveIssueViewStateGuarded } = await import("../src/ui/webapp/issue-view-state.js");
  assert.deepEqual(
    readIssueViewStateGuarded(throwingStorage),
    {},
    "the honest default — the same empty state the absent-key and corrupt-read paths return",
  );
  assert.doesNotThrow(
    () => saveIssueViewStateGuarded(throwingStorage, { open: { pageSize: 5, density: "compact" } }),
    "a refused save no-ops — the shell's update path never throws",
  );
  const backing = new Map<string, string>();
  const working: IssueViewStorage = {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => void backing.set(key, value),
  };
  saveIssueViewStateGuarded(working, { open: { pageSize: 5 } });
  assert.deepEqual(
    readIssueViewStateGuarded(working),
    { open: { pageSize: 5 } } satisfies IssueViewState,
    "a healthy storage still round-trips through the guarded pair — the unguarded contract is preserved",
  );
});

test("review #334 residual (a): the shell render path survives a storage that throws on access — the board renders on the honest defaults", async () => {
  // Dynamic import AFTER the stub: static imports hoist above the window
  // assignment, and app.tsx must observe the throwing localStorage.
  const { AppShell } = await import("../src/ui/webapp/app.js");
  const previousWindow = globalThis.window;
  globalThis.window = { localStorage: throwingStorage } as unknown as typeof globalThis.window;
  try {
    let markup = "";
    assert.doesNotThrow(() => {
      markup = renderToStaticMarkup(createElement(AppShell, {
        view: "board",
        setView: noop,
        focusedSessionId: undefined,
        setFocusedSessionId: noop,
      }));
    }, "a storage-denied context must not crash the shell render");
    assert.ok(markup.includes(">Workflow</h1>"), "the shell chrome still renders");
    assert.ok(markup.includes("the board has not answered yet"), "the board lane renders its honest not-yet-answered note");
  } finally {
    globalThis.window = previousWindow;
  }
});

test("review #334 residual (b) (guard): the done and cancelled columns exclude the in_progress keys like open/closed do — a card claimed by the hub's payload renders once", () => {
  const board: BoardOutcome = {
    state: "ok",
    board: {
      provider: "github",
      repo: "o/r",
      tasks: [
        card("#1", "open"),
        card("#2", "closed", { stateReason: "completed" }),
        card("#3", "closed", { stateReason: "not_planned" }),
      ],
      skipped: 0,
      pullRequestsExcluded: 0,
    },
  };
  // A hypothetical hub payload naming CLOSED cards' keys. Unreachable today —
  // the join emits only open cards — pinned so the asymmetry cannot become a
  // live bug.
  const markup = renderToStaticMarkup(createElement(BoardView, { board, inProgress: ["#2", "#3"] }));
  assert.ok(!markup.includes("done ("), "the completed card is excluded from done by the in_progress exclusion");
  assert.ok(!markup.includes("cancelled ("), "the not_planned card is excluded from cancelled by the in_progress exclusion");
  assert.equal(markup.split("Issue 2").length - 1, 1, "the completed card renders once — in the in_progress column only");
  assert.equal(markup.split("Issue 3").length - 1, 1, "the not_planned card renders once — in the in_progress column only");
  assert.ok(markup.includes("in_progress (2)"), "the hub payload column renders both claimed cards");
  assert.ok(markup.includes("open (1)"), "the open column is untouched");
});
