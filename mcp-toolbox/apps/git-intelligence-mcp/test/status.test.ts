import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { GitStatusAdapter } from "../src/git-status-adapter.js";
import { createDirectory, createRepository, git, makeDirectory } from "./git-fixture.ts";

test("returns deterministic staged, unstaged, untracked, and rename state", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "tracked.txt"), "staged\n");
  git(fixture.root, ["add", "tracked.txt"]);
  renameSync(join(fixture.root, "rename-me.txt"), join(fixture.root, "renamed.txt"));
  git(fixture.root, ["add", "-A"]);
  writeFileSync(join(fixture.root, "tracked.txt"), "unstaged\n");
  writeFileSync(join(fixture.root, "z-untracked.txt"), "new\n");

  const result = await new GitStatusAdapter().workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 });
  assert.deepEqual(result, {
    entries: [
      { path: "renamed.txt", originalPath: "rename-me.txt", staged: "renamed", unstaged: "none" },
      { path: "tracked.txt", staged: "modified", unstaged: "modified" },
      { path: "z-untracked.txt", staged: "none", unstaged: "untracked" },
    ],
    truncated: false,
  });
});

test("preserves unusual valid filenames through NUL-delimited status", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const name = "line\nbreak.txt";
  writeFileSync(join(fixture.root, name), "new\n");
  const result = await new GitStatusAdapter().workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 });
  assert.deepEqual(result.entries, [{ path: name, staged: "none", unstaged: "untracked" }]);
});

test("treats an unborn repository as a valid worktree", async (t) => {
  const fixture = createDirectory();
  t.after(fixture.cleanup);
  git(fixture.root, ["init", "--quiet"]);
  writeFileSync(join(fixture.root, "first.txt"), "new\n");
  const result = await new GitStatusAdapter().workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 });
  assert.deepEqual(result, { entries: [{ path: "first.txt", staged: "none", unstaged: "untracked" }], truncated: false });
});

test("reports staged additions and deletions", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "added.txt"), "added\n");
  git(fixture.root, ["add", "added.txt"]);
  git(fixture.root, ["rm", "--quiet", "rename-me.txt"]);
  const result = await new GitStatusAdapter().workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 });
  assert.deepEqual(result.entries, [
    { path: "added.txt", staged: "added", unstaged: "none" },
    { path: "rename-me.txt", staged: "deleted", unstaged: "none" },
  ]);
});

test("reports a changed submodule commit but ignores recursive submodule dirtiness", async (t) => {
  const fixture = createRepository();
  const child = createRepository();
  t.after(fixture.cleanup);
  t.after(child.cleanup);
  git(fixture.root, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child.root, "module"]);
  git(fixture.root, ["commit", "-qm", "add submodule"]);
  writeFileSync(join(child.root, "tracked.txt"), "second\n");
  git(child.root, ["commit", "-qam", "second"]);
  git(join(fixture.root, "module"), ["fetch", "--quiet"]);
  git(join(fixture.root, "module"), ["checkout", "--quiet", "FETCH_HEAD"]);

  const adapter = new GitStatusAdapter();
  assert.deepEqual((await adapter.workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 })).entries, [
    { path: "module", staged: "none", unstaged: "modified" },
  ]);
  writeFileSync(join(fixture.root, "module", "untracked.txt"), "dirty\n");
  assert.deepEqual((await adapter.workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 })).entries, [
    { path: "module", staged: "none", unstaged: "modified" },
  ]);
});

test("reports conflicts distinctly from ordinary staged and unstaged state", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  git(fixture.root, ["checkout", "-q", "-b", "other"]);
  writeFileSync(join(fixture.root, "tracked.txt"), "other\n");
  git(fixture.root, ["commit", "-qam", "other"]);
  git(fixture.root, ["checkout", "-q", "master"]);
  writeFileSync(join(fixture.root, "tracked.txt"), "master\n");
  git(fixture.root, ["commit", "-qam", "master"]);
  try { git(fixture.root, ["merge", "other"]); } catch { /* expected merge conflict */ }

  const result = await new GitStatusAdapter().workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 });
  assert.deepEqual(result.entries, [{ path: "tracked.txt", staged: "unmerged", unstaged: "unmerged", conflict: "UU" }]);
});

test("bounds sorted entries only after observing another permitted record", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "b.txt"), "b\n");
  writeFileSync(join(fixture.root, "a.txt"), "a\n");
  const result = await new GitStatusAdapter().workingTreeStatus({ workspaceRoot: fixture.root, limit: 1 });
  assert.deepEqual(result, { entries: [{ path: "a.txt", staged: "none", unstaged: "untracked" }], truncated: true });
});

test("rejects non-repositories and parent-repository authority", async (t) => {
  const plain = createDirectory();
  const fixture = createRepository();
  t.after(plain.cleanup);
  t.after(fixture.cleanup);
  makeDirectory(fixture.root, "nested");
  const adapter = new GitStatusAdapter();
  await assert.rejects(adapter.workingTreeStatus({ workspaceRoot: plain.root, limit: 100 }));
  await assert.rejects(adapter.workingTreeStatus({ workspaceRoot: join(fixture.root, "nested"), limit: 100 }));
});

test("accepts a canonical worktree root reached through a symlink alias", async (t) => {
  const fixture = createRepository();
  const aliases = createDirectory();
  t.after(fixture.cleanup);
  t.after(aliases.cleanup);
  const alias = join(aliases.root, "repo-link");
  symlinkSync(fixture.root, alias, "dir");
  assert.deepEqual(await new GitStatusAdapter().workingTreeStatus({ workspaceRoot: alias, limit: 100 }), { entries: [], truncated: false });
});

test("queries an explicitly supplied nested repository without inheriting parent authority", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  makeDirectory(fixture.root, "nested-repo");
  const nested = join(fixture.root, "nested-repo");
  git(nested, ["init", "--quiet"]);
  writeFileSync(join(nested, "nested.txt"), "new\n");
  assert.deepEqual(await new GitStatusAdapter().workingTreeStatus({ workspaceRoot: nested, limit: 100 }), {
    entries: [{ path: "nested.txt", staged: "none", unstaged: "untracked" }], truncated: false,
  });
});

test("honors an already-aborted status request", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new GitStatusAdapter().workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 }, controller.signal),
    /cancelled/,
  );
});

test("disables repository-configured FSMonitor and hooks during status", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const marker = join(fixture.root, "sentinel-ran");
  const sentinel = join(fixture.root, "sentinel.sh");
  writeFileSync(sentinel, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(sentinel, 0o755);
  const hooks = join(fixture.root, "hooks");
  mkdirSync(hooks);
  for (const hook of ["pre-commit", "post-checkout", "post-merge"]) {
    const path = join(hooks, hook);
    writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(path, 0o755);
  }
  git(fixture.root, ["config", "core.fsmonitor", sentinel]);
  git(fixture.root, ["config", "core.hooksPath", hooks]);
  await new GitStatusAdapter().workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 });
  assert.equal(existsSync(marker), false);
});

test("fails locally instead of lazy-fetching missing repository objects", async (t) => {
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

  await assert.rejects(new GitStatusAdapter().workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 }));
  assert.equal(existsSync(marker), false);
});

test("rejects Git status output beyond the internal byte ceiling", async (t) => {
  const fixture = createRepository();
  const fake = createDirectory();
  t.after(fixture.cleanup);
  t.after(fake.cleanup);
  const executable = join(fake.root, "git");
  writeFileSync(executable, `#!/usr/bin/env node\nif (process.argv.includes('rev-parse')) process.stdout.write(${JSON.stringify(fixture.root)} + '\\n'); else process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 65));\n`);
  chmodSync(executable, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fake.root}:${oldPath ?? ""}`;
  try {
    await assert.rejects(new GitStatusAdapter().workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 }), /safety limit/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("terminates and reaps a running Git child on cancellation", async (t) => {
  const fixture = createRepository();
  const fake = createDirectory();
  t.after(fixture.cleanup);
  t.after(fake.cleanup);
  const started = join(fake.root, "started");
  const killed = join(fake.root, "killed");
  const executable = join(fake.root, "git");
  writeFileSync(executable, `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.argv.includes('rev-parse')) { process.stdout.write(${JSON.stringify(fixture.root)} + '\\n'); } else { fs.writeFileSync(${JSON.stringify(started)}, ''); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(killed)}, ''); process.exit(0); }); setInterval(() => {}, 1000); }\n`);
  chmodSync(executable, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fake.root}:${oldPath ?? ""}`;
  const controller = new AbortController();
  try {
    const pending = new GitStatusAdapter().workingTreeStatus({ workspaceRoot: fixture.root, limit: 100 }, controller.signal);
    for (let attempt = 0; attempt < 100 && !existsSync(started); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(started), true);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(existsSync(killed), true);
  } finally {
    process.env.PATH = oldPath;
  }
});
