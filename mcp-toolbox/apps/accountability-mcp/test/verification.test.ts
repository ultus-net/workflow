import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VerificationStore, type VerificationAuthorities } from "../src/verification.js";

function authorities(): VerificationAuthorities {
  return {
    runTests: async () => ({ outcome: "completed", exitCode: 0, tests: [{ status: "passed" }, { status: "passed" }, { status: "passed" }], testsTruncated: false, failures: [], failuresTruncated: false, diagnosticsTruncated: false }),
    listCiRuns: async ({ revision }) => ({ runs: [{ id: "github:123", revision: revision ?? "a".repeat(40), state: "completed", conclusion: "success" }], truncated: false }),
    runBrowserVerification: async ({ url }) => ({ outcome: "passed", url, origin: new URL(url).origin, pageHash: "e".repeat(64), passed: 2, failed: 0, truncated: false, evidenceId: "0f9c1f3a-1111-4222-8333-444455556666", evidenceHash: "f".repeat(64), observedAt: 1_700_000_000_000 }),
    ciRepository: () => "owner/repo",
  };
}
async function fixture(custom = authorities()) {
  const root = await mkdtemp(join(tmpdir(), "verification-workspace-")); const dataRoot = await mkdtemp(join(tmpdir(), "verification-data-"));
  return { root, dataRoot, store: new VerificationStore(dataRoot, custom), authority: custom };
}

test("keeps local test freshness unknown after an actual workspace mutation", async (t) => {
  const { root, dataRoot, store, authority } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  await writeFile(join(root, "subject.ts"), "export const value = 1;\n");
  await store.recordVerification({ workspaceRoot: root, request: { kind: "local_test", testIds: ["node:test/example.test.ts"] } });
  await writeFile(join(root, "subject.ts"), "export const value = 2;\n");
  const listed = await new VerificationStore(dataRoot, authority).listVerifications({ workspaceRoot: root, currentSubject: { kind: "fingerprint", algorithm: "sha256", version: "1", scope: "worktree", value: "b".repeat(64) } });
  assert.equal(listed.observations[0]?.evidenceClass, "observation"); assert.equal(listed.observations[0]?.freshness, "unknown");
  assert.equal(listed.observations[0]?.subject.kind, "local_test_execution"); assert.deepEqual(listed.observations[0]?.result, { outcome: "completed", exitCode: 0, passed: 3, failed: 0, skipped: 0, todo: 0, testsTruncated: false, failuresTruncated: false, diagnosticsTruncated: false });
});

test("marks authority-returned CI evidence fresh or stale only for the same provider repository", async (t) => {
  const { root, dataRoot, store } = await fixture(); t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  const revision = "a".repeat(40); await store.recordVerification({ workspaceRoot: root, request: { kind: "ci_run", runId: "github:123", revision } });
  assert.equal((await store.listVerifications({ workspaceRoot: root, currentSubject: { kind: "ci_revision", provider: "github", repository: "owner/repo", revision } })).observations[0]?.freshness, "fresh");
  assert.equal((await store.listVerifications({ workspaceRoot: root, currentSubject: { kind: "ci_revision", provider: "github", repository: "owner/repo", revision: "b".repeat(40) } })).observations[0]?.freshness, "stale");
  assert.equal((await store.listVerifications({ workspaceRoot: root, currentSubject: { kind: "ci_revision", provider: "github", repository: "other/repo", revision } })).observations[0]?.freshness, "unknown");
});

test("rejects CI identifiers and revisions not established by the authority", async (t) => {
  const custom = authorities(); custom.listCiRuns = async () => ({ runs: [{ id: "github:7", revision: "b".repeat(40), state: "completed", conclusion: "success" }], truncated: false });
  const { root, dataRoot, store } = await fixture(custom); t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  await assert.rejects(store.recordVerification({ workspaceRoot: root, request: { kind: "ci_run", runId: "github:8" } }), /not found/i);
  await assert.rejects(store.recordVerification({ workspaceRoot: root, request: { kind: "ci_run", runId: "github:7", revision: "a".repeat(40) } }), /mismatched revision/i);
});

test("preserves failed and partial authority observations", async (t) => {
  const custom = authorities(); custom.runTests = async () => ({ outcome: "completed", exitCode: 1, tests: [{ status: "passed" }, { status: "failed" }], testsTruncated: true, failures: [{}], failuresTruncated: true, diagnosticsTruncated: true });
  const { root, dataRoot, store } = await fixture(custom); t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  const recorded = await store.recordVerification({ workspaceRoot: root, request: { kind: "local_test", testIds: ["node:test/a.test.ts"] } });
  assert.deepEqual(recorded.result, { outcome: "completed", exitCode: 1, passed: 1, failed: 1, skipped: 0, todo: 0, testsTruncated: true, failuresTruncated: true, diagnosticsTruncated: true }); assert.equal(recorded.freshness, "unknown");
});

test("isolates observations by canonical workspace and bounds retrieval", async (t) => {
  const { root, dataRoot, store } = await fixture(); const other = await mkdtemp(join(tmpdir(), "verification-other-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  for (let index = 0; index < 3; index += 1) await store.recordVerification({ workspaceRoot: root, request: { kind: "local_test", testIds: [`node:test/${index}.test.ts`] } });
  const bounded = await store.listVerifications({ workspaceRoot: root, limit: 2 }); assert.equal(bounded.observations.length, 2); assert.equal(bounded.truncated, true); assert.equal((await store.listVerifications({ workspaceRoot: other })).observations.length, 0);
});

test("fails closed when durable provenance is malformed or mismatched", async (t) => {
  const { root, dataRoot, store, authority } = await fixture(); t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  await store.recordVerification({ workspaceRoot: root, request: { kind: "ci_run", runId: "github:123" } });
  const [file] = await readdir(dataRoot); assert.ok(file); const path = join(dataRoot, file); const document = JSON.parse(await readFile(path, "utf8")) as { observations: Array<{ source: { runId: string }; subject: { revision: string } }> };
  document.observations[0]!.source.runId = "forged"; await writeFile(path, JSON.stringify(document)); await assert.rejects(new VerificationStore(dataRoot, authority).listVerifications({ workspaceRoot: root }), /malformed or unreadable/i);
});

test("fails closed when durable results claim states the authorities cannot produce", async (t) => {
  const { root, dataRoot, store, authority } = await fixture(); t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  await store.recordVerification({ workspaceRoot: root, request: { kind: "local_test", testIds: ["node:test/a.test.ts"] } });
  const [file] = await readdir(dataRoot); assert.ok(file); const path = join(dataRoot, file); const document = JSON.parse(await readFile(path, "utf8")) as { observations: Array<{ result: { passed: number } }> };
  document.observations[0]!.result.passed = 1001; await writeFile(path, JSON.stringify(document)); await assert.rejects(new VerificationStore(dataRoot, authority).listVerifications({ workspaceRoot: root }), /malformed or unreadable/i);
});

test("fails closed on impossible durable truncation and test ID provenance", async (t) => {
  const { root, dataRoot, store, authority } = await fixture(); t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  await store.recordVerification({ workspaceRoot: root, request: { kind: "local_test", testIds: ["node:test/a.test.ts"] } });
  const [file] = await readdir(dataRoot); assert.ok(file); const path = join(dataRoot, file); const original = await readFile(path, "utf8");
  const badTruncation = JSON.parse(original) as { observations: Array<{ result: { failuresTruncated: boolean; diagnosticsTruncated: boolean } }> }; badTruncation.observations[0]!.result.failuresTruncated = true; badTruncation.observations[0]!.result.diagnosticsTruncated = false;
  await writeFile(path, JSON.stringify(badTruncation)); await assert.rejects(new VerificationStore(dataRoot, authority).listVerifications({ workspaceRoot: root }), /malformed or unreadable/i);
  for (const testId of ["node:not-a-test-file.ts", "node:test//a.test.ts", "node:test/./a.test.ts"]) {
    const badId = JSON.parse(original) as { observations: Array<{ source: { testIds: string[] } }> }; badId.observations[0]!.source.testIds = [testId];
    await writeFile(path, JSON.stringify(badId)); await assert.rejects(new VerificationStore(dataRoot, authority).listVerifications({ workspaceRoot: root }), /malformed or unreadable/i);
  }
});

test("admits browser evidence from the browser authority with observed page identity and freshness", async (t) => {
  const { root, dataRoot, store } = await fixture(); t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  const url = "https://app.test/";
  const recorded = await store.recordVerification({ workspaceRoot: root, request: { kind: "browser_verification", url, assertions: [{ kind: "text_visible", text: "Hello" }] } });
  assert.equal(recorded.source.kind, "browser_verification");
  if (recorded.source.kind !== "browser_verification") throw new Error("unreachable");
  assert.equal(recorded.source.capability, "browser-verification-mcp/run_verification");
  assert.equal(recorded.source.evidenceId, "0f9c1f3a-1111-4222-8333-444455556666");
  assert.equal(recorded.source.evidenceHash, "f".repeat(64));
  assert.equal(recorded.source.observedAt, 1_700_000_000_000);
  assert.equal(recorded.subject.kind, "browser_page");
  assert.deepEqual(recorded.result, { outcome: "passed", passed: 2, failed: 0, truncated: false });
  assert.equal((await store.listVerifications({ workspaceRoot: root, currentSubject: { kind: "browser_page", url, pageHash: "e".repeat(64) } })).observations[0]?.freshness, "fresh");
  assert.equal((await store.listVerifications({ workspaceRoot: root, currentSubject: { kind: "browser_page", url, pageHash: "a".repeat(64) } })).observations[0]?.freshness, "stale");
  assert.equal((await store.listVerifications({ workspaceRoot: root, currentSubject: { kind: "browser_page", url: "https://other.test/", pageHash: "e".repeat(64) } })).observations[0]?.freshness, "unknown");
});

test("rejects browser identity the authority cannot establish and caller-supplied result claims", async (t) => {
  const custom = authorities();
  custom.runBrowserVerification = async ({ url }) => ({ outcome: "passed", url, origin: new URL(url).origin, pageHash: "not-a-hash", passed: 1, failed: 0, truncated: false, evidenceId: "0f9c1f3a-1111-4222-8333-444455556666", evidenceHash: "f".repeat(64), observedAt: 1_700_000_000_000 });
  const { root, dataRoot, store } = await fixture(custom); t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  await assert.rejects(store.recordVerification({ workspaceRoot: root, request: { kind: "browser_verification", url: "https://app.test/", assertions: [] } }), /invalid page identity/i);
  await assert.rejects(store.recordVerification({ workspaceRoot: root, request: { kind: "browser_verification", url: "file:///etc/passwd", assertions: [] } }), /URL is invalid/i);
  await assert.rejects(store.recordVerification({ workspaceRoot: root, request: { kind: "browser_verification", url: "https://app.test/", assertions: Array.from({ length: 21 }, () => ({ kind: "element_exists" })) } }), /assertions are invalid/i);
});

test("fails closed when durable browser evidence is tampered with", async (t) => {
  const { root, dataRoot, store, authority } = await fixture(); t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  await store.recordVerification({ workspaceRoot: root, request: { kind: "browser_verification", url: "https://app.test/", assertions: [] } });
  const [file] = await readdir(dataRoot); assert.ok(file); const path = join(dataRoot, file); const document = JSON.parse(await readFile(path, "utf8")) as { observations: Array<{ subject: { pageHash: string }; source: { evidenceHash: string } }> };
  // The store validates shape, never truth: a different but well-formed page
  // hash is admissible provenance, while malformed identity/hash fields fail closed.
  document.observations[0]!.subject.pageHash = "not-a-hash";
  await writeFile(path, JSON.stringify(document));
  await assert.rejects(new VerificationStore(dataRoot, authority).listVerifications({ workspaceRoot: root }), /malformed or unreadable/i);
  document.observations[0]!.subject.pageHash = "e".repeat(64); document.observations[0]!.source.evidenceHash = "forged";
  await writeFile(path, JSON.stringify(document));
  await assert.rejects(new VerificationStore(dataRoot, authority).listVerifications({ workspaceRoot: root }), /malformed or unreadable/i);
});
