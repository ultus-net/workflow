import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OpenCodeHostAdapter,
  TaskGraph,
  WorkflowApplication,
  hostCapabilities,
  taskId,
} from "../src/index.js";
import { createWorkflowHubBridge, type WorkflowHubBridge } from "../src/integrations/hub-http.js";
import type { GuardDecision, WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";
import { PermissionBroker } from "../src/ui/permission-broker.js";

/**
 * P6 hub answer route (issue #285): the hub process composes a
 * `PermissionBroker` and serves its pending/answer path on the existing hub HTTP
 * bridge, so a guard `ask` held by the containment seat (which runs IN the hub
 * process) is answerable — not the 120s park-then-deny. A production
 * composition root for the OpenCode plugin factory is added in the same pass so
 * that factory composes `broker.askHold()` rather than only in tests.
 *
 * Pins: (1) a hub-held ask is answerable via the mounted route; (2) a reject
 * denies fail closed and an unanswered ask times out to reject; (3) the plugin
 * composition root attaches a broker-derived hold; (4) the no-operator posture
 * is unchanged (no broker → route 404s).
 */

class FakeGuard {
  constructor(private readonly decision: GuardDecision) {}
  async capabilities() {
    return [];
  }
  async invoke() {
    return undefined;
  }
  async guardCheck(): Promise<GuardDecision> {
    return this.decision;
  }
  async guardStatus() {
    return { mode: "policy-advisor", enforcement: "host-dependent", executesActions: false };
  }
  async close() {}
}

function askGuard(): WorkflowGuardProvider {
  return new FakeGuard({ decision: "ask", policy: "promotion-gate", reason: "promotion requires operator approval" }) as unknown as WorkflowGuardProvider;
}

function application(): WorkflowApplication {
  const id = taskId("p6-hub-answer");
  const app = new WorkflowApplication(
    new TaskGraph([{ id, title: "P6 hub answer", state: "READY", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    process.cwd(),
  );
  app.startInteractiveTask();
  return app;
}

interface PermissionBody {
  available: boolean;
  mode: string;
  pending: { id: string; tool: string } | null;
  pendingAsks: readonly { requestId: string; policy: string }[];
  patterns: { alwaysAllow: readonly string[]; alwaysReject: readonly string[] };
}

async function postPermission(bridge: WorkflowHubBridge, body: unknown): Promise<{ status: number; json: PermissionBody }> {
  const response = await fetch(`${bridge.url}/api/permission`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as PermissionBody };
}

async function withBridge(
  capabilities: Parameters<typeof createWorkflowHubBridge>[8],
  run: (bridge: WorkflowHubBridge) => Promise<void>,
): Promise<void> {
  const bridge = await createWorkflowHubBridge(application(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, capabilities);
  try {
    await run(bridge);
  } finally {
    await bridge.close();
  }
}

test("P6 hub answer route: a hub-held ask is answerable via the mounted route", async () => {
  // The containment seat composes the hold from the SAME broker the route
  // serves. Park an ask the way the seat would, then answer it over HTTP.
  const broker = new PermissionBroker();
  await withBridge({ permissionBroker: broker }, async (bridge) => {
    const hold = broker.askHold();
    try {
      const parked = hold.park({ requestId: "contained-process-ask-1", policy: "promotion-gate", reason: "promotion requires operator approval" });

      // The poll (an id-less POST) projects the held ask on the broker transport.
      const poll = await postPermission(bridge, {});
      assert.equal(poll.status, 200);
      assert.equal(poll.json.available, true);
      assert.equal(poll.json.pending?.tool, "promotion-gate", "the held ask rides the permission-card shape");
      assert.equal(poll.json.pendingAsks[0]?.requestId, "contained-process-ask-1");

      // The answer (id + decision) resolves it through the broker's answer().
      const answered = await postPermission(bridge, { id: poll.json.pending?.id, decision: "allow_once" });
      assert.equal(answered.status, 200);
      assert.equal(answered.json.pending, null, "the answered ask no longer pends");
      assert.equal(await parked, "once", "an operator allow resolves the held ask to the policy-allowed outcome");
    } finally {
      hold.cancelAll();
    }
  });
});

test("P6 hub answer route: a reject denies fail closed and an unanswered ask times out to reject", async () => {
  const broker = new PermissionBroker();
  await withBridge({ permissionBroker: broker }, async (bridge) => {
    const hold = broker.askHold();
    try {
      const parked = hold.park({ requestId: "contained-process-ask-2", policy: "promotion-gate", reason: "needs operator" });
      const poll = await postPermission(bridge, {});
      const answered = await postPermission(bridge, { id: poll.json.pending?.id, decision: "reject_once" });
      assert.equal(answered.status, 200);
      assert.equal(await parked, "reject", "a reject denies the held ask fail closed");
    } finally {
      hold.cancelAll();
    }
  });

  // The timeout dialect is the broker's own (the route never widens it): an
  // unanswered ask resolves reject.
  const timeoutBroker = new PermissionBroker();
  const timedOut = await timeoutBroker.parkAsk({ requestId: "ask-timeout", policy: "promotion-gate", reason: "unanswered" }, undefined, 5);
  assert.equal(timedOut, "reject", "an unanswered hold never allows");
});

test("P6 hub answer route: the plugin composition root attaches a broker-derived hold", async () => {
  const { createWorkflowOpenCodePluginRoot } = await import("../src/integrations/opencode-plugin-root.js");
  const id = taskId("opencode-plugin-root");
  const adapter = new OpenCodeHostAdapter({ taskId: id, capabilityForTool: () => "read" });
  const app = new WorkflowApplication(
    new TaskGraph([{ id, title: "OpenCode hook", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    adapter.capabilities,
    [],
    new Set(["read", "mutation", "process"]),
  );
  assert.equal(app.transition(id, "IN_PROGRESS").kind, "accepted");

  const root = createWorkflowOpenCodePluginRoot(app, adapter, askGuard(), { sessionKey: "plugin-1" });
  try {
    const pending = root.plugin["tool.execute.before"](
      { tool: "bash", sessionID: "session-ask", callID: "call-ask" },
      { args: { command: "workflow install fleet" } },
    ).then(() => undefined, (error: unknown) => error);

    // Poll the root's OWN broker — the same-process answer surface the host owns.
    let parked = root.permissionBroker.pendingRequest("plugin-1");
    for (let i = 0; parked === undefined && i < 1000; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      parked = root.permissionBroker.pendingRequest("plugin-1");
    }
    assert.equal(parked?.tool, "promotion-gate", "the plugin hold is derived from the root's broker");
    assert.equal(root.permissionBroker.answer(parked!.id, "allow_once", "plugin-1"), true);
    assert.equal(await pending, undefined, "an operator allow lets the host tool proceed");
  } finally {
    root.permissionBroker.cancelAsks();
  }
});

test("P6 hub answer route: the no-operator posture is unchanged (no broker → route 404s)", async () => {
  await withBridge({}, async (bridge) => {
    const poll = await postPermission(bridge, {});
    assert.equal(poll.status, 404, "a hub with no broker serves no answer route (fail closed)");
  });
});
