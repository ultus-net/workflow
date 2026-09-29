import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BoardCardDetailPanel, BoardView, type IssueDetailAnswer } from "../src/ui/webapp/board-view.js";
import {
  CARD_DETAIL_STATE_KEY,
  clearCardDetailOpen,
  clearCardDetailOpenGuarded,
  clearCardDetailOpenToWindow,
  readCardDetailOpen,
  readCardDetailOpenFromWindow,
  readCardDetailOpenGuarded,
  saveCardDetailOpen,
  saveCardDetailOpenGuarded,
  saveCardDetailOpenToWindow,
  type CardDetailOpen,
} from "../src/ui/webapp/run-detail-state.js";
import type { IssueDetailOutcome } from "../src/integrations/issue-detail.js";
import { AppShell } from "../src/ui/webapp/app.js";

// W176 phase 3 (#347) — the board card detail panel: the board card's detail
// renders in the SHELL'S contextual panel (the same right-side region the
// W175 run detail uses) instead of the card's inline subregion, reusing the
// W167 issue-detail surface AS-IS (its internals are pinned by construction
// — test/issue-detail.test.ts stays green byte-unchanged). Red-first pins:
//   (a) the card opener's origin memory rides the SAME guarded module as the
//       run detail's (one guarded module, two record shapes): opened from
//       Board, back returns to Board; corrupt records are dropped, never
//       coerced, and BOTH storage-denial shapes degrade without throwing;
//   (b) the panel renders the W167 surface verbatim inside the region — the
//       provider's description/thread, the honest failure states, no
//       synthesis, no restyle;
//   (c) the card carries its opener identity (data-board-card) so focus can
//       return to the invoking card, and the card's inline detail subregion
//       is GONE — the W167 view renders only in the panel;
//   (d) the shell mounts the panel region for the stored opener record and
//       wires the opener, Esc, and the focus return through app.tsx.
// Focused-run discipline: node --import tsx --test test/webapp-card-panel.test.ts.
// (Template literals are deliberately absent: string concatenation keeps
// the source patchable under the guard shell classifier.)

const noop = (): void => {};

const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

const okDetail: IssueDetailOutcome = {
  state: "ok",
  detail: {
    provider: "github",
    key: "#12",
    title: "Fix the flaky test",
    description: "Step 1: repro\nStep 2: fix",
    comments: [
      { author: "hunter", body: "reproduced on 3.0.62", createdAt: "2026-09-27T10:00:00Z" },
    ],
    commentsSkipped: 2,
  },
};

function panelProps(overrides?: { readonly answer?: IssueDetailAnswer | undefined }): Parameters<typeof BoardCardDetailPanel>[0] {
  return {
    cardKey: "#12",
    opener: "board",
    onBack: noop,
    ...(overrides?.answer === undefined ? {} : { answer: overrides.answer }),
  };
}

const boardOutcome = {
  state: "ok",
  board: {
    provider: "github",
    repo: "o/r",
    tasks: [{
      provider: "github", key: "#12", title: "a task", state: "open",
      url: "https://github.com/o/r/issues/12", labels: [], updatedAt: "2026-09-27T00:00:00Z",
    }],
    skipped: 0,
    pullRequestsExcluded: 0,
  },
} as const;

// ── the card opener's origin memory (one guarded module, two record shapes) ──

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

test("the card detail opener memory round-trips through the guarded sessionStorage pair", () => {
  const { backing, storage } = sessionStub();
  assert.equal(readCardDetailOpen(storage), undefined, "no record, no opener");
  saveCardDetailOpen(storage, { opener: "board", cardKey: "#12" } satisfies CardDetailOpen);
  assert.equal(backing.get(CARD_DETAIL_STATE_KEY), "{\"opener\":\"board\",\"cardKey\":\"#12\"}", "the persisted record is the namespaced JSON record");
  assert.deepEqual(readCardDetailOpen(storage), { opener: "board", cardKey: "#12" }, "a healthy storage round-trips");
  clearCardDetailOpen(storage);
  assert.equal(readCardDetailOpen(storage), undefined, "the cleared record reads as absent");
  backing.set(CARD_DETAIL_STATE_KEY, "not json");
  assert.equal(readCardDetailOpen(storage), undefined, "a corrupt record is dropped, not coerced");
  backing.set(CARD_DETAIL_STATE_KEY, "{\"opener\":\"not-a-view\",\"cardKey\":\"#12\"}");
  assert.equal(readCardDetailOpen(storage), undefined, "an opener outside the shell's views is dropped");
  backing.set(CARD_DETAIL_STATE_KEY, "{\"opener\":\"board\",\"cardKey\":\"\"}");
  assert.equal(readCardDetailOpen(storage), undefined, "an empty card key is dropped");
  backing.set(CARD_DETAIL_STATE_KEY, "{\"opener\":\"board\",\"cardKey\":\"#12\",\"extra\":true}");
  assert.deepEqual(readCardDetailOpen(storage), { opener: "board", cardKey: "#12" }, "extra fields ride along harmlessly (the record reads its own shape)");
});

test("the card opener memory survives both storage-denial shapes and the window pair encloses sessionStorage itself", () => {
  const throwing: Storage = {
    get length(): number { throw new Error("storage denied"); },
    clear: () => { throw new Error("storage denied"); },
    getItem: () => { throw new Error("storage denied"); },
    key: () => { throw new Error("storage denied"); },
    removeItem: () => { throw new Error("storage denied"); },
    setItem: () => { throw new Error("quota exceeded"); },
  };
  assert.doesNotThrow(() => readCardDetailOpenGuarded(throwing));
  assert.equal(readCardDetailOpenGuarded(throwing), undefined, "a storage that refuses reads degrades to no opener");
  assert.doesNotThrow(() => saveCardDetailOpenGuarded(throwing, { opener: "board", cardKey: "#12" }));
  assert.doesNotThrow(() => clearCardDetailOpenGuarded(throwing), "the clear path never throws either");
  const previous = globalThis.window;
  globalThis.window = {
    get sessionStorage(): Storage { throw new Error("storage access denied"); },
  } as unknown as typeof globalThis.window;
  try {
    assert.doesNotThrow(() => readCardDetailOpenFromWindow(), "access-time denial degrades to no opener");
    assert.equal(readCardDetailOpenFromWindow(), undefined);
    assert.doesNotThrow(() => saveCardDetailOpenToWindow({ opener: "board", cardKey: "#12" }));
    assert.doesNotThrow(() => clearCardDetailOpenToWindow());
  } finally {
    globalThis.window = previous;
  }
  const { backing, storage } = sessionStub();
  const prior = globalThis.window;
  globalThis.window = { sessionStorage: storage } as unknown as typeof globalThis.window;
  try {
    saveCardDetailOpenToWindow({ opener: "board", cardKey: "#12" });
    assert.equal(backing.get(CARD_DETAIL_STATE_KEY), "{\"opener\":\"board\",\"cardKey\":\"#12\"}", "the window pair writes the namespaced record");
    assert.deepEqual(readCardDetailOpenFromWindow(), { opener: "board", cardKey: "#12" });
    clearCardDetailOpenToWindow();
    assert.equal(readCardDetailOpenFromWindow(), undefined);
  } finally {
    globalThis.window = prior;
  }
  assert.equal(readCardDetailOpenFromWindow(), undefined, "no window at all (non-browser context) degrades to no opener");
});

// ── the shell's contextual panel renders the W167 surface AS-IS ──

test("the panel renders the W167 issue-detail surface verbatim inside the region chrome", () => {
  const markup = renderToStaticMarkup(createElement(BoardCardDetailPanel, panelProps({ answer: { kind: "detail", outcome: okDetail } })));
  assert.ok(markup.includes("board card detail: #12"), "the region names the card it renders");
  assert.ok(markup.includes("back to board"), "the back affordance names the opener page (the origin memory)");
  assert.ok(markup.includes("close the detail (Esc); back to board"), "the back affordance states Esc and the return page");
  // The W167 surface renders UNCHANGED inside: its own root class and copy.
  assert.ok(markup.includes("board-issue-detail"), "the W167 surface's own root renders (same class as before the re-home)");
  assert.ok(markup.includes("Step 1: repro") && markup.includes("Step 2: fix"), "the provider's description renders verbatim");
  assert.ok(markup.includes("@hunter") && markup.includes("reproduced on 3.0.62") && markup.includes("2026-09-27"), "the thread renders the provider's author, body, and date verbatim");
  assert.ok(markup.includes("2 provider rows skipped"), "skipped rows are counted, never rendered");
  // The no-synthesis pins carry through the panel untouched.
  assert.ok(!markup.includes("Anonymous") && !markup.includes("@unknown") && !markup.includes("just now"), "nothing in the surface invents attribution");
  // The panel header carries the recorded title beside the card key.
  assert.ok(markup.includes("Fix the flaky test"), "the recorded title renders in the panel header");
});

test("the panel renders the W167 surface's failure states verbatim — a refusal, an unconfigured hub, a provider error", () => {
  const withheld = renderToStaticMarkup(createElement(BoardCardDetailPanel, panelProps({ answer: { kind: "refusal", code: "HTTP 404", detail: "the hub does not offer issue detail" } })));
  assert.ok(withheld.includes("the hub does not offer issue detail") && withheld.includes("HTTP 404"), "the refusal renders verbatim with its code");
  assert.ok(withheld.includes("alert"), "the refusal keeps the rendered-deny alert role");
  const unconfigured = renderToStaticMarkup(createElement(BoardCardDetailPanel, panelProps({ answer: { kind: "detail", outcome: { state: "unconfigured", missing: ["WORKFLOW_GITHUB_TOKEN"] } } })));
  assert.ok(unconfigured.includes("no provider configured on the hub"), "the unconfigured hub's honesty renders");
  const errored = renderToStaticMarkup(createElement(BoardCardDetailPanel, panelProps({ answer: { kind: "detail", outcome: { state: "error", reason: "the provider answered 401: Bad credentials" } } })));
  assert.ok(errored.includes("the provider could not be read — the provider answered 401: Bad credentials"), "the provider error's reason renders verbatim");
});

test("an unanswered detail read renders the named absence — never a fabricated panel", () => {
  const loading = renderToStaticMarkup(createElement(BoardCardDetailPanel, panelProps()));
  assert.ok(loading.includes("issue detail: loading…"), "the unanswered read names its state");
  assert.ok(!loading.includes("board-issue-detail"), "no detail body renders before the relay answers");
  assert.ok(loading.includes("back to board"), "the back affordance is present while loading");
});

// ── the card's opener identity + the inline subregion's retirement ──

test("the board card carries its opener identity for the focus return, and the card's inline detail subregion is gone", () => {
  const markup = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome }));
  assert.ok(markup.includes("data-board-card=\"#12\""), "the card carries its key so the shell can return focus to the invoking card");
  assert.equal(count(markup, "data-board-card="), 1, "one identified card per received task");
  assert.ok(markup.includes(">detail</button>"), "the card's detail affordance still renders (it now OPENS the panel)");
  // The inline detail subregion is retired: the W167 view renders ONLY in
  // the panel — one call site in the module, the panel's.
  const source = readFileSync(resolve("src/ui/webapp/board-view.tsx"), "utf8");
  assert.equal(count(source, "<BoardIssueDetailView"), 1, "the W167 view has exactly one render site: the contextual panel");
  assert.equal(count(source, "fetch(`/api/board/task"), 1, "ONE relay read in the module — the panel's, once per opened key");
  const buttonBody = source.slice(
    source.indexOf("export function BoardIssueDetailButton"),
    source.indexOf("function useIssueDetailAnswer"),
  );
  assert.ok(buttonBody.length > 0, "the affordance and hook slices exist");
  assert.ok(
    !buttonBody.includes("useState") && !buttonBody.includes("fetch("),
    "the card's detail affordance owns no answer state and makes no relay read — the opener routes through the shell's panel state",
  );
  assert.ok(
    source.includes("onOpenDetail?.(task.key)"),
    "the card's detail affordance routes through the shell's panel state (the opener callback)",
  );
});

// ── the shell mounts the panel region for the stored opener record ──

function installWindowStorage(cardRecord?: string): { readonly restore: () => void } {
  const backing = new Map<string, string>();
  const sessionBacking = new Map<string, string>();
  if (cardRecord !== undefined) sessionBacking.set(CARD_DETAIL_STATE_KEY, cardRecord);
  const previous = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    },
    sessionStorage: {
      getItem: (key: string) => sessionBacking.get(key) ?? null,
      setItem: (key: string, value: string) => void sessionBacking.set(key, value),
    },
  } as unknown as typeof globalThis.window;
  return { restore: () => void (globalThis.window = previous) };
}

test("the shell mounts the card detail panel in its right-side contextual region for the stored opener record", () => {
  const { restore } = installWindowStorage("{\"opener\":\"board\",\"cardKey\":\"#12\"}");
  try {
    const markup = renderToStaticMarkup(createElement(AppShell, {
      view: "board" as const,
      setView: noop,
      focusedSessionId: undefined,
      setFocusedSessionId: noop,
    }));
    assert.ok(markup.includes("board-card-detail"), "the shell mounts the contextual panel region");
    assert.ok(markup.includes("Board card detail"), "the region is labelled");
    assert.ok(markup.includes("board card detail: #12"), "the panel renders the stored card record");
    assert.ok(markup.includes("back to board"), "the back affordance names the opener (Board → panel → back → Board)");
    assert.ok(markup.includes("issue detail: loading…"), "the restored panel re-reads the relay and names the unanswered state");
  } finally {
    restore();
  }
});

test("with no stored opener record the board page renders without the panel region", () => {
  const { restore } = installWindowStorage();
  try {
    const markup = renderToStaticMarkup(createElement(AppShell, {
      view: "board" as const,
      setView: noop,
      focusedSessionId: undefined,
      setFocusedSessionId: noop,
    }));
    assert.ok(!markup.includes("board-card-detail"), "no record, no panel region");
    assert.ok(!markup.includes("Board card detail"), "no region is labelled either");
  } finally {
    restore();
  }
});

// ── the shell's wiring: opener state, Esc, focus return (source pins) ──

test("the shell routes the card opener through the guarded panel state and returns focus to the invoking card", () => {
  const source = readFileSync(resolve("src/ui/webapp/app.tsx"), "utf8");
  assert.ok(
    source.includes("readCardDetailOpenFromWindow()"),
    "the shell's card panel state initializes from the guarded opener memory",
  );
  assert.ok(
    source.includes("saveCardDetailOpenToWindow(next)"),
    "opening a card persists the opener through the guarded window pair",
  );
  assert.ok(
    source.includes("clearCardDetailOpenToWindow()"),
    "closing clears the opener memory",
  );
  assert.ok(
    source.includes("'[data-board-card=\"' + CSS.escape(cardKey) + '\"]'"),
    "closing returns focus to the invoking card (the data-board-card identity)",
  );
  assert.ok(
    source.includes("<BoardCardDetailPanel"),
    "the detail region renders the card panel for the card record",
  );
  assert.ok(
    /Escape[\s\S]{0,600}?closeCardDetail\(\)/.test(source),
    "the shell's Escape arm closes the card panel (Esc closes; the panel owns Escape after chrome)",
  );
  assert.ok(
    source.includes("onOpenDetail={openCardDetail}"),
    "the board's card opener routes through the shell's panel state",
  );
});
