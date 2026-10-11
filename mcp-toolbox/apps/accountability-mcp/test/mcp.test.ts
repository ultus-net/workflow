import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const reviewSubject = { kind: "fingerprint", algorithm: "sha256", version: "1", scope: "review-diff", value: "a".repeat(64) };
const fakeAuthority = join(process.cwd(), "test", "fake-authority.mjs");

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "accountability-mcp-workspace-"));
  const reviewData = await mkdtemp(join(tmpdir(), "accountability-mcp-review-data-"));
  const verificationData = await mkdtemp(join(tmpdir(), "accountability-mcp-verification-data-"));
  const client = new Client({ name: "accountability-black-box-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      // The merged server's own data roots stay independent per subsystem.
      REVIEW_ACCOUNTABILITY_DATA_DIR: reviewData,
      VERIFICATION_ACCOUNTABILITY_DATA_DIR: verificationData,
      // Exercise the merged server's own authority env names.
      ACCOUNTABILITY_TEST_COMMAND: process.execPath,
      ACCOUNTABILITY_TEST_ARGS: JSON.stringify([fakeAuthority]),
      ACCOUNTABILITY_CI_COMMAND: process.execPath,
      ACCOUNTABILITY_CI_ARGS: JSON.stringify([fakeAuthority]),
      ACCOUNTABILITY_BROWSER_COMMAND: process.execPath,
      ACCOUNTABILITY_BROWSER_ARGS: JSON.stringify([fakeAuthority]),
      CI_GITHUB_REPOSITORY: "owner/repo",
    },
  }));
  return { workspace, reviewData, verificationData, client };
}

function cleanup(workspace: string, reviewData: string, verificationData: string) {
  return Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(reviewData, { recursive: true, force: true }),
    rm(verificationData, { recursive: true, force: true }),
  ]);
}

test("compiled merged server exposes both subsystems' tools under one catalog", async (t) => {
  const { workspace, reviewData, verificationData, client } = await fixture();
  t.after(async () => { await client.close(); await cleanup(workspace, reviewData, verificationData); });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name), ["record_review", "list_reviews", "resolve_followup", "record_verification", "list_verifications", "run_verification_async"]);
  assert.ok(tools.every((tool) => tool.outputSchema));
  assert.deepEqual(tools.map((tool) => tool.annotations?.readOnlyHint), [false, true, false, false, true, false]);
  assert.match(tools[0]?.description ?? "", /records a review but does not perform one/);
  assert.match(tools[1]?.description ?? "", /Proactively call before finalizing or handing off changed work/);
  assert.match(tools[2]?.description ?? "", /fixed and verified/);
  assert.match(tools[3]?.description ?? "", /new verification observation is required/);
  assert.match(tools[3]?.description ?? "", /caller-supplied result claims are not accepted/);
  assert.match(tools[4]?.description ?? "", /Proactively call before finalizing or handing off work/);
  assert.equal(tools[5]?.execution?.taskSupport, "required");
});

test("compiled MCP persists a review attestation, checks freshness, and resolves debt", async (t) => {
  const { workspace, reviewData, verificationData, client } = await fixture();
  t.after(async () => { await client.close(); await cleanup(workspace, reviewData, verificationData); });
  const written = await client.callTool({ name: "record_review", arguments: { workspaceRoot: workspace, reviewer: "mcp-reviewer", verdict: "approved", subject: reviewSubject, blockingSeverities: ["P0", "P1"], findings: [{ severity: "P2", summary: "Add edge coverage", paths: [] }] } });
  assert.equal(written.isError, undefined);
  const review = (written.structuredContent as { review: { evidenceClass: string; freshness: string; provenance: { origin: string }; followUps: Array<{ id: string }> } }).review;
  assert.equal(review.evidenceClass, "attestation");
  assert.equal(review.freshness, "unknown");
  assert.equal(review.provenance.origin, "accountability-mcp/record_review");
  const listed = await client.callTool({ name: "list_reviews", arguments: { workspaceRoot: workspace, currentSubject: reviewSubject } });
  assert.equal((listed.structuredContent as { reviews: Array<{ freshness: string }> }).reviews[0]?.freshness, "fresh");
  const resolved = await client.callTool({ name: "resolve_followup", arguments: { workspaceRoot: workspace, followUpId: review.followUps[0]?.id, resolution: "Covered" } });
  assert.equal((resolved.structuredContent as { followUp: { status: string } }).followUp.status, "resolved");
});

test("compiled MCP rejects review approval with configured blockers and malformed subjects", async (t) => {
  const { workspace, reviewData, verificationData, client } = await fixture();
  t.after(async () => { await client.close(); await cleanup(workspace, reviewData, verificationData); });
  const blocked = await client.callTool({ name: "record_review", arguments: { workspaceRoot: workspace, reviewer: "mcp-reviewer", verdict: "approved", subject: { kind: "fingerprint", algorithm: "sha256", version: "1", scope: "review-diff", value: "b".repeat(64) }, blockingSeverities: ["P0", "P1"], findings: [{ severity: "P1", summary: "Blocking", paths: [] }] } });
  assert.equal(blocked.isError, true);
  const invalid = await client.callTool({ name: "record_review", arguments: { workspaceRoot: workspace, reviewer: "mcp-reviewer", verdict: "approved", subject: { kind: "workspace", value: workspace }, blockingSeverities: ["P0"], findings: [] } });
  assert.equal(invalid.isError, true);
});

test("compiled MCP obtains local authority-backed verification evidence", async (t) => {
  const { workspace, reviewData, verificationData, client } = await fixture();
  t.after(async () => { await client.close(); await cleanup(workspace, reviewData, verificationData); });
  const recorded = await client.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "local_test", testIds: ["node:test/a.test.ts"] } } });
  assert.equal(recorded.isError, undefined);
  const listed = await client.callTool({ name: "list_verifications", arguments: { workspaceRoot: workspace, currentSubject: { kind: "fingerprint", algorithm: "sha256", version: "1", scope: "worktree", value: "c".repeat(64) } } });
  const item = (listed.structuredContent as { observations: Array<{ freshness: string; result: { failed: number; testsTruncated: boolean } }> }).observations[0]!;
  assert.equal(item.freshness, "unknown");
  assert.equal(item.result.failed, 1);
  assert.equal(item.result.testsTruncated, true);
});

test("compiled MCP obtains CI evidence by authority-returned run identity", async (t) => {
  const { workspace, reviewData, verificationData, client } = await fixture();
  t.after(async () => { await client.close(); await cleanup(workspace, reviewData, verificationData); });
  const revision = "d".repeat(40);
  const recorded = await client.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "ci_run", runId: "github:42", revision } } });
  assert.equal(recorded.isError, undefined);
  const item = (recorded.structuredContent as { observation: { source: { runId: string }; result: { revision: string } } }).observation;
  assert.equal(item.source.runId, "github:42");
  assert.equal(item.result.revision, revision);
  const forged = await client.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "ci_run", runId: "github:43" } } });
  assert.equal(forged.isError, true);
  const unknown = await client.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "agent_claim", result: "all tests pass" } } });
  assert.equal(unknown.isError, true);
});

test("compiled MCP admits browser verification evidence from the browser authority", async (t) => {
  const { workspace, reviewData, verificationData, client } = await fixture();
  t.after(async () => { await client.close(); await cleanup(workspace, reviewData, verificationData); });
  const recorded = await client.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "browser_verification", url: "https://app.test/", assertions: [{ kind: "element_exists", selector: "#output" }] } } });
  assert.equal(recorded.isError, undefined);
  const observation = (recorded.structuredContent as { observation: { source: { kind: string; capability: string; evidenceHash: string }; subject: { kind: string; url: string }; result: { outcome: string; passed: number } } }).observation;
  assert.equal(observation.source.kind, "browser_verification");
  assert.equal(observation.source.capability, "browser-verification-mcp/run_verification");
  assert.equal(observation.source.evidenceHash, "f".repeat(64));
  assert.equal(observation.subject.kind, "browser_page");
  assert.equal(observation.subject.url, "https://app.test/");
  assert.equal(observation.result.outcome, "passed");
  assert.equal(observation.result.passed, 1);
  const listed = await client.callTool({ name: "list_verifications", arguments: { workspaceRoot: workspace, currentSubject: { kind: "browser_page", url: "https://app.test/", pageHash: "e".repeat(64) } } });
  assert.equal(((listed.structuredContent as { observations: Array<{ freshness: string }> }).observations[0]?.freshness), "fresh");
});

test("Tasks extension runs verification out-of-band with observable task status", async (t) => {
  const { workspace, reviewData, verificationData, client } = await fixture();
  t.after(async () => { await client.close(); await cleanup(workspace, reviewData, verificationData); });

  // The high-level client caches task metadata from tools/list before it will
  // route a call through the Tasks extension.
  await client.listTools();
  const observed: string[] = [];
  let taskId: string | undefined;
  let finalObservation: { result?: { failed?: number } } | undefined;
  for await (const message of client.experimental.tasks.callToolStream({ name: "run_verification_async", arguments: { workspaceRoot: workspace, request: { kind: "local_test", testIds: ["node:test/a.test.ts"] } } })) {
    observed.push(message.type);
    if (message.type === "taskCreated") taskId = message.task.taskId;
    if (message.type === "result") finalObservation = (message.result as { structuredContent?: { observation?: { result?: { failed?: number } } } }).structuredContent?.observation;
  }

  assert.ok(observed.includes("taskCreated"), `expected a taskCreated message, got ${JSON.stringify(observed)}`);
  assert.ok(taskId, "task stream did not expose a task id");
  const task = await client.experimental.tasks.getTask(taskId);
  assert.equal(task.status, "completed");
  assert.equal(finalObservation?.result?.failed, 1);
});

test("emits MCP log and progress notifications for tool calls", async (t) => {
  const { workspace, reviewData, verificationData, client } = await fixture();
  t.after(async () => { await client.close(); await cleanup(workspace, reviewData, verificationData); });
  const { LoggingMessageNotificationSchema, ProgressNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const logs: { level: string; data: { tool?: string; phase?: string } }[] = [];
  const progress: { message?: string }[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { logs.push(notification.params as never); });
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => { progress.push(notification.params as never); });

  await client.callTool({ name: "list_reviews", arguments: { workspaceRoot: process.cwd() }, _meta: { progressToken: "rollout-probe" } });

  assert.ok(logs.some((log) => log.level === "debug" && log.data.phase === "start"), "expected debug start log, got " + JSON.stringify(logs));
  assert.ok(
    logs.some((log) => (log.level === "info" && log.data.phase === "done") || (log.level === "error" && log.data.phase === "error")),
    "expected done or error log, got " + JSON.stringify(logs),
  );
  assert.equal(progress[0]?.message, "start");
});

test("honors the historical verification authority env-var names as a fallback", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "accountability-mcp-workspace-"));
  const reviewData = await mkdtemp(join(tmpdir(), "accountability-mcp-review-data-"));
  const verificationData = await mkdtemp(join(tmpdir(), "accountability-mcp-verification-data-"));
  const client = new Client({ name: "accountability-legacy-env-test", version: "1.0.0" });
  t.after(async () => { await client.close().catch(() => undefined); await cleanup(workspace, reviewData, verificationData); });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      VERIFICATION_ACCOUNTABILITY_DATA_DIR: verificationData,
      VERIFICATION_ACCOUNTABILITY_TEST_COMMAND: process.execPath,
      VERIFICATION_ACCOUNTABILITY_TEST_ARGS: JSON.stringify([fakeAuthority]),
      CI_GITHUB_REPOSITORY: "owner/repo",
    },
  }));
  const recorded = await client.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "local_test", testIds: ["node:test/a.test.ts"] } } });
  assert.equal(recorded.isError, undefined, "the historical VERIFICATION_ACCOUNTABILITY_* authority names must still resolve a primitive");
});
