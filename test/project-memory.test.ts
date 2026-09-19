import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createProjectMemoryClient, formatMemoryRecall, type MemoryStampConfig } from "../src/integrations/project-memory.js";

const serverScript = resolve("mcp-toolbox/apps/project-memory-mcp/dist/server.js");
const STAMP: MemoryStampConfig = { writer: "workflow-compaction-bridge", authority: "agent", originSurface: "workflow:cline-runtime" };

function memoryClient(dataDir: string, stamp?: MemoryStampConfig) {
  return createProjectMemoryClient({
    serverScript,
    workspaceRoot: process.cwd(),
    dataDir,
    ...(stamp === undefined ? {} : { stamp }),
  });
}

test("project memory client records and recalls workspace facts with provenance stamps", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-memory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const memory = await memoryClient(dir, STAMP);
  t.after(() => memory.close());

  await memory.record("decision", "Use atomic writes for the hub discovery file", ["src/integrations/workflow-hub.ts"]);
  await memory.record("constraint", "Kernel stays deterministic: no LLM or IO", []);

  const records = await memory.recall("atomic writes", 8);
  assert.ok(records.length >= 1);
  assert.equal(records[0]!.content, "Use atomic writes for the hub discovery file");
  assert.equal(records[0]!.kind, "decision");
  assert.equal(records[0]!.provenance.writer, STAMP.writer);
  assert.equal(records[0]!.provenance.authority, STAMP.authority);
  assert.equal(records[0]!.provenance.originSurface, STAMP.originSurface);
  assert.ok(Number.isSafeInteger(records[0]!.provenance.stampedAt));
});

test("the client surfaces the server's loud refusal when no stamp is configured", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-memory-unstamped-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const memory = await memoryClient(dir);
  t.after(() => memory.close());

  await assert.rejects(memory.record("fact", "must not persist"), /provenance stamp/i);
});

test("formatMemoryRecall renders a bounded, provenance-tagged prompt block", () => {
  const long = "y".repeat(5_000);
  const block = formatMemoryRecall([
    { id: "1", kind: "fact", content: "short fact", paths: [], createdAt: 1, status: "current", evidenceClass: "assertion", freshness: "fresh", provenance: { origin: "test", workspace: "/w" } },
    { id: "2", kind: "lesson", content: long, paths: [], createdAt: 2, status: "current", evidenceClass: "assertion", freshness: "fresh", provenance: { origin: "test", workspace: "/w" } },
  ], { maxChars: 300 });

  assert.match(block, /project memory/i);
  assert.match(block, /assertion|untrusted/i);
  assert.match(block, /short fact/);
  assert.ok(block.length <= 400, `expected a bounded block, got ${block.length} chars`);
  assert.equal(formatMemoryRecall([], { maxChars: 300 }), "");
});