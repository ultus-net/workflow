import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let client: Client;
let workspace: string;
let dataRoot: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "review-mcp-workspace-"));
  dataRoot = await mkdtemp(join(tmpdir(), "review-mcp-data-"));
  client = new Client({ name: "review-black-box-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], cwd: process.cwd(), stderr: "pipe", env: { REVIEW_ACCOUNTABILITY_DATA_DIR: dataRoot } }));
});
after(async () => { await client.close(); await Promise.all([rm(workspace, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]); });

test("compiled server exposes bounded review and follow-up tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name), ["record_review", "list_reviews", "resolve_followup"]);
  assert.ok(tools.every((tool) => tool.outputSchema));
  assert.deepEqual(tools.map((tool) => tool.annotations?.readOnlyHint), [false, true, false]);
  assert.match(tools[0]?.description ?? "", /records a review but does not perform one/);
  assert.match(tools[1]?.description ?? "", /Proactively call before finalizing or handing off changed work/);
  assert.match(tools[2]?.description ?? "", /fixed and verified/);
});

test("compiled MCP persists an attestation, checks freshness, and resolves debt", async () => {
  const subject = { kind: "fingerprint", algorithm: "sha256", version: "1", scope: "review-diff", value: "a".repeat(64) };
  const written = await client.callTool({ name: "record_review", arguments: { workspaceRoot: workspace, reviewer: "mcp-reviewer", verdict: "approved", subject, blockingSeverities: ["P0", "P1"], findings: [{ severity: "P2", summary: "Add edge coverage", paths: [] }] } });
  assert.equal(written.isError, undefined);
  const review = (written.structuredContent as { review: { evidenceClass: string; freshness: string; followUps: Array<{ id: string }> } }).review;
  assert.equal(review.evidenceClass, "attestation");
  assert.equal(review.freshness, "unknown");
  const listed = await client.callTool({ name: "list_reviews", arguments: { workspaceRoot: workspace, currentSubject: subject } });
  assert.equal((listed.structuredContent as { reviews: Array<{ freshness: string }> }).reviews[0]?.freshness, "fresh");
  const resolved = await client.callTool({ name: "resolve_followup", arguments: { workspaceRoot: workspace, followUpId: review.followUps[0]?.id, resolution: "Covered" } });
  assert.equal((resolved.structuredContent as { followUp: { status: string } }).followUp.status, "resolved");
});

test("compiled MCP rejects approval with configured blockers and malformed subjects", async () => {
  const blocked = await client.callTool({ name: "record_review", arguments: { workspaceRoot: workspace, reviewer: "mcp-reviewer", verdict: "approved", subject: { kind: "fingerprint", algorithm: "sha256", version: "1", scope: "review-diff", value: "b".repeat(64) }, blockingSeverities: ["P0", "P1"], findings: [{ severity: "P1", summary: "Blocking", paths: [] }] } });
  assert.equal(blocked.isError, true);
  const invalid = await client.callTool({ name: "record_review", arguments: { workspaceRoot: workspace, reviewer: "mcp-reviewer", verdict: "approved", subject: { kind: "workspace", value: workspace }, blockingSeverities: ["P0"], findings: [] } });
  assert.equal(invalid.isError, true);
});

test("emits MCP log and progress notifications for tool calls", async () => {
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
