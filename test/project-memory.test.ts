import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createProjectMemoryClient, formatMemoryRecall } from "../src/integrations/project-memory.js";

const serverScript = resolve("mcp-toolbox/apps/project-memory-mcp/dist/server.js");

function memoryClient(dataDir: string) {
  return createProjectMemoryClient({ serverScript, workspaceRoot: process.cwd(), dataDir });
}

test("project memory client records and recalls workspace facts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-memory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const memory = await memoryClient(dir);
  t.after(() => memory.close());

  await memory.record("decision", "Use atomic writes for the hub discovery file", ["src/integrations/workflow-hub.ts"]);
  await memory.record("constraint", "Kernel stays deterministic: no LLM or IO", []);

  const records = await memory.recall("atomic writes", 8);
  assert.ok(records.length >= 1);
  assert.equal(records[0]!.content, "Use atomic writes for the hub discovery file");
  assert.equal(records[0]!.kind, "decision");
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
