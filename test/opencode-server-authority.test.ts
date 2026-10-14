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
  opencodePermissionCapability,
  opencodeSessionTaskId,
  type OpencodeAuthorityDecision,
} from "../src/integrations/opencode-server-authority.js";
import type { RemoteEngine, RemoteEngineEvent, RemoteEnginePermissionRequest } from "../src/integrations/remote-acp/engine.js";
import { HttpRemoteEngine } from "../src/integrations/remote-acp/engine.js";
import type { WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";

/**
 * W071 M2 — the OpenCode server authority broker.
 *
 * Pins the policy path: a server `permission.asked` is mapped to a proposal,
 * authorized, and answered upstream; denials are honored; malformed and
 * unmappable requests fail closed; SSE loss marks authority lost; sessions
 * correlate to canonical IN_PROGRESS tasks.
 */

interface FakeEngine {
  readonly engine: Pick<RemoteEngine, "events" | "replyPermission" | "listPermissions">;
  readonly replies: { readonly sessionId: string; readonly requestId: string; readonly reply: string; readonly message?: string }[];
}

function fakeEngine(
  events: readonly RemoteEngineEvent[],
  mode: "complete" | "throw" = "complete",
  pendingHost: readonly RemoteEnginePermissionRequest[] = [],
  replyFailures: readonly string[] = [],
): FakeEngine {
  const replies: { sessionId: string; requestId: string; reply: string; message?: string }[] = [];
  const remainingFailures = new Set(replyFailures);
  return {
    replies,
    engine: {
      async *events() {
        for (const event of events) yield event;
        if (mode === "throw") throw new Error("SSE stream lost");
      },
      async replyPermission(input) {
        // Simulate a HOST reply failure for a named request on its FIRST reply
        // only (a transient error, not the cascade 404), so a failed drain
        // delivery can be exercised and a later retry can succeed.
        if (remainingFailures.delete(input.requestId)) {
          throw new Error(`remote engine POST /permission/${input.requestId}/reply failed (500): boom`);
        }
        replies.push({
          sessionId: input.sessionId,
          requestId: input.requestId,
          reply: input.reply,
          ...(input.message === undefined ? {} : { message: input.message }),
        });
      },
      async listPermissions() {
        return pendingHost;
      },
    },
  };
}

/** A reject is expected to carry in-band feedback (the denial reason). */
function expectsRejectFeedback(replies: readonly { readonly message?: string }[]): void {
  assert.equal(replies.length, 1);
  assert.ok((replies[0]!.message ?? "").length > 0, "a rejected permission must carry in-band feedback for the agent");
}

function permission(id: string, action: string, metadata: Record<string, unknown>, callId?: string): RemoteEngineEvent {
  return { type: "permission.asked", properties: permissionRequest(id, action, metadata, callId) };
}

/** The bare request shape `listPermissions` returns (no event envelope). */
function permissionRequest(id: string, action: string, metadata: Record<string, unknown>, callId?: string): RemoteEnginePermissionRequest {
  return {
    id,
    sessionID: "s1",
    action,
    resources: [],
    metadata,
    ...(callId === undefined ? {} : { tool: { callID: callId } }),
  };
}

function toolPart(callId: string, tool: string, status: string = "pending", input?: unknown): RemoteEngineEvent {
  return {
    type: "message.part.updated",
    properties: { sessionID: "s1", part: { type: "tool", callID: callId, tool, state: { status, input } } },
  };
}

/** V1 part shape: the tool name rides in `name` (v2 renamed the field to `tool`). */
function v1ToolPart(callId: string, name: string, status: string = "pending", input?: unknown): RemoteEngineEvent {
  return {
    type: "message.part.updated",
    properties: { sessionID: "s1", part: { type: "tool", callID: callId, name, state: { status, input } } },
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
  assert.deepEqual(fake.replies.map((r) => ({ sessionId: r.sessionId, requestId: r.requestId, reply: r.reply })), [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
  expectsRejectFeedback(fake.replies);
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
  assert.deepEqual(fake.replies.map((r) => ({ sessionId: r.sessionId, requestId: r.requestId, reply: r.reply })), [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
  expectsRejectFeedback(fake.replies);
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

test("W071 broker: operator replies are journaled as observation (not a deny) in auto-resolve mode", async (t) => {
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
  // C1 fault: a noted client reply is an OBSERVATION, never a policy deny —
  // otherwise 200+ cosmetic records render as "the user declined this tool call".
  assert.equal(journaled[0]?.decision, "observe");
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
  assert.deepEqual(fake.replies.map((r) => ({ sessionId: r.sessionId, requestId: r.requestId, reply: r.reply })), [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
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
  assert.deepEqual(fake.replies.map((r) => ({ sessionId: r.sessionId, requestId: r.requestId, reply: r.reply })), [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
  expectsRejectFeedback(fake.replies);
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
  assert.deepEqual(fake.replies.map((r) => ({ sessionId: r.sessionId, requestId: r.requestId, reply: r.reply })), [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
});

test("W071 broker (enforced): the bypass alarm fires for a mutating tool with no decision", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-bypass-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const bypasses: string[] = [];
  // The alarm fires on the terminal observation (one call emits several parts).
  const fake = fakeEngine([toolPart("c9", "edit", "completed")]);
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

test("W186 broker: a deny drains an allowed sibling before the reject (no cascade)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-drain-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // The batch: a subagent spawn (no `spawn` capability → DENY) arrives with an
  // in-workspace edit sibling (mutation → ALLOW). Host-pending lists both, as
  // the host holds both asks concurrently.
  const sibling = permission("r2", "edit", { filePath: join(workspace, "src", "b.ts") }, "c2");
  const fake = fakeEngine(
    // Both asks are streamed in arrival order; the drain resolves r2 while
    // answering r1, so r2's own event must be skipped (no second reply).
    [permission("r1", "subagent", { toolName: "subagent" }, "c1"), sibling],
    "complete",
    [permissionRequest("r1", "subagent", { toolName: "subagent" }, "c1"), permissionRequest("r2", "edit", { filePath: join(workspace, "src", "b.ts") }, "c2")],
  );
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]), // no "spawn"
    workspace,
  });
  await authority.start();
  // The allowed edit sibling is resolved `once` BEFORE the subagent reject, so
  // the host has no pending sibling for the reject to cascade onto.
  assert.deepEqual(fake.replies, [
    { sessionId: "s1", requestId: "r2", reply: "once" },
    { sessionId: "s1", requestId: "r1", reply: "reject", message: fake.replies[1]!.message },
  ]);
  assert.ok((fake.replies[1]!.message ?? "").length > 0, "the reject carries feedback");
  assert.equal(authority.decisions().find((d) => d.requestId === "r1")?.decision, "deny");
});

test("W186 broker: a denied sibling is left pending (its own reject would cascade)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-drain2-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // Two denied siblings (both out-of-workspace). Only the arriving target is
  // rejected; the denied sibling is NOT answered here (answering it would be a
  // second reject and cascade). This documents the residual: a multi-deny batch
  // is not made sibling-safe host-side.
  const fake = fakeEngine(
    [permission("r1", "edit", { filePath: "/etc/shadow" }, "c1")],
    "complete",
    [permissionRequest("r1", "edit", { filePath: "/etc/shadow" }, "c1"), permissionRequest("r2", "edit", { filePath: "/etc/passwd" }, "c2")],
  );
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
  });
  await authority.start();
  assert.deepEqual(fake.replies.map((r) => r.requestId), ["r1"], "only the target is answered");
  assert.equal(fake.replies[0]!.reply, "reject");
});

test("W186 broker: a drained sibling whose delivery FAILED is not silently skipped", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-drainfail-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // The drain resolves the allowed sibling r2 as `once`, but the host reply
  // FAILS (transient 500). The id must NOT be marked drained, so r2's own SSE
  // event is processed normally and r2 is answered on the retry — never
  // swallowed with no reply and no journal entry (review P0).
  const sibling = permission("r2", "edit", { filePath: join(workspace, "src", "b.ts") }, "c2");
  const fake = fakeEngine(
    [permission("r1", "subagent", { toolName: "subagent" }, "c1"), sibling],
    "complete",
    [permissionRequest("r1", "subagent", { toolName: "subagent" }, "c1"), permissionRequest("r2", "edit", { filePath: join(workspace, "src", "b.ts") }, "c2")],
    ["r2"],
  );
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]), // no "spawn"
    workspace,
  });
  await authority.start();
  // r1 (deny) and r2 (allowed, on retry) both reach the host; r2 is never lost.
  assert.deepEqual(fake.replies.map((r) => `${r.requestId}:${r.reply}`).sort(), ["r1:reject", "r2:once"]);
});

test("W186 broker: a hung permission listing does not stall the deny (bounded drain)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-drainhang-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // The listing route never settles. The deny must still be delivered within the
  // (tiny) drain bound, and the stall must be journaled as an observe decision.
  const fake = fakeEngine([permission("r1", "subagent", { toolName: "subagent" }, "c1")]);
  const hungEngine = {
    ...fake.engine,
    listPermissions: () => new Promise<never>(() => {}),
  };
  const authority = createOpencodeServerAuthority({
    engine: hungEngine,
    application: application(workspace, ["read", "mutation", "process"]), // no "spawn"
    workspace,
    siblingDrainTimeoutMs: 25,
  });
  await authority.start();
  assert.deepEqual(fake.replies.map((r) => `${r.requestId}:${r.reply}`), ["r1:reject"]);
  const drainNote = authority.decisions().find((d) => d.tool === "(sibling drain)");
  assert.equal(drainNote?.decision, "observe");
  assert.match(drainNote?.reason ?? "", /timed out after 25ms/);
});

test("W186 broker: a permission listing FAILURE is journaled and the deny still lands", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-drainerr-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // The listing route errors (not a timeout). The deny must still be delivered,
  // and the failure must be journaled as an observe decision (review P3).
  const fake = fakeEngine([permission("r1", "subagent", { toolName: "subagent" }, "c1")]);
  const brokenEngine = {
    ...fake.engine,
    listPermissions: async () => {
      throw new Error("remote engine GET /permission failed (500): boom");
    },
  };
  const authority = createOpencodeServerAuthority({
    engine: brokenEngine,
    application: application(workspace, ["read", "mutation", "process"]), // no "spawn"
    workspace,
  });
  await authority.start();
  assert.deepEqual(fake.replies.map((r) => `${r.requestId}:${r.reply}`), ["r1:reject"]);
  const drainNote = authority.decisions().find((d) => d.tool === "(sibling drain)");
  assert.equal(drainNote?.decision, "observe");
  assert.match(drainNote?.reason ?? "", /permission list failed/);
});

test("W186 broker: ask-me does not drain (an allowed sibling stays held for the operator)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-drain3-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // In ask-me mode, the deny path must not auto-approve an allowed sibling: the
  // operator holds the pen. Only the arriving deny is answered.
  const fake = fakeEngine(
    [permission("r1", "subagent", { toolName: "subagent" }, "c1")],
    "complete",
    [permissionRequest("r1", "subagent", { toolName: "subagent" }, "c1"), permissionRequest("r2", "edit", { filePath: join(workspace, "src", "b.ts") }, "c2")],
  );
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    mode: "ask-me",
  });
  await authority.start();
  assert.deepEqual(fake.replies.map((reply) => reply.requestId), ["r1"], "only the deny is answered; the sibling is not drained");
  assert.equal(fake.replies[0]!.reply, "reject");
});

test("W071 broker: assertAskRuleset fails closed on a permissive ruleset", () => {
  assert.doesNotThrow(() => assertAskRuleset({ permission: { edit: "ask", bash: "ask", task: "ask" } }));
  assert.throws(() => assertAskRuleset({ permission: { edit: "allow", bash: "ask", task: "ask" } }), /not pinned to ask/);
  assert.throws(() => assertAskRuleset({}), /not pinned to ask/);
  assert.throws(() => assertAskRuleset(undefined), /not pinned to ask/);
});

test("W071 broker: assertAskRuleset accepts the v2 permissions array", () => {
  const v2 = (entries: readonly { action: string; resource?: string; effect: string }[]): Record<string, unknown> => ({ permissions: entries });
  // The live v2.0.10 resolution of `permission: {edit,bash,task: ask}` renames
  // bash->shell and task->subagent.
  assert.doesNotThrow(() => assertAskRuleset(v2([
    { action: "edit", resource: "*", effect: "ask" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "subagent", resource: "*", effect: "ask" },
    { action: "skill", resource: "*", effect: "deny" },
  ])));
  // A class left permissive in the v2 spelling fails closed.
  assert.throws(() => assertAskRuleset(v2([
    { action: "edit", resource: "*", effect: "ask" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "ask" },
  ])), /not pinned to ask for: bash/);
  // The renamed classes must be present, not merely the v1 spellings.
  assert.throws(() => assertAskRuleset(v2([
    { action: "edit", resource: "*", effect: "ask" },
    { action: "bash", resource: "*", effect: "ask" },
    { action: "task", resource: "*", effect: "ask" },
  ])), /not pinned to ask for: bash, task/);
  // A broader non-`*` resource does not pin the class.
  assert.throws(() => assertAskRuleset(v2([
    { action: "edit", resource: "*", effect: "ask" },
    { action: "shell", resource: "src/**", effect: "ask" },
    { action: "subagent", resource: "*", effect: "ask" },
  ])), /not pinned to ask for: bash/);
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

test("v2 sync: a v1-shaped tool part (name field) still advances the mutation epoch", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-v1-part-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const app = application(workspace, ["read", "mutation", "process"]);
  const beforeEpoch = app.snapshot().mutationEpoch;
  const observed = fakeEngine([
    permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }, "c1"),
    v1ToolPart("c1", "edit", "completed"),
  ]);
  const authority = createOpencodeServerAuthority({ engine: observed.engine, application: app, workspace });
  await authority.start();
  assert.ok(app.snapshot().mutationEpoch > beforeEpoch, "a v1-shaped completed mutation must still advance the epoch");
});

test("W071 broker: a completed DENIED mutation neither advances the epoch nor covers later activity (review P1-1)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-deny-obs-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const bypasses: string[] = [];
  const app = application(workspace, ["read", "process"]); // mutation withheld -> edit denied
  const epochBefore = app.snapshot().mutationEpoch;
  const fake = fakeEngine([
    permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }, "c1"),
    toolPart("c1", "edit", "completed"),
  ]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine, application: app, workspace,
    enforcement: "enforced",
    onBypass: (input) => bypasses.push(input.tool),
  });
  await authority.start();
  assert.equal(authority.decisions()[0]?.decision, "deny");
  assert.equal(app.snapshot().mutationEpoch, epochBefore, "a denied mutation must not advance the epoch");
  assert.deepEqual(bypasses, ["edit"], "a completed denied mutation must alarm, not be treated as covered");
});

test("W071 broker: session+tool coverage is consumed once, so a second unasked mutation alarms (review P1-2)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-consume-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const bypasses: string[] = [];
  const fake = fakeEngine([
    // No callID on the ask -> session+tool coverage, consumed by the first part.
    permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }),
    toolPart("c1", "edit", "completed"),
    // A second mutation of the same tool with no fresh decision.
    toolPart("c2", "edit", "completed"),
  ]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    enforcement: "enforced",
    onBypass: (input) => bypasses.push(input.tool),
  });
  await authority.start();
  assert.equal(authority.decisions()[0]?.decision, "allow", "the first edit is decided");
  assert.deepEqual(bypasses, ["edit"], "the second, uncovered edit must alarm");
});

test("W071 broker: a multi-event tool call (pending -> completed) neither alarms nor loses its mutation (fix-verify N1)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-multipart-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const bypasses: string[] = [];
  const app = application(workspace, ["read", "mutation", "process"]);
  const epochBefore = app.snapshot().mutationEpoch;
  const fake = fakeEngine([
    permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }, "c1"),
    // The real stream emits several updates for one call; only the terminal
    // completed observation may consume coverage.
    toolPart("c1", "edit", "pending"),
    toolPart("c1", "edit", "running"),
    toolPart("c1", "edit", "completed"),
  ]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine, application: app, workspace,
    enforcement: "enforced",
    onBypass: (input) => bypasses.push(input.tool),
  });
  await authority.start();
  assert.deepEqual(bypasses, [], "an allowed multi-event call must not alarm");
  assert.ok(app.snapshot().mutationEpoch > epochBefore, "the completed observation must record the mutation");
});

test("W071 broker: an UNDELIVERED allow never covers later activity (fix-verify N2)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-undelivered-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const bypasses: string[] = [];
  const app = application(workspace, ["read", "mutation", "process"]);
  const epochBefore = app.snapshot().mutationEpoch;
  const replies: string[] = [];
  const engine = {
    async *events() {
      yield permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }, "c1");
      yield toolPart("c1", "edit", "completed");
    },
    async replyPermission(input: { readonly reply: string }) {
      replies.push(input.reply);
      throw new Error("upstream reply failed");
    },
  } as unknown as Pick<RemoteEngine, "events" | "replyPermission">;
  const authority = createOpencodeServerAuthority({
    engine, application: app, workspace,
    enforcement: "enforced",
    onBypass: (input) => bypasses.push(input.tool),
  });
  await authority.start();
  assert.deepEqual(replies, ["once"]);
  assert.equal(authority.decisions()[0]?.delivered, false);
  assert.deepEqual(bypasses, ["edit"], "an undelivered allow must not cover the observed mutation");
  assert.equal(app.snapshot().mutationEpoch, epochBefore);
});

test("W071 broker: a 404 reply (v2 reject cascade) is journaled as already-resolved, not a transport loss", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-404-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const engine = {
    async *events() {
      // Two asks in one session: the live v2 wire raises one per pending tool.
      yield permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }, "c1");
      yield permission("r2", "edit", { filePath: join(workspace, "src", "b.ts") }, "c2");
    },
    async replyPermission(input: { readonly requestId: string; readonly reply: string }) {
      // The first reject drains siblings on v2, so the second reply 404s.
      if (input.requestId === "r2") {
        throw new Error("remote engine POST /api/session/s1/permission/r2/reply failed (404): ");
      }
    },
  } as unknown as Pick<RemoteEngine, "events" | "replyPermission">;
  const authority = createOpencodeServerAuthority({
    engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
  });
  await authority.start();
  const second = authority.decisions().find((d) => d.requestId === "r2");
  assert.equal(second?.delivered, false);
  assert.match(second?.reason ?? "", /already resolved upstream/);
  assert.doesNotMatch(second?.reason ?? "", /upstream reply failed/);
});

test("W071 broker: a non-resolution error that merely mentions 404 in its body is NOT relabeled", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-404body-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const engine = {
    async *events() {
      yield permission("r1", "edit", { filePath: join(workspace, "src", "a.ts") }, "c1");
    },
    async replyPermission() {
      // A 500 whose appended body happens to contain "404": the structured
      // status is 500, so this is a genuine transport failure, not a resolution.
      throw new Error("remote engine POST /x failed (500): internal error near line 404");
    },
  } as unknown as Pick<RemoteEngine, "events" | "replyPermission">;
  const authority = createOpencodeServerAuthority({
    engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
  });
  await authority.start();
  const decision = authority.decisions()[0];
  assert.equal(decision?.delivered, false);
  assert.match(decision?.reason ?? "", /upstream reply failed/);
  assert.doesNotMatch(decision?.reason ?? "", /already resolved upstream/);
});

test("W071 broker: the part's own sessionID is honored (review P2-1)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-partsession-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // No properties.sessionID; only the part carries it.
  const event: RemoteEngineEvent = {
    type: "message.part.updated",
    properties: { part: { type: "tool", sessionID: "s1", callID: "c1", tool: "edit", state: { status: "completed" } } },
  } as unknown as RemoteEngineEvent;
  const app = application(workspace, ["read", "mutation", "process"]);
  const authority = createOpencodeServerAuthority({
    engine: fakeEngine([event]).engine,
    application: app,
    workspace,
  });
  await authority.start();
  assert.equal(authority.decisions().length, 0, "no permission ask; the observer must still resolve the session");
});

test("W071 broker: read_skill matching is exact, not substring (review P3-3)", () => {
  assert.equal(opencodePermissionCapability("read_skill"), "read");
  assert.equal(opencodePermissionCapability("skills-mcp__read_skill"), "read");
  assert.equal(opencodePermissionCapability("evilread_skill"), undefined);
});

/**
 * v2 (live, 2.0.10) tool-activity: the `session.tool.*` family, not
 * `message.part.updated`. `called` carries the input in-flight; `success` is the
 * terminal settlement. Grounded in the v2 docs and
 * `packages/schema/src/session-event.ts` (`Tool.Called` / `Tool.Success`).
 */
function v2ToolCalled(callId: string, tool: string, input?: unknown): RemoteEngineEvent {
  return { type: "session.tool.called", properties: { sessionID: "s1", id: callId, name: tool, input } } as unknown as RemoteEngineEvent;
}

function v2ToolSuccess(callId: string, tool: string): RemoteEngineEvent {
  return { type: "session.tool.success", properties: { sessionID: "s1", id: callId, name: tool } } as unknown as RemoteEngineEvent;
}

/** A v2 `permission.asked` event as it arrives off the live wire (data payload). */
function v2Permission(id: string, action: string, sourceCallId: string, metadata: Record<string, unknown> = {}): RemoteEngineEvent {
  return {
    type: "permission.asked",
    properties: { id, sessionID: "s1", action, resources: [], save: [], metadata, source: { type: "tool", messageID: "m1", id: sourceCallId } },
  } as unknown as RemoteEngineEvent;
}

test("W071 broker (v2 wire): a data-wrapped permission.asked maps and is answered, not denied as unmappable", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-v2-wire-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const replies: { readonly sessionId: string; readonly requestId: string; readonly reply: string }[] = [];
  // The real events() parser feeds the broker; the raw frame is the live v2
  // `data` envelope that previously produced session=undefined and hung tools.
  const engine = {
    async *events() {
      for await (const event of new HttpRemoteEngine({
        baseUrl: "http://127.0.0.1:4096",
        cwd: workspace,
        eventReconnect: { maxAttempts: 0 },
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(
                  'data: {"id":"evt_1","created":1,"type":"permission.asked","location":{"directory":"/workspace"},'
                  + '"data":{"id":"per_1","sessionID":"s1","action":"shell","resources":["echo hi"],"save":["echo *"],'
                  + '"source":{"type":"tool","messageID":"m1","id":"call_1"}}}\n\n',
                ));
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      }).events({ cwd: workspace, signal: new AbortController().signal })) {
        yield event;
      }
    },
    async replyPermission(input: { readonly sessionId: string; readonly requestId: string; readonly reply: string }) {
      replies.push({ sessionId: input.sessionId, requestId: input.requestId, reply: input.reply });
    },
  } as unknown as Pick<RemoteEngine, "events" | "replyPermission">;
  const authority = createOpencodeServerAuthority({
    engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
  });
  await authority.start();
  assert.deepEqual(
    replies,
    [{ sessionId: "s1", requestId: "per_1", reply: "once" }],
    "the v2 data-wrapped ask must map to a real session/request id and be answered",
  );
  assert.equal(authority.decisions()[0]?.decision, "allow");
  assert.equal(authority.decisions()[0]?.delivered, true);
});

/** A v2 `permission.asked` whose subject rides `resources` (the live wire shape). */
function v2PermissionResources(id: string, action: string, resources: readonly string[], sourceCallId: string): RemoteEngineEvent {
  return {
    type: "permission.asked",
    properties: { id, sessionID: "s1", action, resources, save: [], metadata: {}, source: { type: "tool", messageID: "m1", id: sourceCallId } },
  } as unknown as RemoteEngineEvent;
}

test("W071 broker (v2 wire): an external_directory ask whose path rides `resources` denies by workspace confinement, not as unmappable", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-v2-extdir-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // Live v2 puts the directory in `resources` (metadata is empty); the subject
  // must map so the out-of-workspace path hits WORKSPACE_PATH_DENIED, the legible
  // denial, instead of failing closed as "invalid ACP tool subject".
  const fake = fakeEngine([v2PermissionResources("per_1", "external_directory", ["/app/src"], "call_1")]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
  });
  await authority.start();
  const decision = authority.decisions()[0];
  assert.equal(decision?.decision, "deny");
  assert.deepEqual(decision?.subjects, ["/app/src"]);
  assert.match(decision?.reason ?? "", /outside authorized workspace/);
  assert.doesNotMatch(decision?.reason ?? "", /unmappable permission request/);
});

test("W071 broker (v2 wire): an in-workspace edit whose path rides `resources` is allowed", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-v2-edit-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const target = join(workspace, "src", "a.ts");
  const fake = fakeEngine([v2PermissionResources("per_1", "edit", [target], "call_1")]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
  });
  await authority.start();
  assert.equal(authority.decisions()[0]?.decision, "allow");
  assert.deepEqual(authority.decisions()[0]?.subjects, [target]);
});

test("W071 broker (v2 wire): session.tool.success consumes coverage and records the mutation", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-v2-success-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const bypasses: string[] = [];
  const app = application(workspace, ["read", "mutation", "process"]);
  const epochBefore = app.snapshot().mutationEpoch;
  const fake = fakeEngine([
    v2Permission("r1", "edit", "call_1", { filePath: join(workspace, "src", "a.ts") }),
    v2ToolCalled("call_1", "edit", { filePath: join(workspace, "src", "a.ts") }),
    v2ToolSuccess("call_1", "edit"),
  ]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine, application: app, workspace,
    enforcement: "enforced",
    onBypass: (input) => bypasses.push(input.tool),
  });
  await authority.start();
  assert.deepEqual(bypasses, [], "the allowed v2 tool settlement must not alarm");
  assert.ok(app.snapshot().mutationEpoch > epochBefore, "the terminal v2 success must record the mutation");
});

test("W071 broker (v2 wire): an undecided v2 session.tool.success alarms in enforced posture", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-v2-bypass-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const bypasses: string[] = [];
  const fake = fakeEngine([
    // No permission ask; a mutating tool settles anyway.
    v2ToolCalled("call_1", "edit", { filePath: join(workspace, "src", "a.ts") }),
    v2ToolSuccess("call_1", "edit"),
  ]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    enforcement: "enforced",
    onBypass: (input) => bypasses.push(input.tool),
  });
  await authority.start();
  assert.deepEqual(bypasses, ["edit"], "a v2 mutation with no prior decision must alarm in enforced posture");
});

test("W071 broker: v2 execute/websearch/question tools are capability-mapped (review P2)", () => {
  assert.equal(opencodePermissionCapability("execute"), "process");
  assert.equal(opencodePermissionCapability("websearch"), "network");
  assert.equal(opencodePermissionCapability("question"), "read");
  // Agent-reported names outside the registry stay unmapped; the adapter's
  // kind-based classification (conservative) applies instead.
  assert.equal(opencodePermissionCapability("todowrite"), undefined);
});

// ── W092 (frontier G3 part 2): the guard's ask joins the operator hold ──────
// A guard `ask` is a "human decides" verdict, not a deny. In ask-me mode it
// joins the existing operator hold (approve answers the ask; reject/timeout
// fail closed); in auto-resolve mode it stays a documented deny (no operator
// is attached to answer). The W091 promotion gate is the named producer.

function fakeGuard(decision: { decision: "allow" | "deny" | "ask"; policy: string; reason: string }): WorkflowGuardProvider {
  return {
    capabilities: async () => [{ name: "guard_check" }],
    invoke: async () => decision,
    guardCheck: async () => decision,
    guardStatus: async () => ({ mode: "policy-advisor", enforcement: "host-dependent", executesActions: false }),
    close: async () => undefined,
  };
}

test("W092 broker (ask-me): a guard ask joins the operator hold and approve answers it", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-w092-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "bash", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    mode: "ask-me",
    guard: fakeGuard({ decision: "ask", policy: "promotion-gate", reason: "operator approval required (T1 promotion)" }),
  });
  const running = authority.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  assert.equal(authority.pendingOperatorReplies, 1, "the guard ask must be held for the operator");
  await authority.handleOperatorReply({ sessionId: "s1", requestId: "r1", reply: "once" });
  await running;
  assert.deepEqual(fake.replies, [{ sessionId: "s1", requestId: "r1", reply: "once" }]);
  assert.match(authority.decisions()[0]?.reason ?? "", /guard ask 'promotion-gate'/);
});

test("W092 broker (ask-me): the operator can reject a guard ask (tighten)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-w092-reject-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "bash", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    mode: "ask-me",
    guard: fakeGuard({ decision: "ask", policy: "promotion-gate", reason: "operator approval required (T1 promotion)" }),
  });
  const running = authority.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  assert.equal(authority.pendingOperatorReplies, 1, "the guard ask must be held for the operator");
  await authority.handleOperatorReply({ sessionId: "s1", requestId: "r1", reply: "reject" });
  await running;
  assert.deepEqual(fake.replies.map((r) => ({ sessionId: r.sessionId, requestId: r.requestId, reply: r.reply })), [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
});

test("W092 broker (ask-me): an unanswered guard ask times out to reject (fail closed)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-w092-timeout-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "bash", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    mode: "ask-me",
    operatorReplyTimeoutMs: 20,
    guard: fakeGuard({ decision: "ask", policy: "promotion-gate", reason: "operator approval required (T1 promotion)" }),
  });
  const running = authority.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  assert.equal(authority.pendingOperatorReplies, 1, "the guard ask must be held before the timeout");
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  await running;
  assert.deepEqual(fake.replies.map((r) => ({ sessionId: r.sessionId, requestId: r.requestId, reply: r.reply })), [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
});

test("W092 broker (auto-resolve): a guard ask fails closed to deny (no operator attached)", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-w092-auto-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "bash", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    guard: fakeGuard({ decision: "ask", policy: "promotion-gate", reason: "operator approval required (T1 promotion)" }),
  });
  await authority.start();
  assert.equal(authority.pendingOperatorReplies, 0);
  assert.deepEqual(fake.replies.map((r) => ({ sessionId: r.sessionId, requestId: r.requestId, reply: r.reply })), [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
  expectsRejectFeedback(fake.replies);
  assert.equal(authority.decisions()[0]?.decision, "deny");
  assert.match(authority.decisions()[0]?.reason ?? "", /auto-resolve/);
});

test("W092 broker: a guard deny is answered immediately, never held", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-broker-w092-deny-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fake = fakeEngine([permission("r1", "bash", {})]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    mode: "ask-me",
    guard: fakeGuard({ decision: "deny", policy: "guard-tamper", reason: "modifying live configuration is not allowed" }),
  });
  await authority.start();
  assert.equal(authority.pendingOperatorReplies, 0);
  assert.deepEqual(fake.replies.map((r) => ({ sessionId: r.sessionId, requestId: r.requestId, reply: r.reply })), [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
  expectsRejectFeedback(fake.replies);
  assert.match(authority.decisions()[0]?.reason ?? "", /guard-tamper/);
});