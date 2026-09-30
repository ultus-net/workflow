import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { hostCapabilities, type ToolCapability } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { createOpencodeServerGuard } from "../src/cli/opencode-server.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import {
  createOpencodeServerAuthority,
  type OpencodeServerAuthority,
} from "../src/integrations/opencode-server-authority.js";
import type { RemoteEngine, RemoteEngineEvent, RemoteEnginePermissionRequest } from "../src/integrations/remote-acp/engine.js";
import { ensureToolboxGuardBuilt } from "./fixtures/compiled-dist.js";

/**
 * W094 queued item: the daemon-level end-to-end ask pin.
 *
 * W092 proves the authority's guard-ask hold with a FAKE guard; W094 proves the
 * daemon's guard composition returns the production promotion ask through the
 * REAL vendored server. Neither crosses the two: no test proves the daemon's
 * composed guard reaches the authority's operator hold. This pin closes that
 * verification gap offline by composing the EXACT daemon guard helper
 * (`createOpencodeServerGuard`, the same one main() passes to the authority)
 * with the production authority broker, then driving a `permission.asked` for
 * the W091 promotion command. The real HTTP/SSE engine spawn stays live
 * (operator-gated); this exercises guard -> authority -> hold end to end.
 *
 * The build uses the shared W120/W133 STALE-AWARE self-healing helper (review
 * P3 item 3): the prior local existence-only copy could run a stale enforcement
 * seat after a src change without a rebuild.
 */

interface FakeEngine {
  readonly engine: Pick<RemoteEngine, "events" | "replyPermission">;
  readonly replies: { readonly sessionId: string; readonly requestId: string; readonly reply: string }[];
}

function fakeEngine(events: readonly RemoteEngineEvent[]): FakeEngine {
  const replies: { sessionId: string; requestId: string; reply: string }[] = [];
  return {
    replies,
    engine: {
      async *events() {
        for (const event of events) yield event;
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

/** Polls until the authority holds the ask (the real guard check is an async MCP round-trip). */
async function waitForHold(authority: OpencodeServerAuthority, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (authority.pendingOperatorReplies === 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

test("W094 e2e: the daemon's real guard ask reaches the authority's operator hold", async (t) => {
  ensureToolboxGuardBuilt();
  const workspace = mkdtempSync(join(tmpdir(), "wf-w094-e2e-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // The production composition main() uses, unchanged.
  const guard = await createOpencodeServerGuard(workspace);
  t.after(() => guard.close());

  const fake = fakeEngine([permission("r1", "bash", { command: "workflow install fleet" })]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    mode: "ask-me",
    guard,
  });
  const running = authority.start();
  await waitForHold(authority);
  assert.equal(authority.pendingOperatorReplies, 1, "the real guard's promotion ask must join the operator hold");
  await authority.handleOperatorReply({ sessionId: "s1", requestId: "r1", reply: "once" });
  await running;
  assert.deepEqual(fake.replies, [{ sessionId: "s1", requestId: "r1", reply: "once" }]);
  const held = authority.decisions()[0];
  assert.equal(held?.decision, "allow");
  assert.equal(held?.reply, "once");
  assert.match(held?.reason ?? "", /guard ask 'promotion-gate'/);
});

test("W094 e2e: the daemon's real guard ask times out to reject (fail closed)", async (t) => {
  ensureToolboxGuardBuilt();
  const workspace = mkdtempSync(join(tmpdir(), "wf-w094-e2e-timeout-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const guard = await createOpencodeServerGuard(workspace);
  t.after(() => guard.close());

  const fake = fakeEngine([permission("r1", "bash", { command: "workflow install fleet" })]);
  const authority = createOpencodeServerAuthority({
    engine: fake.engine,
    application: application(workspace, ["read", "mutation", "process"]),
    workspace,
    mode: "ask-me",
    operatorReplyTimeoutMs: 2_000,
    guard,
  });
  const running = authority.start();
  await waitForHold(authority);
  assert.equal(authority.pendingOperatorReplies, 1, "the ask must be held before the timeout");
  // No operator answers: the hold must fail closed to reject on its own.
  const deadline = Date.now() + 8_000;
  while (authority.pendingOperatorReplies > 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  await running;
  assert.deepEqual(fake.replies, [{ sessionId: "s1", requestId: "r1", reply: "reject" }]);
});
