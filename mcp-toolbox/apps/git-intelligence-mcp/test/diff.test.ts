import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { GitDiffAdapter } from "../src/git-diff-adapter.js";
import { createRepository, git } from "./git-fixture.ts";

test("separates unstaged and staged diff scopes with normalized metadata", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "tracked.txt"), "staged\n");
  git(fixture.root, ["add", "tracked.txt"]);
  writeFileSync(join(fixture.root, "tracked.txt"), "unstaged\n");
  const adapter = new GitDiffAdapter();
  const staged = await adapter.diff({ workspaceRoot: fixture.root, scope: "staged", limit: 100 });
  const unstaged = await adapter.diff({ workspaceRoot: fixture.root, scope: "unstaged", limit: 100 });
  assert.equal(staged.files[0]?.path, "tracked.txt");
  assert.equal(staged.files[0]?.change, "modified");
  assert.match(staged.files[0]?.patch ?? "", /\+staged/);
  assert.equal(unstaged.files[0]?.path, "tracked.txt");
  assert.match(unstaged.files[0]?.patch ?? "", /\+unstaged/);
});

test("preserves rename identity and represents binary changes structurally", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  renameSync(join(fixture.root, "rename-me.txt"), join(fixture.root, "renamed.txt"));
  writeFileSync(join(fixture.root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  git(fixture.root, ["add", "-A"]);
  const result = await new GitDiffAdapter().diff({ workspaceRoot: fixture.root, scope: "staged", limit: 100 });
  assert.deepEqual(result.files.map(({ path, originalPath, change, binary }) => ({ path, originalPath, change, binary })), [
    { path: "binary.bin", originalPath: undefined, change: "added", binary: true },
    { path: "renamed.txt", originalPath: "rename-me.txt", change: "renamed", binary: false },
  ]);
  assert.equal(result.files[0]?.patch, undefined);
});

test("bounds files and textual patch evidence with explicit truncation", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "a.txt"), `${"a".repeat(40 * 1024)}\n`);
  writeFileSync(join(fixture.root, "b.txt"), "b\n");
  git(fixture.root, ["add", "a.txt", "b.txt"]);
  const result = await new GitDiffAdapter().diff({ workspaceRoot: fixture.root, scope: "staged", limit: 1 });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.path, "a.txt");
  assert.equal(result.files[0]?.patchTruncated, true);
  assert.ok(Buffer.byteLength(result.files[0]?.patch ?? "") <= 32 * 1024);
  assert.equal(result.truncated, true);
  assert.equal(result.evidenceTruncated, true);
});

test("disables external diff and textconv execution", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const marker = join(fixture.root, "sentinel-ran");
  const sentinel = join(fixture.root, "sentinel.sh");
  writeFileSync(sentinel, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(sentinel, 0o755);
  git(fixture.root, ["config", "diff.external", sentinel]);
  git(fixture.root, ["config", "diff.evil.textconv", sentinel]);
  writeFileSync(join(fixture.root, ".gitattributes"), "tracked.txt diff=evil\n");
  git(fixture.root, ["add", ".gitattributes"]);
  git(fixture.root, ["commit", "-qm", "attributes"]);
  writeFileSync(join(fixture.root, "tracked.txt"), "changed\n");
  await new GitDiffAdapter().diff({ workspaceRoot: fixture.root, scope: "unstaged", limit: 100 });
  assert.equal(existsSync(marker), false);
});

test("reports staged deletion and supports staged diffs on an unborn branch", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  rmSync(join(fixture.root, "tracked.txt"));
  git(fixture.root, ["add", "-A"]);
  const deletion = await new GitDiffAdapter().diff({ workspaceRoot: fixture.root, scope: "staged", limit: 100 });
  assert.equal(deletion.files.find((file) => file.path === "tracked.txt")?.change, "deleted");

  const unborn = join(fixture.root, "nested");
  mkdirSync(unborn);
  git(unborn, ["init", "-q"]);
  writeFileSync(join(unborn, "new.txt"), "new\n");
  git(unborn, ["add", "new.txt"]);
  const addition = await new GitDiffAdapter().diff({ workspaceRoot: unborn, scope: "staged", limit: 100 });
  assert.equal(addition.files[0]?.change, "added");
});

test("rejects inherited parent repository authority", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const nested = join(fixture.root, "nested");
  mkdirSync(nested);
  await assert.rejects(new GitDiffAdapter().diff({ workspaceRoot: nested, scope: "unstaged", limit: 100 }), /Git worktree root/);
});

test("honors an already-aborted diff request", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new GitDiffAdapter().diff({ workspaceRoot: fixture.root, scope: "unstaged", limit: 100 }, controller.signal), /cancelled/);
});

test("preserves literal backslashes in valid POSIX filenames", async (t) => {
  if (process.platform === "win32") return;
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const path = "back\\slash.txt";
  writeFileSync(join(fixture.root, path), "content\n");
  git(fixture.root, ["add", path]);
  const result = await new GitDiffAdapter().diff({ workspaceRoot: fixture.root, scope: "staged", limit: 100 });
  assert.equal(result.files.find((file) => file.path === path)?.path, path);
  assert.match(result.files.find((file) => file.path === path)?.patch ?? "", /content/);
});

test("patch evidence is independent of repository diff presentation configuration", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "tracked.txt"), "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nchanged\n");
  const adapter = new GitDiffAdapter();
  const baseline = await adapter.diff({ workspaceRoot: fixture.root, scope: "unstaged", limit: 100 });
  git(fixture.root, ["config", "diff.context", "0"]);
  git(fixture.root, ["config", "diff.interHunkContext", "99"]);
  git(fixture.root, ["config", "diff.algorithm", "histogram"]);
  git(fixture.root, ["config", "diff.noprefix", "true"]);
  git(fixture.root, ["config", "diff.mnemonicPrefix", "true"]);
  git(fixture.root, ["config", "diff.indentHeuristic", "true"]);
  const configured = await adapter.diff({ workspaceRoot: fixture.root, scope: "unstaged", limit: 100 });
  assert.equal(configured.files[0]?.patch, baseline.files[0]?.patch);
});
