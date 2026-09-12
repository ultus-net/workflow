import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let client: Client;
let dataRoot: string;

before(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "learning-mcp-data-"));
  client = new Client({ name: "learning-mcp-black-box-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["dist/server.js"], cwd: process.cwd(), stderr: "pipe",
    env: { LEARNING_MCP_DATA_DIR: dataRoot },
  }));
});

after(async () => {
  await client.close();
  await rm(dataRoot, { recursive: true, force: true });
});

const checkpoint = {
  concept: "async:promises", category: "foundations", relevance: 0.9, consequence: 0.8,
  teachableInsight: "Microtasks drain before the next macrotask.",
  socraticQuestion: "Which queue runs first?",
  candidateAnswers: [{ label: "microtask", description: "promise callbacks" }, { label: "macrotask", description: "timers" }],
};

test("compiled server exposes the pedagogy tools with schemas and annotations", async () => {
  assert.deepEqual(client.getServerVersion(), { name: "learning-mcp", version: "0.1.0" });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), [
    "decision_checkpoint", "learner_profile", "learning_checkpoint", "record_learning_evidence", "resolve_decision_checkpoint",
  ]);
  assert.ok(tools.every((tool) => tool.outputSchema));
  const readOnly = tools.find((tool) => tool.name === "learner_profile");
  assert.equal(readOnly?.annotations?.readOnlyHint, true);
  assert.equal(readOnly?.annotations?.idempotentHint, true);
  const mutating = tools.find((tool) => tool.name === "learning_checkpoint");
  assert.equal(mutating?.annotations?.readOnlyHint, false);
  assert.equal((await client.callTool({ name: "learning_checkpoint", arguments: { ...checkpoint, mode: "bogus", sessionInterventions: 0 } })).isError, true);
  assert.equal((await client.callTool({ name: "record_learning_evidence", arguments: { concept: "x", kind: "genius", summary: "s" } })).isError, true);
});

test("learning_checkpoint gates on mode, budget, and mastery and persists evidence", async () => {
  const auto = await client.callTool({ name: "learning_checkpoint", arguments: { ...checkpoint, mode: "autonomous", sessionInterventions: 0 } });
  assert.equal((auto.structuredContent as { interrupt: boolean }).interrupt, false);

  const tutor = await client.callTool({ name: "learning_checkpoint", arguments: { ...checkpoint, mode: "socratic-tutor", sessionInterventions: 0 } });
  const gated = tutor.structuredContent as { interrupt: boolean; stage?: string; checkpoint?: { socraticQuestion: string } };
  assert.equal(gated.interrupt, true);
  assert.equal(gated.stage, "exposed");
  assert.equal(gated.checkpoint?.socraticQuestion, checkpoint.socraticQuestion);

  const exhausted = await client.callTool({ name: "learning_checkpoint", arguments: { ...checkpoint, mode: "socratic-tutor", sessionInterventions: 3 } });
  assert.equal((exhausted.structuredContent as { interrupt: boolean }).interrupt, false);

  await client.callTool({ name: "record_learning_evidence", arguments: { concept: checkpoint.concept, kind: "independent", summary: "built retry loop unaided" } });
  const mastered = await client.callTool({ name: "learning_checkpoint", arguments: { ...checkpoint, mode: "learn-to-code", sessionInterventions: 0 } });
  assert.equal((mastered.structuredContent as { interrupt: boolean }).interrupt, false);

  const profile = await client.callTool({ name: "learner_profile", arguments: {} });
  const concepts = (profile.structuredContent as { concepts: Record<string, { stage: string }> }).concepts;
  assert.equal(concepts[checkpoint.concept]?.stage, "independent");
});

test("decision checkpoints record, resolve, and reject unknown brief ids", async () => {
  const brief = {
    title: "Store format", context: "Profile must survive crashes",
    proposedChoice: { name: "atomic-rename", rationale: "crash safe", blastRadius: "low" },
    rejectedAlternatives: [{ name: "in-place write", drawback: "torn writes" }],
    tradeoffs: { benefits: ["safe"], liabilities: ["extra fsync"] },
  };
  const recorded = await client.callTool({ name: "decision_checkpoint", arguments: brief });
  const out = recorded.structuredContent as { briefId: string; requiresHumanApproval: boolean; brief: { status: string } };
  assert.ok(out.briefId);
  assert.equal(out.requiresHumanApproval, true);
  assert.equal(out.brief.status, "pending");

  const resolved = await client.callTool({ name: "resolve_decision_checkpoint", arguments: { briefId: out.briefId, approved: true, note: "ship it" } });
  assert.equal((resolved.structuredContent as { brief: { status: string } }).brief.status, "approved");

  const unknown = await client.callTool({ name: "resolve_decision_checkpoint", arguments: { briefId: "missing", approved: false } });
  assert.equal(unknown.isError, true);
});

test("server emits leveled log notifications around tool phases", async () => {
  const logs: { level: string; data: { tool?: string; phase?: string } }[] = [];
  client.setNotificationHandler(
    (await import("@modelcontextprotocol/sdk/types.js")).LoggingMessageNotificationSchema,
    (notification) => { logs.push(notification.params as never); },
  );
  await client.callTool({ name: "record_learning_evidence", arguments: { concept: "logging:phases", kind: "exposed", summary: "s" } });
  const phases = logs.filter((log) => log.data?.tool === "record_learning_evidence").map((log) => log.data.phase);
  assert.ok(phases.includes("profile-load"), `expected profile-load phase, got ${JSON.stringify(phases)}`);
  assert.ok(phases.includes("evidence-persist"), `expected evidence-persist phase, got ${JSON.stringify(phases)}`);
  assert.ok(logs.every((log) => log.level === "debug" || log.level === "info"));
  logs.length = 0;
  await client.callTool({ name: "decision_checkpoint", arguments: {
    title: "t", context: "c",
    proposedChoice: { name: "n", rationale: "r", blastRadius: "low" },
    rejectedAlternatives: [], tradeoffs: { benefits: [], liabilities: [] },
  } });
  assert.ok(logs.some((log) => log.data?.tool === "decision_checkpoint" && log.data.phase === "ledger-op"));
});

test("learning_checkpoint emits progress only when a progressToken is supplied", async () => {
  const types = await import("@modelcontextprotocol/sdk/types.js");
  const progress: { progressToken: string | number; message?: string }[] = [];
  client.setNotificationHandler(types.ProgressNotificationSchema, (notification) => {
    progress.push(notification.params as never);
  });
  await client.callTool({ name: "learning_checkpoint", arguments: { ...checkpoint, concept: "progress:with-token", mode: "learn-to-code", sessionInterventions: 0 } });
  assert.equal(progress.length, 0, "no progress notifications without a progressToken");

  await client.callTool(
    { name: "learning_checkpoint", arguments: { ...checkpoint, concept: "progress:token-two", mode: "learn-to-code", sessionInterventions: 0 }, _meta: { progressToken: "pt-1" } },
  );
  const messages = progress.filter((p) => p.progressToken === "pt-1").map((p) => p.message);
  assert.deepEqual(messages, ["profile-loaded", "gate-evaluated", "evidence-recorded"]);
});

test("learner profile is readable as a resource and update notifications fire on mutation", async () => {
  const types = await import("@modelcontextprotocol/sdk/types.js");
  const updates: string[] = [];
  client.setNotificationHandler(types.ResourceUpdatedNotificationSchema, (notification) => {
    updates.push((notification.params as { uri: string }).uri);
  });

  const listed = await client.listResources();
  assert.ok(listed.resources.some((r) => r.uri === "workflow://learner-profile" && r.mimeType === "application/json"));

  await client.subscribeResource({ uri: "workflow://learner-profile" });
  const read = await client.readResource({ uri: "workflow://learner-profile" });
  assert.equal(read.contents[0]?.mimeType, "application/json");
  const profile = JSON.parse((read.contents[0] as { text: string }).text) as { version: number; concepts: Record<string, unknown> };
  assert.equal(profile.version, 1);
  assert.ok("async:promises" in profile.concepts, "resource reflects recorded evidence");

  await client.callTool({ name: "record_learning_evidence", arguments: { concept: "resource:notify", kind: "developing", summary: "s" } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(updates.includes("workflow://learner-profile"), `expected resource update notification, got ${JSON.stringify(updates)}`);

  updates.length = 0;
  const interrupted = await client.callTool({ name: "learning_checkpoint", arguments: { ...checkpoint, concept: "resource:interrupt", mode: "learn-to-code", sessionInterventions: 0 } });
  assert.equal((interrupted.structuredContent as { interrupt: boolean }).interrupt, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(updates.includes("workflow://learner-profile"), "interrupting checkpoint mutates the profile and notifies");
});
