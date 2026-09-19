import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { hostCapabilities, type ToolCapability } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import {
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

function permission(id: string, action: string, metadata: Record<string, unknown>): RemoteEngineEvent {
  const request: RemoteEnginePermissionRequest = { id, sessionID: "s1", action, resources: [], metadata };
  return { type: "permission.asked", properties: request };
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

test("W071 broker: operator replies are journaled as observation in M2", async (t) => {
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
  authority.handleOperatorReply({ sessionId: "s1", requestId: "r9", reply: "once" });
  assert.equal(journaled.length, 1);
  assert.match(journaled[0]?.reason ?? "", /auto-resolve mode/);
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