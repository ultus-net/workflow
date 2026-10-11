import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_RETENTION_DAYS, DAY_MS, ProjectMemoryStore, resolveRetentionWindowMs, type MemoryStampConfig } from "../src/project-memory.js";

const STAMP: MemoryStampConfig = { writer: "test-harness", authority: "agent", originSurface: "test:memory" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "project-memory-workspace-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "project-memory-data-"));
  return { root, dataRoot, store: new ProjectMemoryStore(dataRoot, STAMP) };
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

test("stamps every record with writer, authority, origin surface, and timestamp across reloads", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  const record = await store.record({ workspaceRoot: root, kind: "decision", content: "stamped durable memory", paths: [] });
  assert.equal(record.provenance.origin, "project-memory-mcp/record_memory");
  assert.equal(record.provenance.writer, STAMP.writer);
  assert.equal(record.provenance.authority, STAMP.authority);
  assert.equal(record.provenance.originSurface, STAMP.originSurface);
  assert.ok(Number.isSafeInteger(record.provenance.stampedAt) && record.provenance.stampedAt > 0);

  const reloaded = await new ProjectMemoryStore(dataRoot).search({ workspaceRoot: root, query: "stamped", limit: 8 });
  assert.deepEqual(reloaded.records[0]?.provenance, { ...record.provenance, workspace: await realpath(root) });
});

test("fails loudly when a write has no provenance stamp", async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  const unstamped = new ProjectMemoryStore(dataRoot);
  await assert.rejects(
    unstamped.record({ workspaceRoot: root, kind: "fact", content: "must not persist", paths: [] }),
    /provenance stamp/i,
  );
  const file = join(dataRoot, `${createHash("sha256").update(await realpath(root)).digest("hex")}.json`);
  await assert.rejects(readFile(file, "utf8"), /ENOENT/);
});

test("fails closed when a store holds an unstamped legacy or forged record", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  const canonical = await realpath(root);
  const file = join(dataRoot, `${createHash("sha256").update(canonical).digest("hex")}.json`);
  await mkdir(dataRoot, { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, workspace: canonical, records: [{
    id: "legacy", kind: "fact", content: "no stamp", paths: [], createdAt: 1, status: "current", evidenceClass: "assertion",
  }] }), { mode: 0o600 });

  await assert.rejects(store.search({ workspaceRoot: root, query: "stamp", limit: 8 }), /store/i);
  await assert.rejects(store.record({ workspaceRoot: root, kind: "fact", content: "cannot append", paths: [] }), /store/i);
});

test("resolves the retention window from the environment with a bounded default", () => {
  assert.equal(resolveRetentionWindowMs({}), DEFAULT_RETENTION_DAYS * DAY_MS);
  assert.equal(resolveRetentionWindowMs({ PROJECT_MEMORY_RETENTION_DAYS: "30" }), 30 * DAY_MS);
  // Zero, negative, and malformed values fall back to the default, never to
  // "keep forever": retention always has a floor.
  assert.equal(resolveRetentionWindowMs({ PROJECT_MEMORY_RETENTION_DAYS: "0" }), DEFAULT_RETENTION_DAYS * DAY_MS);
  assert.equal(resolveRetentionWindowMs({ PROJECT_MEMORY_RETENTION_DAYS: "-5" }), DEFAULT_RETENTION_DAYS * DAY_MS);
  assert.equal(resolveRetentionWindowMs({ PROJECT_MEMORY_RETENTION_DAYS: "soon" }), DEFAULT_RETENTION_DAYS * DAY_MS);
});

test("prunes superseded records past the retention window while keeping current ones", async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  const canonical = await realpath(root);
  const file = join(dataRoot, `${createHash("sha256").update(canonical).digest("hex")}.json`);
  const stamp = { origin: "project-memory-mcp/record_memory", writer: STAMP.writer, authority: STAMP.authority, originSurface: STAMP.originSurface, stampedAt: 1 };
  const now = Date.now();
  const stale = now - 100 * DAY_MS;
  const recent = now - 1 * DAY_MS;
  await mkdir(dataRoot, { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, workspace: canonical, records: [
    { id: "expired", kind: "fact", content: "old and superseded", paths: [], createdAt: stale, status: "superseded", supersededAt: stale, evidenceClass: "assertion", provenance: stamp },
    { id: "recent", kind: "fact", content: "recently superseded", paths: [], createdAt: recent, status: "superseded", supersededAt: recent, evidenceClass: "assertion", provenance: stamp },
    { id: "current", kind: "fact", content: "still current knowledge", paths: [], createdAt: stale, status: "current", evidenceClass: "assertion", provenance: stamp },
  ] }), { mode: 0o600 });

  const store = new ProjectMemoryStore(dataRoot, STAMP);
  const searched = await store.search({ workspaceRoot: root, query: "knowledge", limit: 8 });
  assert.deepEqual(searched.records.map((record) => record.id), ["current"]);

  const persisted = JSON.parse(await readFile(file, "utf8")) as { records: Array<{ id: string }> };
  assert.deepEqual(persisted.records.map((record) => record.id).sort(), ["current", "recent"]);
});

test("a shortened retention window prunes on the next mutation", async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  const store = new ProjectMemoryStore(dataRoot, STAMP, 1 * DAY_MS);
  const original = await store.record({ workspaceRoot: root, kind: "decision", content: "use alpha", paths: [] });
  await store.record({ workspaceRoot: root, kind: "decision", content: "use beta", paths: [], supersedes: original.id });

  // Backdate the supersession past the 1-day window, then mutate to trigger
  // retention and confirm the superseded record is gone.
  const canonical = await realpath(root);
  const file = join(dataRoot, `${createHash("sha256").update(canonical).digest("hex")}.json`);
  const document = JSON.parse(await readFile(file, "utf8")) as { records: Array<{ id: string; supersededAt?: number }> };
  for (const record of document.records) record.supersededAt = Date.now() - 3 * DAY_MS;
  await writeFile(file, JSON.stringify(document), { mode: 0o600 });

  await store.record({ workspaceRoot: root, kind: "fact", content: "unrelated trigger", paths: [] });
  const persisted = JSON.parse(await readFile(file, "utf8")) as { records: Array<{ status: string }> };
  assert.equal(persisted.records.some((record) => record.status === "superseded"), false);
});

test("exports current records to the portable JSONL and re-imports them by id", async (t) => {
  const { root, dataRoot, store } = await fixture();
  const destination = await mkdtemp(join(tmpdir(), "project-memory-import-"));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true }), rm(destination, { recursive: true, force: true })]));

  const record = await store.record({ workspaceRoot: root, kind: "constraint", content: "stay local by default", paths: ["src/a.ts"] });
  const exported = await store.export({ workspaceRoot: root });
  assert.equal(exported.exported, 1);
  assert.equal(exported.path, join(await realpath(root), ".opencode", "memory", "project-memory.jsonl"));
  const lines = (await readFile(exported.path, "utf8")).trim().split("\n");
  assert.deepEqual(JSON.parse(lines[0]!) as Record<string, unknown>, { id: record.id, kind: "constraint", content: "stay local by default", paths: ["src/a.ts"] });

  // A second workspace imports the portable file into its own index.
  const importer = new ProjectMemoryStore(destination, STAMP);
  const imported = await importer.import({ workspaceRoot: root });
  assert.deepEqual(imported, { imported: 1, skipped: 0, rejected: 0, path: exported.path });
  const found = await importer.search({ workspaceRoot: root, query: "local", limit: 8 });
  assert.equal(found.records[0]?.id, record.id);
  assert.equal(found.records[0]?.provenance.origin, "project-memory-mcp/import_memory");

  // Re-import is idempotent: the id already exists, so it is skipped.
  assert.deepEqual(await importer.import({ workspaceRoot: root }), { imported: 0, skipped: 1, rejected: 0, path: exported.path });
});

test("import rejects secret-shaped, malformed, and workspace-escaping lines", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  const portable = join(root, ".opencode", "memory", "project-memory.jsonl");
  await mkdir(join(root, ".opencode", "memory"), { recursive: true });
  const secret = `ghp_${"a".repeat(36)}`;
  await writeFile(portable, [
    JSON.stringify({ id: "ok", kind: "fact", content: "clean import", paths: [] }),
    JSON.stringify({ id: "secret", kind: "fact", content: `token ${secret}`, paths: [] }),
    "not-json",
    JSON.stringify({ id: "bad-path", kind: "fact", content: "escape", paths: ["../outside"] }),
    JSON.stringify({ id: "bad-kind", kind: "rumor", content: "invalid kind", paths: [] }),
  ].join("\n") + "\n", { mode: 0o600 });

  const result = await store.import({ workspaceRoot: root });
  assert.deepEqual(result, { imported: 1, skipped: 0, rejected: 4, path: portable });
  const found = await store.search({ workspaceRoot: root, query: "import", limit: 8 });
  assert.deepEqual(found.records.map((record) => record.id), ["ok"]);
});

test("export and import refuse portable paths outside the workspace", async (t) => {
  const { root, dataRoot, store } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "project-memory-outside-"));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  await store.record({ workspaceRoot: root, kind: "fact", content: "safe content", paths: [] });
  await assert.rejects(store.export({ workspaceRoot: root, path: "../escape.jsonl" }), /inside the workspace/i);
  await assert.rejects(store.export({ workspaceRoot: root, path: join(outside, "escape.jsonl") }), /inside the workspace/i);
  await assert.rejects(store.import({ workspaceRoot: root, path: "../escape.jsonl" }), /inside the workspace/i);
  await assert.rejects(store.import({ workspaceRoot: root, path: join(outside, "portable.jsonl") }), /inside the workspace/i);
});
