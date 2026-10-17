import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createNoteStore } from "../src/integrations/note-store.js";

// W212 — the notes subtree store (decision-brief Option A). Pins the
// store-level discipline the hub routes relay verbatim:
//   - the listing is `.md`-only, sorted with a plain `<` comparison, bounded
//     (the bound sets `truncated: true`), and never follows symlinks;
//   - a missing subtree reads as the honest EMPTY listing (no notes yet),
//     never an error;
//   - the sidecar `<slug>.json` parses defensively: absent -> null, malformed
//     JSON -> null, wrong-typed fields dropped, never fabricated;
//   - the read's confinement gate rejects every non-bare name BEFORE any
//     filesystem resolution (separators, `..`, absolute paths);
//   - an unknown / non-regular note is `unknown`; an over-cap note is
//     `over-cap` with the count — never a truncated body.

const seat = (context: TestContext): { readonly root: string; readonly notes: string } => {
  const root = mkdtempSync(join(tmpdir(), "wf-note-store-"));
  const notes = join(root, "notes");
  mkdirSync(notes);
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, notes };
};

test("W212: the listing is .md-only, name-sorted, and carries byte size", (context) => {
  const { notes } = seat(context);
  writeFileSync(join(notes, "b-note.md"), "# B\n");
  writeFileSync(join(notes, "a-note.md"), "# A\n\n");
  writeFileSync(join(notes, "ignored.txt"), "not markdown");
  const store = createNoteStore({ root: notes });
  const listing = store.list();
  assert.equal(listing.root, notes);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["a-note.md", "b-note.md"], "plain `<` name order");
  assert.equal(listing.entries[0]?.byteSize, 5);
  assert.deepEqual(listing.entries[0]?.meta, null, "no sidecar written -> metadata absent, never fabricated");
});

test("W212: a symlinked or vanished entry is skipped — lstat never follows", (context) => {
  const { root, notes } = seat(context);
  writeFileSync(join(notes, "real.md"), "# real\n");
  writeFileSync(join(root, "outside.md"), "# escape hatch\n");
  symlinkSync(join(root, "outside.md"), join(notes, "link.md"));
  const listing = createNoteStore({ root: notes }).list();
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["real.md"], "the symlink is skipped, never followed out of the subtree");
  // A directory named like a note is skipped too.
  mkdirSync(join(notes, "dir.md"));
  assert.deepEqual(createNoteStore({ root: notes }).list().entries.map((entry) => entry.name), ["real.md"]);
});

test("W212: the listing bound truncates honestly", (context) => {
  const { notes } = seat(context);
  writeFileSync(join(notes, "one.md"), "1");
  writeFileSync(join(notes, "two.md"), "2");
  writeFileSync(join(notes, "three.md"), "3");
  const listing = createNoteStore({ root: notes, maxEntries: 2 }).list();
  assert.equal(listing.truncated, true);
  // Plain code-unit `<`: "three.md" sorts before "two.md" ('h' < 'w').
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["one.md", "three.md"], "the bound keeps the sort prefix");
});

test("W212: a missing subtree reads as the honest empty listing, never an error", (context) => {
  const { root } = seat(context);
  const listing = createNoteStore({ root: join(root, "no-such-notes") }).list();
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.entries, []);
});

test("W212: the sidecar parses; malformed and wrong-typed payloads stay absent", (context) => {
  const { notes } = seat(context);
  writeFileSync(join(notes, "good.md"), "# good\n");
  writeFileSync(join(notes, "good.json"), JSON.stringify({
    title: "Good note",
    source: "https://example.test/x",
    producedAt: "2026-10-17T01:02:03.000Z",
    runId: "run-7",
    blocked: true,
    findings: 4,
    // unknown field: dropped; wrong-typed title on the second case below
    extra: "dropped",
  }));
  writeFileSync(join(notes, "broken.md"), "# broken\n");
  writeFileSync(join(notes, "broken.json"), "{not json");
  writeFileSync(join(notes, "misshaped.md"), "# misshaped\n");
  writeFileSync(join(notes, "misshaped.json"), JSON.stringify({ title: 42, blocked: "yes", findings: "many", source: "s" }));
  const store = createNoteStore({ root: notes });
  const listing = store.list();
  assert.deepEqual(listing.entries.find((entry) => entry.name === "good.md")?.meta, {
    title: "Good note",
    source: "https://example.test/x",
    producedAt: "2026-10-17T01:02:03.000Z",
    runId: "run-7",
    blocked: true,
    findings: 4,
  });
  assert.deepEqual(listing.entries.find((entry) => entry.name === "broken.md")?.meta, null, "malformed JSON is absent, never fabricated");
  assert.deepEqual(listing.entries.find((entry) => entry.name === "misshaped.md")?.meta, { source: "s" }, "wrong-typed fields drop; correctly-typed ones survive");
});

test("W212: the read returns the body verbatim with its sidecar", (context) => {
  const { notes } = seat(context);
  writeFileSync(join(notes, "one.md"), "# One\n\nbody\n");
  writeFileSync(join(notes, "one.json"), JSON.stringify({ title: "One" }));
  const read = createNoteStore({ root: notes }).read("one.md");
  assert.equal(read.kind, "ok");
  if (read.kind !== "ok") return;
  assert.equal(read.note.name, "one.md");
  assert.equal(read.note.body, "# One\n\nbody\n");
  assert.deepEqual(read.note.meta, { title: "One" });
});

test("W212: confinement rejects separators, .., and absolute names", (context) => {
  const { notes } = seat(context);
  writeFileSync(join(notes, "real.md"), "# real\n");
  const store = createNoteStore({ root: notes });
  for (const bad of ["../real.md", "..\\real.md", join(notes, "real.md"), "/etc/passwd", "a/b.md", "a..b.md", "..md", "real.txt", "", ".md"]) {
    const read = store.read(bad);
    assert.equal(read.kind, "invalid", "confined out: " + JSON.stringify(bad));
    if (read.kind === "invalid") assert.match(read.error, /./, "the refusal names its rule");
  }
  // The confinement gate runs BEFORE the filesystem: an outside file that
  // exists still cannot be reached through a traversal name.
  writeFileSync(join(mkdtempSync(join(tmpdir(), "wf-note-outside-")), "outside.md"), "x");
  assert.equal(store.read("../../outside.md").kind, "invalid");
});

test("W212: an unknown note is unknown; a symlinked note is unknown too", (context) => {
  const { root, notes } = seat(context);
  writeFileSync(join(root, "outside.md"), "# outside\n");
  symlinkSync(join(root, "outside.md"), join(notes, "link.md"));
  const store = createNoteStore({ root: notes });
  assert.equal(store.read("nope.md").kind, "unknown");
  assert.equal(store.read("link.md").kind, "unknown", "a symlink is never followed — it answers unknown");
});

test("W212: an over-cap note is over-cap with the count, never a truncated body", (context) => {
  const { notes } = seat(context);
  writeFileSync(join(notes, "big.md"), "x".repeat(64));
  const store = createNoteStore({ root: notes, maxBytes: 10 });
  const read = store.read("big.md");
  assert.equal(read.kind, "over-cap");
  if (read.kind !== "over-cap") return;
  assert.match(read.error, /cap/);
  // Under the real cap the same file reads fine — the refusal is the bound,
  // not a parse step.
  assert.equal(createNoteStore({ root: notes, maxBytes: 100 }).read("big.md").kind, "ok");
});
