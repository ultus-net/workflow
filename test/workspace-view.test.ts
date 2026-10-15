import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { WorkspaceView, formatBytes, formatModified, type WorkspaceListing } from "../src/ui/webapp/workspace-view.js";

// W197 — the Workspace view's four-state contract (hub overhaul slice 2). The
// view renders the hub's bounded directory read and fabricates nothing; a
// missing listing WITHOUT a reason is "loading", a missing listing WITH a
// reason is "error". The truncated notice renders only when the hub reports it.

const LISTING: WorkspaceListing = {
  root: "/workspace",
  truncated: false,
  entries: [
    { name: "notes.md", kind: "file", size: 128, modifiedMs: 1_760_000_000_000 },
    { name: "src", kind: "directory", size: 0, modifiedMs: 1_760_000_001_000 },
  ],
};

test("W197: the loading state renders when no listing and no reason exist", () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceView, { workspace: undefined }));
  assert.match(markup, /loading workspace/);
  assert.match(markup, /workspace-loading/);
  assert.doesNotMatch(markup, /workspace-error/);
});

test("W197: the error state renders the reason, not a fabricated table", () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceView, { workspace: undefined, reason: "hub unavailable" }));
  assert.match(markup, /workspace-error/);
  assert.match(markup, /hub unavailable/);
  assert.doesNotMatch(markup, /workspace-table/);
});

test("W197: the populated state renders the root, an entry per row, and no truncated notice", () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceView, { workspace: LISTING }));
  assert.match(markup, /\/workspace/);
  assert.match(markup, /notes\.md/);
  assert.match(markup, /128 B/);
  assert.match(markup, /workspace-table/);
  assert.doesNotMatch(markup, /workspace-truncated/);
  assert.doesNotMatch(markup, /workspace-empty/);
});

test("W197: the empty state renders the honest no-entries note instead of a blank table", () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceView, { workspace: { root: "/workspace", truncated: false, entries: [] } }));
  assert.match(markup, /workspace-empty/);
  assert.match(markup, /no entries/);
});

test("W197: the truncated notice renders only when the hub reports truncation", () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceView, { workspace: { root: "/workspace", truncated: true, entries: [] } }));
  assert.match(markup, /workspace-truncated/);
  assert.match(markup, /truncated/);
});

test("W197: formatBytes is pure and locale-independent", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KiB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MiB");
  assert.equal(formatBytes(-1), "0 B");
});

test("W197: formatModified renders the ISO instant, never a locale string", () => {
  assert.equal(formatModified(0), "1970-01-01T00:00:00Z");
  assert.equal(formatModified(1_760_000_000_000), "2025-10-09T08:53:20Z");
});
