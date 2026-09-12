import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectMemoryStore } from "../src/project-memory.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "project-memory-workspace-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "project-memory-data-"));
  return { root, dataRoot, store: new ProjectMemoryStore(dataRoot) };
}

test("persists and searches all memory kinds across store instances", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  for (const kind of ["fact", "decision", "constraint", "lesson"] as const) {
    await store.record({ workspaceRoot: root, kind, content: `${kind} durable alpha knowledge`, paths: [] });
  }

  const result = await new ProjectMemoryStore(dataRoot).search({ workspaceRoot: root, query: "alpha", limit: 8 });
  assert.deepEqual(result.records.map((record) => record.kind).sort(), ["constraint", "decision", "fact", "lesson"]);
  assert.equal(result.truncated, false);
  assert.ok(result.records.every((record) => record.evidenceClass === "assertion" && record.freshness === "fresh"));
});

test("serializes concurrent writes within one server process", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  await Promise.all(Array.from({ length: 20 }, (_, index) => store.record({
    workspaceRoot: root, kind: "fact", content: `concurrent marker-${index}`, paths: [],
  })));
  const result = await store.search({ workspaceRoot: root, query: "concurrent", limit: 20 });
  assert.equal(result.records.length, 20);
  assert.equal(result.truncated, false);
});

test("ranks distinct term matches before recency and proves truncation with an extra match", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  await store.record({ workspaceRoot: root, kind: "fact", content: "alpha beta", paths: [] });
  await store.record({ workspaceRoot: root, kind: "fact", content: "newer alpha", paths: [] });
  await store.record({ workspaceRoot: root, kind: "lesson", content: "latest alpha", paths: [] });
  const result = await store.search({ workspaceRoot: root, query: "alpha beta", limit: 2 });

  assert.equal(result.records[0]?.content, "alpha beta");
  assert.equal(result.records.length, 2);
  assert.equal(result.truncated, true);
});

test("supersedes only a current record in the same project", async (t) => {
  const { root, dataRoot, store } = await fixture();
  const other = await mkdtemp(join(tmpdir(), "project-memory-other-"));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  const original = await store.record({ workspaceRoot: root, kind: "decision", content: "use alpha", paths: [] });
  const replacement = await store.record({ workspaceRoot: root, kind: "decision", content: "use beta", paths: [], supersedes: original.id });
  const result = await store.search({ workspaceRoot: root, query: "use", limit: 8 });
  assert.deepEqual(result.records.map((record) => record.id), [replacement.id]);
  await assert.rejects(store.record({ workspaceRoot: root, kind: "decision", content: "use gamma", paths: [], supersedes: original.id }), /current memory/i);
  await assert.rejects(store.record({ workspaceRoot: other, kind: "decision", content: "other", paths: [], supersedes: replacement.id }), /current memory/i);
});

test("canonicalizes workspace aliases and isolates different projects", async (t) => {
  const { root, dataRoot, store } = await fixture();
  const alias = `${root}-alias`;
  const other = await mkdtemp(join(tmpdir(), "project-memory-other-"));
  await symlink(root, alias);
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(alias, { force: true }), rm(other, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  await store.record({ workspaceRoot: alias, kind: "fact", content: "shared alias memory", paths: [] });
  assert.equal((await store.search({ workspaceRoot: root, query: "alias", limit: 8 })).records.length, 1);
  assert.equal((await store.search({ workspaceRoot: other, query: "alias", limit: 8 })).records.length, 0);
});

test("confines associated paths including symlink escapes while allowing future in-workspace paths", async (t) => {
  const { root, dataRoot, store } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "project-memory-outside-"));
  await mkdir(join(root, "src"));
  await symlink(outside, join(root, "escape"));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  const record = await store.record({ workspaceRoot: root, kind: "constraint", content: "keep module local", paths: ["src/future.ts"] });
  assert.deepEqual(record.paths, ["src/future.ts"]);
  assert.deepEqual((await store.record({ workspaceRoot: root, kind: "fact", content: "valid dot path", paths: ["..foo"] })).paths, ["..foo"]);
  await assert.rejects(store.record({ workspaceRoot: root, kind: "fact", content: "bad path", paths: ["../outside"] }), /path/i);
  await assert.rejects(store.record({ workspaceRoot: root, kind: "fact", content: "bad link", paths: ["escape/secret.txt"] }), /path/i);
});

test("rejects recognizable secrets without echoing them", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  const secret = `ghp_${"a".repeat(36)}`;

  await assert.rejects(
    store.record({ workspaceRoot: root, kind: "fact", content: `token ${secret}`, paths: [] }),
    (error: Error) => error.message.includes("secret") && !error.message.includes(secret),
  );
  assert.equal((await store.search({ workspaceRoot: root, query: "token", limit: 8 })).records.length, 0);
});

test("rejects already-cancelled operations", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.record({ workspaceRoot: root, kind: "fact", content: "never stored", paths: [] }, controller.signal), /cancel/i);
});

test("fails closed on malformed and oversized project stores", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  const canonical = await realpath(root);
  const file = join(dataRoot, `${createHash("sha256").update(canonical).digest("hex")}.json`);
  await mkdir(dataRoot, { recursive: true });
  await writeFile(file, "not-json", { mode: 0o600 });
  await assert.rejects(store.search({ workspaceRoot: root, query: "anything", limit: 8 }), /store/i);
  await writeFile(file, JSON.stringify({ version: 1, workspace: canonical, records: [{ id: 42 }] }), { mode: 0o600 });
  await assert.rejects(store.search({ workspaceRoot: root, query: "anything", limit: 8 }), /store/i);
  await writeFile(file, JSON.stringify({ version: 1, workspace: canonical, records: [{
    id: "malformed", kind: "fact", content: "", paths: ["../outside"], createdAt: -1, status: "current", evidenceClass: "assertion",
  }] }), { mode: 0o600 });
  await assert.rejects(store.search({ workspaceRoot: root, query: "outside", limit: 8 }), /store/i);
  await writeFile(file, "x".repeat(5 * 1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(store.search({ workspaceRoot: root, query: "anything", limit: 8 }), /store/i);
});

test("bounds a project to 1000 historical records without evicting knowledge", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  for (let i = 0; i < 1000; i += 1) {
    await store.record({ workspaceRoot: root, kind: "fact", content: `bounded memory ${i}`, paths: [] });
  }
  await assert.rejects(store.record({ workspaceRoot: root, kind: "fact", content: "one too many", paths: [] }), /limit/i);
  const file = join(dataRoot, `${createHash("sha256").update(await realpath(root)).digest("hex")}.json`);
  assert.equal((JSON.parse(await readFile(file, "utf8")) as { records: unknown[] }).records.length, 1000);
});
