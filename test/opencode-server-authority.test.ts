import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { hostCapabilities, type ToolCapability } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import {
  assertAskRuleset,
  createOpencodeServerAuthority,
  ensureOpencodeSessionTask,
  opencodeSessionTaskId,
  type OpencodeAuthorityDecision,
} from "../src/integrations/opencode-server-authority.js";
import type { RemoteEngine, RemoteEngineEvent, RemoteEnginePermissionRequest } from "../src/integrations/remote-acp/engine.js";

/**
 * W071 M2 — the OpenCode server authority broker.
 *
 * Pins the policy path: a server `permission.asked` is mapped to a proposal,
 * authorized, and answered upstream; denials are honored; malformed and
 * unmappable requests fail closed; SSE loss marks authority lost; sessions
 * correlate to canonical IN_PROGRESS tasks.
 */

interface FakeEngine {
  readonly engine: Pick<RemoteEngine, "events" | "replyPermission">;
  readonly replies: { readonly sessionId: string; readonly requestId: string; readonly reply: string }[];
}

function fakeEngine(events: readonly RemoteEngineEvent[], mode: "complete" | "throw" = "complete"): FakeEngine {
  const replies: { sessionId: string; requestId: string; reply: string }[] = [];
  return {
    replies,
    engine: {
      async *events() {
        for (const event of events) yield event;
        if (mode === "throw") throw new Error("SSE stream lost");
      },
      async replyPermission(input) {
        replies.push({ sessionId: input.sessionId, requestId: input.requestId, reply: input.reply });
      },
    },
  };
}

function permission(id: string, action: string, metadata: Record<string, unknown>, callId?: string): RemoteEngineEvent {
  const request: RemoteEnginePermissionRequest = {
    id,
    sessionID: "s1",
    action,
    resources: [],
    metadata,
    ...(callId === undefined ? {} : { tool: { callID: callId } }),
  };
  return { type: "permission.asked", properties: request };
}

function toolPart(callId: string, tool: string, status: string = "pending", input?: unknown): RemoteEngineEvent {
  return {
    type: "message.part.updated",
    properties: { sessionID: "s1", part: { type: "tool", callID: callId, tool, state: { status, input } } },
  };
}

function application(workspace: string, capabilities: readonly ToolCapability[]): WorkflowApplication {
  return new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set<ToolCapability>(capabilities),
    workspace,
  );
}

test("W071 broker: an allowed process action is answered once", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-allow-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "bash", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
  });
  await authority.start();
  assert.deepEqual(fake.replies, [{ sessionId: "s1", requestId: "r1", reply: "once" }]);
  assert.equal(authority.decisions()[0]?.decision, "allow");
  assert.equal(authority.decisions()[0]?.capability, "process");
});

test("W071 broker: a withheld capability is denied pre-mutation", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-deny-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "webfetch", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]), // network withheld
    workspace,
  });
  await authority.start();
  assert.deepEqual(fake.replies, [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
  const decision = authority.decisions()[0]!;
  assert.equal(decision.decision, "deny");
  assert.equal(decision.capability, "network");
});

test("W071 broker: a mutation outside the workspace is denied", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-escape-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "edit", { filePath: "/etc/passwd" })]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
  });
  await authority.start();
  assert.equal(authority.decisions()[0]?.decision, "deny");
  assert.match(authority.decisions()[0]?.reason ?? "", /outside authorized workspace/);
});

test("W071 broker: an in-workspace mutation on a correlated task is allowed", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-mut-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const app = application(workspace, ["read", "mutation", "process"]);
  const fake = fakeEngine([permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") })]);
  const authority = createOpencodeServerAuthority({ engine: fake.engine, application: app, workspace });
  await authority.start();
  assert.equal(authority.decisions()[0]?.decision, "allow");
  // The session task was created and is IN_PROGRESS.
  const snapshot = app.snapshot();
  assert.equal(snapshot.tasks.find((task) => task.id === opencodeSessionTaskId("s1"))?.state, "IN_PROGRESS");
});

test("W071 broker: unmappable safety metadata fails closed", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-malformed-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // An edit with no path cannot establish subjects: must deny, never allow.
  const fake = fakeEngine([permission("r1", "edit", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
  });
  await authority.start();
  assert.deepEqual(fake.replies, [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
  assert.equal(authority.decisions()[0]?.decision, "deny");
  assert.match(authority.decisions()[0]?.reason ?? "", /unmappable permission request/);
});

test("W071 broker: SSE loss marks authority lost", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-sse-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "bash", {})], "throw");
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
  });
  await authority.start();
  assert.equal(authority.authorityLost, true);
  // The event before the drop was still decided.
  assert.equal(authority.decisions().length, 1);
});

test("W071 broker: operator replies are journaled as observation in auto-resolve mode", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-op-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const journaled: OpencodeAuthorityDecision[] = [];
  const fake = fakeEngine([]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    onDecision: (decision) => journaled.push(decision),
  });
  await authority.handleOperatorReply({ sessionId: "s1", requestId: "r9", reply: "once" });
  assert.equal(journaled.length, 1);
  assert.match(journaled[0]?.reason ?? "", /auto-resolve mode/);
});

test("W071 broker (ask-me): a policy-allowed ask waits for operator intent and is answered once", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-askme-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "bash", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    mode: "ask-me",
  });
  const running = authority.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  assert.equal(authority.pendingOperatorReplies, 1, "the ask must be held for the operator");
  await authority.handleOperatorReply({ sessionId: "s1", requestId: "r1", reply: "once" });
  await running;
  assert.deepEqual(fake.replies, [{ sessionId: "s1", requestId: "r1", reply: "once" }]);
});

test("W071 broker (ask-me): the operator can only tighten a policy-allowed ask", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-askme-reject-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "bash", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    mode: "ask-me",
  });
  const running = authority.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  await authority.handleOperatorReply({ sessionId: "s1", requestId: "r1", reply: "reject" });
  await running;
  assert.deepEqual(fake.replies, [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
});

test("W071 broker (ask-me): a policy deny is answered immediately, never held", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-askme-deny-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "webfetch", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]), // network withheld
    workspace,
    mode: "ask-me",
  });
  await authority.start();
  assert.equal(authority.pendingOperatorReplies, 0);
  assert.deepEqual(fake.replies, [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
});

test("W071 broker (ask-me): an unanswered ask times out to reject (fail closed)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-askme-timeout-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "bash", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    mode: "ask-me",
    operatorReplyTimeoutMs: 20,
  });
  await authority.start();
  assert.deepEqual(fake.replies, [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
});

test("W071 broker (enforced): the bypass alarm fires for a mutating tool with no decision", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-bypass-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const bypasses: string[] = [];
  const fake = fakeEngine([toolPart("c9", "edit")]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    enforcement: "enforced",
    onBypass: (input) => bypasses.push(input.tool),
  });
  await authority.start();
  assert.deepEqual(bypasses, ["edit"]);
  assert.equal(authority.decisions().some((decision) => decision.tool === "(bypass)"), true);
});

test("W071 broker (enforced): a mutating tool covered by a decision does not alarm", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-no-bypass-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const bypasses: string[] = [];
  const fake = fakeEngine([
    permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }, "c9"),
    toolPart("c9", "edit"),
  ]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    enforcement: "enforced",
    onBypass: (input) => bypasses.push(input.tool),
  });
  await authority.start();
  assert.deepEqual(bypasses, []);
  assert.equal(authority.decisions().some((decision) => decision.tool === "(bypass)"), false);
  assert.equal(authority.decisions()[0]?.decision, "allow");
});

test("W071 broker: assertAskRuleset fails closed on a permissive ruleset", () => {
  assert.doesNotThrow(() => assertAskRuleset({ permission: { edit: "ask", bash: "ask", task: "ask" } }));
  assert.throws(() => assertAskRuleset({ permission: { edit: "allow", bash: "ask", task: "ask" } }), /not pinned to ask/);
  assert.throws(() => assertAskRuleset({}), /not pinned to ask/);
  assert.throws(() => assertAskRuleset(undefined), /not pinned to ask/);
});

test("W071 broker: session task correlation is stable and additive", () => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-task-"));
  try {
    const app = application(workspace, ["read", "mutation", "process"]);
    const first = ensureOpencodeSessionTask(app, "s1");
    const second = ensureOpencodeSessionTask(app, "s1");
    assert.equal(first, second);
    assert.equal(first, opencodeSessionTaskId("s1"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("W071 broker (M4): a crossed session budget denies mutations, reads stay allowed", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-budget-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }), permission("r2", "grep", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    budgetViolation: () => "total tokens 90000 exceeded the session budget cap 50000",
  });
  await authority.start();
  assert.equal(authority.decisions()[0]?.decision, "deny");
  assert.match(authority.decisions()[0]?.reason ?? "", /session budget violated/);
  assert.equal(authority.decisions()[1]?.decision, "allow", "a read is not a mutation; the budget gate must not block it");
});

test("W071 broker (M4): a required skill must be delivered before mutations run", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-skill-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const app = application(workspace, ["read", "mutation", "process"]);
  const taskId = ensureOpencodeSessionTask(app, "s1");
  app.setTaskRequiredSkills(taskId, ["superpowers"]);
  const withoutDelivery = fakeEngine([permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }, "c1")]);
  const authority1 = createOpencodeServerAuthority({ engine: withoutDelivery.engine, application: app, workspace });
  await authority1.start();
  assert.equal(authority1.decisions()[0]?.decision, "deny");
  assert.match(authority1.decisions()[0]?.reason ?? "", /SKILL_DELIVERY_REQUIRED|requires skill delivery/i);

  // With the read_skill ask first, the delivery is journaled against the
  // session task and the mutation is allowed.
  const withDelivery = fakeEngine([
    permission("r2", "skills-mcp__read_skill", { skill: "superpowers" }, "c2"),
    toolPart("c2", "skills-mcp__read_skill", "completed", { skill: "superpowers" }),
    permission("r3", "edit", { filePath: join(workspace, "src", "a.ts") }, "c3"),
  ]);
  const authority2 = createOpencodeServerAuthority({ engine: withDelivery.engine, application: app, workspace });
  await authority2.start();
  assert.equal(authority2.decisions()[0]?.decision, "allow", "a read_skill ask is a read, not a mutation");
  assert.equal(authority2.decisions()[1]?.decision, "allow", "the journaled skill delivery must satisfy the precondition");
});

test("W071 broker (M4): a completed decided mutation advances the mutation epoch", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-mutation-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const beforeEpoch = application(workspace, ["read", "mutation", "process"]).snapshot().mutationEpoch;
  const decidedOnly = fakeEngine([permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }, "c1")]);
  const app1 = application(workspace, ["read", "mutation", "process"]);
  const authority1 = createOpencodeServerAuthority({ engine: decidedOnly.engine, application: app1, workspace });
  await authority1.start();
  const epochAfterDecision = app1.snapshot().mutationEpoch;
  assert.equal(epochAfterDecision, beforeEpoch, "a decided-but-not-completed mutation must not advance the epoch yet");

  const app2 = application(workspace, ["read", "mutation", "process"]);
  const observed = fakeEngine([
    permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }, "c1"),
    toolPart("c1", "edit", "completed"),
  ]);
  const authority2 = createOpencodeServerAuthority({ engine: observed.engine, application: app2, workspace });
  await authority2.start();
  assert.ok(app2.snapshot().mutationEpoch > epochAfterDecision, "an observed completed mutation must advance the epoch");
});