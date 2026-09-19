import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "verification-mcp-workspace-")); const dataRoot = await mkdtemp(join(tmpdir(), "verification-mcp-data-"));
  const client = new Client({ name: "verification-black-box-test", version: "1.0.0" });
  const authority = join(process.cwd(), "test", "fake-authority.mjs");
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], cwd: process.cwd(), stderr: "pipe", env: { VERIFICATION_ACCOUNTABILITY_DATA_DIR: dataRoot, VERIFICATION_ACCOUNTABILITY_TEST_COMMAND: process.execPath, VERIFICATION_ACCOUNTABILITY_TEST_ARGS: JSON.stringify([authority]), VERIFICATION_ACCOUNTABILITY_CI_COMMAND: process.execPath, VERIFICATION_ACCOUNTABILITY_CI_ARGS: JSON.stringify([authority]), VERIFICATION_ACCOUNTABILITY_BROWSER_COMMAND: process.execPath, VERIFICATION_ACCOUNTABILITY_BROWSER_ARGS: JSON.stringify([authority]), CI_GITHUB_REPOSITORY: "owner/repo" } }));
  return { workspace, dataRoot, client };
}

test("compiled server exposes bounded authority-backed persistence and retrieval", async (t) => {
  const { workspace, dataRoot, client } = await fixture(); t.after(async () => { await client.close(); await Promise.all([rm(workspace, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]); });
  const { tools } = await client.listTools(); assert.deepEqual(tools.map(({ name }) => name), ["record_verification", "list_verifications", "run_verification_async"]); assert.ok(tools.every((tool) => tool.outputSchema)); assert.deepEqual(tools.map((tool) => tool.annotations?.readOnlyHint), [false, true, false]); assert.match(tools[0]?.description ?? "", /new verification observation is required/); assert.match(tools[0]?.description ?? "", /Local test content freshness remains unknown/); assert.match(tools[0]?.description ?? "", /caller-supplied result claims are not accepted/); assert.match(tools[1]?.description ?? "", /Proactively call before finalizing or handing off work/); assert.equal(tools[2]?.execution?.taskSupport, "required");
  const recorded = await client.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "local_test", testIds: ["node:test/a.test.ts"] } } }); assert.equal(recorded.isError, undefined);
  const listed = await client.callTool({ name: "list_verifications", arguments: { workspaceRoot: workspace, currentSubject: { kind: "fingerprint", algorithm: "sha256", version: "1", scope: "worktree", value: "c".repeat(64) } } });
  const item = (listed.structuredContent as { observations: Array<{ freshness: string; result: { failed: number; testsTruncated: boolean } }> }).observations[0]!; assert.equal(item.freshness, "unknown"); assert.equal(item.result.failed, 1); assert.equal(item.result.testsTruncated, true);
});

test("compiled MCP obtains CI evidence by authority-returned run identity", async (t) => {
  const { workspace, dataRoot, client } = await fixture(); t.after(async () => { await client.close(); await Promise.all([rm(workspace, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]); });
  const revision = "d".repeat(40); const recorded = await client.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "ci_run", runId: "github:42", revision } } }); assert.equal(recorded.isError, undefined);
  const item = (recorded.structuredContent as { observation: { source: { runId: string }; result: { revision: string } } }).observation; assert.equal(item.source.runId, "github:42"); assert.equal(item.result.revision, revision);
  const forged = await client.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "ci_run", runId: "github:43" } } }); assert.equal(forged.isError, true);
  const unknown = await client.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "agent_claim", result: "all tests pass" } } }); assert.equal(unknown.isError, true);
});

test("emits MCP log and progress notifications for tool calls", async () => {
  const { client, workspace, dataRoot } = await fixture();
  const { LoggingMessageNotificationSchema, ProgressNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const logs: { level: string; data: { tool?: string; phase?: string } }[] = [];
  const progress: { message?: string }[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { logs.push(notification.params as never); });
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => { progress.push(notification.params as never); });

  await client.callTool({ name: "list_verifications", arguments: { workspaceRoot: process.cwd(), currentSubject: { kind: "fingerprint", algorithm: "sha256", version: "1", scope: "worktree", value: "c".repeat(64) } }, _meta: { progressToken: "rollout-probe" } });

  assert.ok(logs.some((log) => log.level === "debug" && log.data.phase === "start"), "expected debug start log, got " + JSON.stringify(logs));
  assert.ok(
    logs.some((log) => (log.level === "info" && log.data.phase === "done") || (log.level === "error" && log.data.phase === "error")),
    "expected done or error log, got " + JSON.stringify(logs),
  );
  assert.equal(progress[0]?.message, "start");
  await client.close();
  await Promise.all([rm(workspace, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]);
});

test("compiled MCP admits browser verification evidence from the browser authority", async (t) => {
  const { workspace, dataRoot, client } = await fixture(); t.after(async () => { await client.close(); await Promise.all([rm(workspace, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]); });
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
  const { workspace, dataRoot, client } = await fixture();
  t.after(async () => { await client.close(); await Promise.all([rm(workspace, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]); });

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
