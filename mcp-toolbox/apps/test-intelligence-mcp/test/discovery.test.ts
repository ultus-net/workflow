import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { NodeTestAdapter } from "../src/node-test-adapter.js";

const fixture = resolve("test/fixtures/node-project");

test("discovers runnable files in deterministic canonical order", async () => {
  const result = await new NodeTestAdapter().discoverTests({ workspaceRoot: fixture, limit: 100 });

  assert.deepEqual(result, {
    tests: [
      { id: "node:nested/failing.spec.ts", file: "nested/failing.spec.ts", label: "nested/failing.spec.ts", runner: "node" },
      { id: "node:passing.test.js", file: "passing.test.js", label: "passing.test.js", runner: "node" },
    ],
    truncated: false,
  });
});

test("reports truncation only after observing another permitted test file", async () => {
  const adapter = new NodeTestAdapter();
  assert.deepEqual(await adapter.discoverTests({ workspaceRoot: fixture, limit: 1 }), {
    tests: [{ id: "node:nested/failing.spec.ts", file: "nested/failing.spec.ts", label: "nested/failing.spec.ts", runner: "node" }],
    truncated: true,
  });
  assert.equal((await adapter.discoverTests({ workspaceRoot: fixture, limit: 2 })).truncated, false);
});

test("canonicalizes in-workspace aliases and rejects symlink escapes", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-discovery-"));
  const outside = await mkdtemp(join(tmpdir(), "test-intelligence-outside-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  });
  await mkdir(join(workspace, "real"));
  await writeFile(join(workspace, "real", "inside.test.js"), "");
  await writeFile(join(workspace, "real", "application.js"), "");
  await writeFile(join(outside, "escaped.test.js"), "");
  await symlink(join(workspace, "real", "inside.test.js"), join(workspace, "alias.test.js"));
  await symlink(join(workspace, "real", "application.js"), join(workspace, "misleading.test.js"));
  await symlink(join(outside, "escaped.test.js"), join(workspace, "escaped.test.js"));

  const result = await new NodeTestAdapter().discoverTests({ workspaceRoot: workspace, limit: 100 });
  assert.deepEqual(result.tests, [
    { id: "node:real/inside.test.js", file: "real/inside.test.js", label: "real/inside.test.js", runner: "node" },
  ]);
});

test("rejects aliases whose canonical targets are in excluded directories", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-excluded-"));
  t.after(async () => (await import("node:fs/promises")).rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, ".git"));
  await mkdir(join(workspace, "node_modules"));
  await writeFile(join(workspace, ".git", "hidden.test.js"), "");
  await writeFile(join(workspace, "node_modules", "dependency.test.js"), "");
  await symlink(join(workspace, ".git", "hidden.test.js"), join(workspace, "git-alias.test.js"));
  await symlink(join(workspace, "node_modules", "dependency.test.js"), join(workspace, "module-alias.test.js"));

  const result = await new NodeTestAdapter().discoverTests({ workspaceRoot: workspace, limit: 100 });
  assert.deepEqual(result, { tests: [], truncated: false });
});

test("sorts normalized test paths by ordinal code-unit order", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-order-"));
  t.after(async () => (await import("node:fs/promises")).rm(workspace, { recursive: true, force: true }));
  await Promise.all(["A.test.js", "_.test.js", "a.test.js"].map((file) => writeFile(join(workspace, file), "")));

  const result = await new NodeTestAdapter().discoverTests({ workspaceRoot: workspace, limit: 100 });
  assert.deepEqual(result.tests.map((entry) => entry.file), ["A.test.js", "_.test.js", "a.test.js"]);
});

test("surfaces filesystem failures that make discovery incomplete", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("permission semantics are not reliable here");
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-permission-"));
  const blocked = join(workspace, "blocked");
  await mkdir(blocked);
  await writeFile(join(blocked, "hidden.test.js"), "");
  await chmod(blocked, 0o000);
  t.after(async () => {
    await chmod(blocked, 0o700);
    await (await import("node:fs/promises")).rm(workspace, { recursive: true, force: true });
  });

  await assert.rejects(new NodeTestAdapter().discoverTests({ workspaceRoot: workspace, limit: 100 }));
});

test("honors an already-aborted discovery request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new NodeTestAdapter().discoverTests({ workspaceRoot: fixture, limit: 100 }, controller.signal),
    { name: "AbortError" },
  );
});

test("ranks file relevance within the nearest package project", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-relevance-"));
  t.after(async () => (await import("node:fs/promises")).rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "app", "src"), { recursive: true });
  await mkdir(join(workspace, "app", "test"));
  await mkdir(join(workspace, "other", "test"), { recursive: true });
  await writeFile(join(workspace, "package.json"), "{}");
  await writeFile(join(workspace, "app", "package.json"), "{}");
  await writeFile(join(workspace, "other", "package.json"), "{}");
  await writeFile(join(workspace, "app", "src", "policy.ts"), "");
  await writeFile(join(workspace, "app", "test", "policy.test.ts"), "");
  await writeFile(join(workspace, "app", "test", "smoke.test.ts"), "");
  await writeFile(join(workspace, "other", "test", "policy.test.ts"), "");

  const result = await new NodeTestAdapter().findRelevantTests({ workspaceRoot: workspace, file: "app/src/policy.ts", limit: 100 });

  assert.deepEqual(result, {
    tests: [
      { id: "node:app/test/policy.test.ts", file: "app/test/policy.test.ts", label: "app/test/policy.test.ts", runner: "node", relevance: "matching_stem" },
      { id: "node:app/test/smoke.test.ts", file: "app/test/smoke.test.ts", label: "app/test/smoke.test.ts", runner: "node", relevance: "same_project" },
    ],
    truncated: false,
  });
});

test("reports relevance truncation only after filtering to the source project", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-relevance-limit-"));
  t.after(async () => (await import("node:fs/promises")).rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "package.json"), "{}");
  await writeFile(join(workspace, "src", "thing.ts"), "");
  await writeFile(join(workspace, "a.test.ts"), "");
  await writeFile(join(workspace, "thing.test.ts"), "");

  const result = await new NodeTestAdapter().findRelevantTests({ workspaceRoot: workspace, file: "src/thing.ts", limit: 1 });
  assert.deepEqual(result.tests.map(({ file, relevance }) => ({ file, relevance })), [{ file: "thing.test.ts", relevance: "matching_stem" }]);
  assert.equal(result.truncated, true);
});

test("rejects relevance queries that escape the workspace or have no project", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-relevance-invalid-"));
  const outside = await mkdtemp(join(tmpdir(), "test-intelligence-relevance-outside-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  });
  await writeFile(join(workspace, "source.ts"), "");
  await writeFile(join(outside, "source.ts"), "");
  await symlink(join(outside, "source.ts"), join(workspace, "escaped.ts"));
  const adapter = new NodeTestAdapter();

  await assert.rejects(adapter.findRelevantTests({ workspaceRoot: workspace, file: "escaped.ts", limit: 100 }));
  await assert.rejects(adapter.findRelevantTests({ workspaceRoot: workspace, file: "source.ts", limit: 100 }));
});
