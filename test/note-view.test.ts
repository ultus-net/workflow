import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { NoteView, type NoteContent, type NoteListing } from "../src/ui/webapp/note-view.js";

// W212 — the Notes view's state cycle (decision-brief Option A). The view
// renders the hub's bounded subtree read and fabricates nothing: a missing
// listing WITHOUT a reason is "loading", a missing listing WITH a reason is
// "error", a missing or malformed sidecar is "metadata absent" (never a
// placeholder title), and the truncated notice renders only when the hub
// reports it. A selected note cycles loading / error (the refusal verbatim)
// / body.

const LISTING: NoteListing = {
  root: "/workspace/notes",
  truncated: false,
  entries: [
    {
      name: "2026-10-17-seam-stores.md",
      byteSize: 512,
      modifiedMs: 1_761_000_000_000,
      meta: { title: "Seam stores", source: "augur note", producedAt: "2026-10-17T00:00:00.000Z", blocked: false, findings: 0 },
    },
    { name: "raw-note.md", byteSize: 64, modifiedMs: 1_761_000_001_000, meta: null },
  ],
};

test("W212: the loading state renders when no listing and no reason exist", () => {
  const markup = renderToStaticMarkup(createElement(NoteView, { notes: undefined }));
  assert.match(markup, /loading notes/);
  assert.match(markup, /note-loading/);
  assert.doesNotMatch(markup, /note-error/);
});

test("W212: the error state renders the reason, not a fabricated table", () => {
  const markup = renderToStaticMarkup(createElement(NoteView, { notes: undefined, reason: "hub unavailable" }));
  assert.match(markup, /note-error/);
  assert.match(markup, /hub unavailable/);
  assert.doesNotMatch(markup, /note-table/);
});

test("W212: the populated state renders entries, sidecar metadata, and the absent marker — no truncated notice", () => {
  const markup = renderToStaticMarkup(createElement(NoteView, { notes: LISTING }));
  assert.match(markup, /\/workspace\/notes/);
  assert.match(markup, /2026-10-17-seam-stores\.md/);
  assert.match(markup, /Seam stores/, "the sidecar title renders");
  assert.match(markup, /source: augur note/, "the sidecar source renders");
  assert.match(markup, /not blocked/, "the sidecar verdict renders");
  assert.match(markup, /0 findings/);
  assert.match(markup, /512 B/);
  assert.doesNotMatch(markup, /note-truncated/);
  assert.doesNotMatch(markup, /note-empty/);
});

test("W212: a note with no sidecar is marked metadata-absent, never given a placeholder", () => {
  const markup = renderToStaticMarkup(createElement(NoteView, { notes: LISTING }));
  assert.match(markup, /raw-note\.md/);
  assert.match(markup, /note-meta-absent/);
  assert.match(markup, /metadata absent/);
});

test("W212: the empty state renders the honest no-notes note instead of a blank table", () => {
  const markup = renderToStaticMarkup(createElement(NoteView, { notes: { root: "/workspace/notes", truncated: false, entries: [] } }));
  assert.match(markup, /note-empty/);
  assert.match(markup, /no notes/);
});

test("W212: the truncated notice renders only when the hub reports truncation", () => {
  const markup = renderToStaticMarkup(createElement(NoteView, { notes: { root: "/workspace/notes", truncated: true, entries: [] } }));
  assert.match(markup, /note-truncated/);
  assert.match(markup, /truncated/);
});

test("W212: a selected note renders its sidecar title, metadata, and body verbatim", () => {
  const note: NoteContent = {
    name: "2026-10-17-seam-stores.md",
    byteSize: 512,
    modifiedMs: 1_761_000_000_000,
    meta: { title: "Seam stores", source: "augur note", blocked: true, findings: 3 },
    body: "# Seam stores\n\nThe body rides through verbatim.\n",
  };
  const markup = renderToStaticMarkup(createElement(NoteView, { notes: LISTING, selected: note.name, note }));
  assert.match(markup, /note-content/);
  assert.match(markup, /Seam stores/);
  assert.match(markup, /held by verification/, "the blocked verdict renders honestly");
  assert.match(markup, /3 findings/);
  assert.match(markup, /The body rides through verbatim\./);
});

test("W212: a selected note's refusal renders verbatim — the honest 413/404 faces", () => {
  const markup = renderToStaticMarkup(createElement(NoteView, {
    notes: LISTING,
    selected: "big.md",
    note: undefined,
    noteReason: "note body exceeds the 256 KiB per-note cap (262145 bytes); read it from the filesystem directly",
  }));
  assert.match(markup, /note-content-error/);
  assert.match(markup, /exceeds the 256 KiB per-note cap/);
  assert.doesNotMatch(markup, /note-body/);
});

test("W212: a selected note whose content is still loading renders the loading face", () => {
  const markup = renderToStaticMarkup(createElement(NoteView, { notes: LISTING, selected: "one.md" }));
  assert.match(markup, /note-content-loading/);
  assert.match(markup, /loading note/);
});
