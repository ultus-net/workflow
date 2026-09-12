import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { GitHistoryAdapter } from "../src/git-history-adapter.js";
import { createRepository, git } from "./git-fixture.ts";

function commit(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", message]);
}

test("returns bounded file history and committed line provenance", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "tracked.txt"), "one\ntwo\n");
  commit(fixture.root, "add second line");

  const adapter = new GitHistoryAdapter();
  const history = await adapter.fileHistory({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 50 });
  assert.equal(history.commits.length, 2);
  assert.equal(history.commits[0]?.subject, "add second line");
  assert.equal(history.commits[0]?.path, "tracked.txt");
  assert.match(history.commits[0]?.commit ?? "", /^[0-9a-f]{40,64}$/);
  assert.equal(history.commits[0]?.authorName, "Fixture Author");
  assert.equal(history.commits[0]?.authorEmail, "fixture@example.invalid");
  assert.equal(history.truncated, false);

  const blame = await adapter.fileBlame({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 200 });
  assert.deepEqual(blame.lines.map(({ originalLine, finalLine, path }) => ({ originalLine, finalLine, path })), [
    { originalLine: 1, finalLine: 1, path: "tracked.txt" },
    { originalLine: 2, finalLine: 2, path: "tracked.txt" },
  ]);
  assert.equal(blame.lines[0]?.authorTime, "946684800");
  assert.equal(blame.truncated, false);
});

test("returns empty blame provenance for a committed empty file", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "empty.txt"), "");
  commit(fixture.root, "add empty file");
  const blame = await new GitHistoryAdapter().fileBlame({ workspaceRoot: fixture.root, path: "empty.txt", limit: 200 });
  assert.deepEqual(blame, { lines: [], truncated: false });
});

test("follows renames while preserving historical path identity", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  renameSync(join(fixture.root, "rename-me.txt"), join(fixture.root, "renamed.txt"));
  commit(fixture.root, "rename file");

  const adapter = new GitHistoryAdapter();
  const history = await adapter.fileHistory({ workspaceRoot: fixture.root, path: "renamed.txt", limit: 50 });
  assert.deepEqual(history.commits.map(({ path, originalPath }) => ({ path, originalPath })), [
    { path: "renamed.txt", originalPath: "rename-me.txt" },
    { path: "rename-me.txt", originalPath: undefined },
  ]);
  const blame = await adapter.fileBlame({ workspaceRoot: fixture.root, path: "renamed.txt", limit: 200 });
  assert.equal(blame.lines[0]?.path, "rename-me.txt");
});

test("reports truncation only after observing additional history or blame", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "tracked.txt"), "one\ntwo\n");
  commit(fixture.root, "second version");
  const adapter = new GitHistoryAdapter();
  const history = await adapter.fileHistory({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 1 });
  assert.equal(history.commits.length, 1);
  assert.equal(history.truncated, true);
  const blame = await adapter.fileBlame({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 1 });
  assert.equal(blame.lines.length, 1);
  assert.equal(blame.truncated, true);
});

test("bounds commit message evidence without splitting UTF-8", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "tracked.txt"), "changed\n");
  git(fixture.root, ["add", "tracked.txt"]);
  git(fixture.root, ["commit", "-qm", `subject ${"x".repeat(9 * 1024)} é`]);
  const result = await new GitHistoryAdapter().fileHistory({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 50 });
  assert.equal(result.commits[0]?.messageTruncated, true);
  assert.ok(Buffer.byteLength(`${result.commits[0]?.subject ?? ""}\n${result.commits[0]?.body ?? ""}`) <= 8 * 1024);
  assert.equal((result.commits[0]?.subject ?? "").includes("�"), false);
});

test("treats caller paths literally and rejects paths outside workspace", async (t) => {
  if (process.platform === "win32") return;
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const path = ":(glob)literal*.txt";
  writeFileSync(join(fixture.root, path), "literal\n");
  commit(fixture.root, "literal path");
  const adapter = new GitHistoryAdapter();
  const history = await adapter.fileHistory({ workspaceRoot: fixture.root, path, limit: 50 });
  assert.equal(history.commits[0]?.path, path);
  await assert.rejects(adapter.fileHistory({ workspaceRoot: fixture.root, path: "../outside", limit: 50 }), /escapes workspace/);
  await assert.rejects(adapter.fileHistory({ workspaceRoot: fixture.root, path: "subdir/../tracked.txt", limit: 50 }), /escapes workspace/);
  await assert.rejects(adapter.fileBlame({ workspaceRoot: fixture.root, path: "/tmp/outside", limit: 200 }), /escapes workspace/);
});

test("decodes quoted historical blame paths", async (t) => {
  if (process.platform === "win32") return;
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const path = "quoted\tpath-é.txt";
  writeFileSync(join(fixture.root, path), "quoted\n");
  commit(fixture.root, "quoted blame path");
  const blame = await new GitHistoryAdapter().fileBlame({ workspaceRoot: fixture.root, path, limit: 200 });
  assert.equal(blame.lines[0]?.path, path);
});

test("rejects inherited repository authority and honors cancellation", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const adapter = new GitHistoryAdapter();
  await assert.rejects(adapter.fileHistory({ workspaceRoot: join(fixture.root, "subdir"), path: "tracked.txt", limit: 50 }), /ENOENT|Git worktree root/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adapter.fileBlame({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 200 }, controller.signal), /cancelled/);
});

test("history disables and blame rejects repository executable configuration", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const marker = join(fixture.root, "sentinel-ran");
  const sentinel = join(fixture.root, "sentinel.sh");
  writeFileSync(sentinel, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  git(fixture.root, ["config", "diff.external", sentinel]);
  git(fixture.root, ["config", "diff.evil.textconv", sentinel]);
  writeFileSync(join(fixture.root, "ignore-revs"), "# hostile attribution config is explicitly cleared\n");
  git(fixture.root, ["config", "blame.ignoreRevsFile", "ignore-revs"]);
  git(fixture.root, ["config", "log.showSignature", "true"]);
  writeFileSync(join(fixture.root, ".gitattributes"), "tracked.txt diff=evil\n");
  commit(fixture.root, "attributes");
  const adapter = new GitHistoryAdapter();
  await adapter.fileHistory({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 50 });
  await assert.rejects(adapter.fileBlame({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 200 }), /refuses configured executable or attribution behavior/);
  assert.equal(existsSync(marker), false);
});

test("blame ignores ambient config and rejects worktree executable configuration", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const marker = join(fixture.root, "ambient-sentinel-ran");
  const sentinel = join(fixture.root, "ambient-sentinel.sh");
  writeFileSync(sentinel, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const home = join(fixture.root, "fake-home");
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), `[diff]\n\texternal = ${sentinel}\n`);
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; });

  const adapter = new GitHistoryAdapter();
  await adapter.fileBlame({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 200 });
  assert.equal(existsSync(marker), false);

  git(fixture.root, ["config", "extensions.worktreeConfig", "true"]);
  git(fixture.root, ["config", "--worktree", "diff.external", sentinel]);
  await assert.rejects(adapter.fileBlame({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 200 }), /refuses configured executable or attribution behavior/);
  assert.equal(existsSync(marker), false);
});

test("history and blame fail locally instead of lazy-fetching missing objects", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const marker = join(fixture.root, "remote-ran");
  const sentinel = join(fixture.root, "remote-sentinel.sh");
  writeFileSync(sentinel, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(sentinel, 0o755);
  git(fixture.root, ["config", "remote.origin.url", `ext::${sentinel}`]);
  git(fixture.root, ["config", "remote.origin.promisor", "true"]);
  git(fixture.root, ["config", "remote.origin.partialclonefilter", "blob:none"]);
  git(fixture.root, ["config", "protocol.ext.allow", "always"]);
  const tree = git(fixture.root, ["rev-parse", "HEAD^{tree}"]).trim();
  rmSync(join(fixture.root, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
  const adapter = new GitHistoryAdapter();
  await assert.rejects(adapter.fileHistory({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 50 }));
  await assert.rejects(adapter.fileBlame({ workspaceRoot: fixture.root, path: "tracked.txt", limit: 200 }));
  assert.equal(existsSync(marker), false);
});
