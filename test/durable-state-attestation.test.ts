import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  attestDurableState,
  attestProjectMemory,
  collectProjectMemoryRecords,
  DEFAULT_DURABLE_STATE_CANARY,
  defaultAttestationPolicy,
  formatAttestationReport,
  memoryRecallAllowed,
  type AttestationPolicy,
} from "../src/integrations/durable-state-attestation.js";

const POLICY: AttestationPolicy = {
  trustedWriters: ["workflow-compaction-bridge"],
  trustedOrigins: ["workflow:cline-runtime"],
  canaries: [DEFAULT_DURABLE_STATE_CANARY],
};

const GOOD_STAMP = {
  origin: "project-memory-mcp/record_memory",
  writer: "workflow-compaction-bridge",
  authority: "agent" as const,
  originSurface: "workflow:cline-runtime",
  stampedAt: 1_700_000_000_000,
};

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "w054-workspace-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "w054-data-"));
  const canonical = await realpath(workspace);
  const file = join(dataRoot, `${createHash("sha256").update(canonical).digest("hex")}.json`);
  return { workspace, dataRoot, file };
}

function storeDocument(workspace: string, records: readonly unknown[]): string {
  return JSON.stringify({ version: 1, workspace, records });
}

async function writeStore(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents, { mode: 0o600 });
}

test("rule engine classifies missing stamps, unexpected writers, untrusted origins, and canaries", () => {
  const trusted = attestDurableState([
    { source: "project-memory", id: "clean", content: "ordinary durable fact", ...GOOD_STAMP },
  ], POLICY);
  assert.equal(trusted.checked, 1);
  assert.deepEqual(trusted.findings, []);
  assert.equal(memoryRecallAllowed({ checked: 1, findings: [], flagged: false, storePresent: true }), true);

  const flagged = attestDurableState([
    { source: "project-memory", id: "unstamped", content: "no stamp" },
    { source: "project-memory", id: "forged-writer", content: "forged", ...GOOD_STAMP, writer: "attacker" },
    { source: "project-memory", id: "foreign-origin", content: "foreign", ...GOOD_STAMP, originSurface: "external:web" },
    { source: "project-memory", id: "canary", content: `poisoned ${DEFAULT_DURABLE_STATE_CANARY} instruction`, ...GOOD_STAMP },
  ], POLICY);

  assert.deepEqual(flagged.findings.map((finding) => finding.kind).sort(), [
    "canary-hit", "missing-stamp", "unexpected-writer", "untrusted-origin",
  ]);
  assert.equal(memoryRecallAllowed({ checked: 4, findings: flagged.findings, flagged: true, storePresent: true }), false);
});

test("startup attestation flags a poisoned project-memory fixture before first turn", async (t) => {
  const { workspace, dataRoot, file } = await fixture();
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  await writeStore(file, storeDocument(workspace, [
    {
      id: "legit", kind: "decision", content: "atomic writes are required", paths: [], createdAt: 1,
      status: "current", evidenceClass: "assertion", provenance: { ...GOOD_STAMP },
    },
    {
      id: "poisoned", kind: "lesson", content: `[PROMPT_INJECTION] and ${DEFAULT_DURABLE_STATE_CANARY}`, paths: [], createdAt: 2,
      status: "current", evidenceClass: "assertion",
      provenance: { ...GOOD_STAMP, writer: "attacker", originSurface: "external:web", stampedAt: 3 },
    },
  ]));

  const attestation = await attestProjectMemory({ dataRoot, workspaceRoot: workspace, policy: POLICY });
  assert.equal(attestation.storePresent, true);
  assert.equal(attestation.checked, 2);
  assert.equal(attestation.flagged, true);
  const kinds = attestation.findings.map((finding) => finding.kind);
  assert.ok(kinds.includes("canary-hit"), `expected canary-hit, got ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes("unexpected-writer"));
  assert.ok(kinds.includes("untrusted-origin"));
  assert.ok(!attestation.findings.some((finding) => finding.recordId === "legit"), "the clean record must not be flagged");
  assert.equal(memoryRecallAllowed(attestation), false);

  const report = formatAttestationReport(attestation);
  assert.match(report, /advisory/i);
  assert.ok(!report.includes(DEFAULT_DURABLE_STATE_CANARY), "report must not echo canary values");
});

test("a legacy unstamped store and an unreadable store are flagged, not silently accepted", async (t) => {
  const { workspace, dataRoot, file } = await fixture();
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  await writeStore(file, storeDocument(workspace, [
    { id: "legacy", kind: "fact", content: "pre-W054 record", paths: [], createdAt: 1, status: "current", evidenceClass: "assertion" },
  ]));
  const legacy = await attestProjectMemory({ dataRoot, workspaceRoot: workspace, policy: POLICY });
  assert.equal(legacy.flagged, true);
  assert.deepEqual(legacy.findings.map((finding) => finding.kind), ["missing-stamp"]);

  await writeStore(file, "not-json");
  const unreadable = await attestProjectMemory({ dataRoot, workspaceRoot: workspace, policy: POLICY });
  assert.equal(unreadable.flagged, true);
  assert.deepEqual(unreadable.findings.map((finding) => finding.kind), ["unreadable-store"]);
});

test("a clean stamped store is admitted and an absent store is a clean no-op", async (t) => {
  const { workspace, dataRoot, file } = await fixture();
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  const absent = await attestProjectMemory({ dataRoot, workspaceRoot: workspace, policy: POLICY });
  assert.equal(absent.storePresent, false);
  assert.equal(absent.flagged, false);

  await writeStore(file, storeDocument(workspace, [
    {
      id: "clean", kind: "constraint", content: "kernel stays deterministic", paths: [], createdAt: 1,
      status: "current", evidenceClass: "assertion", provenance: { ...GOOD_STAMP },
    },
  ]));
  const clean = await attestProjectMemory({ dataRoot, workspaceRoot: workspace, policy: POLICY });
  assert.equal(clean.flagged, false);
  assert.equal(clean.checked, 1);
  assert.equal(memoryRecallAllowed(clean), true);
});

test("the collector normalizes stamped and unstamped records without throwing", async (t) => {
  const { workspace, dataRoot, file } = await fixture();
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  await writeStore(file, storeDocument(workspace, [
    { id: "a", content: "stamped", provenance: { ...GOOD_STAMP } },
    { id: "b", content: "unstamped" },
  ]));
  const collected = await collectProjectMemoryRecords(dataRoot, workspace);
  assert.equal(collected.storePresent, true);
  const stamped = collected.records.find((record) => record.id === "a");
  assert.equal(stamped?.writer, GOOD_STAMP.writer);
  assert.equal(stamped?.stampedAt, GOOD_STAMP.stampedAt);
  const unstamped = collected.records.find((record) => record.id === "b");
  assert.equal(unstamped?.writer, undefined);
  assert.equal(unstamped?.stampedAt, undefined);
});

test("default policy trusts the Workflow surfaces and adds operator canaries", () => {
  const policy = defaultAttestationPolicy({ WORKFLOW_DURABLE_STATE_CANARIES: "extra-canary, another" });
  assert.ok(policy.trustedWriters.includes("workflow-compaction-bridge"));
  assert.ok(policy.trustedOrigins.includes("workflow:cline-runtime"));
  assert.ok(policy.canaries.includes(DEFAULT_DURABLE_STATE_CANARY));
  assert.ok(policy.canaries.includes("extra-canary"));
  assert.ok(policy.canaries.includes("another"));
});