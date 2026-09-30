import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { createWorkflowHubBridge, type WorkflowHubBridge } from "../src/integrations/hub-http.js";
import type { GuardDecision, WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId } from "../src/kernel/contracts.js";
import { PermissionBroker } from "../src/ui/permission-broker.js";

/**
 * P6 daemon-level ask pin (issue #285): a guard `ask` raised by the hub's own
 * containment `/bash` seat parks on the SAME-PROCESS `PermissionBroker` the hub
 * mounts, and is answered over the REAL hub HTTP route (`POST /api/permission`)
 * — so the command proceeds instead of riding the 120s park-then-deny. A
 * reject denies fail closed through the same route. This exercises the real
 * bridge (source, over fetch), the real `/bash` seat, and the real
 * `shellExecutorFor` hold composition end to end; the guard is scripted to
 * return `ask` so the lane is deterministic without the vendored MCP corpus.
 */

class FakeGuard {
  public readonly commands: string[] = [];
  constructor(private readonly decision: GuardDecision) {}
  async capabilities() {
    return [];
  }
  async invoke() {
    return undefined;
  }
  async guardCheck(input: { command?: string }): Promise<GuardDecision> {
    if (typeof input.command === "string") this.commands.push(input.command);
    return this.decision;
  }
  async guardStatus() {
    return { mode: "policy-advisor", enforcement: "host-dependent", executesActions: false };
  }
  async close() {}
}

function askGuard(): FakeGuard {
  return new FakeGuard({ decision: "ask", policy: "promotion-gate", reason: "promotion requires operator approval" });
}

function application(workspace: string): WorkflowApplication {
  const id = taskId("p6-hub-ask");
  const app = new WorkflowApplication(
    new TaskGraph([{ id, title: "P6 hub ask e2e", state: "READY", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    workspace,
  );
  app.startInteractiveTask();
  return app;
}

type Capabilities = Parameters<typeof createWorkflowHubBridge>[8];

async function post(endpoint: string, token: string | undefined, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** Polls the real hub route until the seat's ask parks (the seat parks after
 * `application.authorize` and before containment). */
async function waitForParkedAsk(
  endpoint: string,
  token: string,
): Promise<{ id: string; requestId: string; tool: string }> {
  for (let i = 0; i < 2000; i += 1) {
    const poll = await post(endpoint, token, "/api/permission", {});
    assert.equal(poll.status, 200);
    const pending = poll.json.pending as { id?: unknown; tool?: unknown } | null;
    const asks = poll.json.pendingAsks as readonly { requestId?: unknown; policy?: unknown }[];
    if (pending !== null && typeof pending?.id === "string" && asks.length > 0) {
      return {
        id: pending.id,
        requestId: String(asks[0]!.requestId),
        tool: String(pending.tool),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("the guard ask never parked on the hub's broker");
}

async function withBridge(
  workspace: string,
  guard: WorkflowGuardProvider,
  broker: PermissionBroker,
  run: (bridge: WorkflowHubBridge) => Promise<void>,
): Promise<void> {
  const capabilities: Capabilities = { permissionBroker: broker };
  const bridge = await createWorkflowHubBridge(application(workspace), undefined, undefined, undefined, guard, undefined, undefined, undefined, capabilities);
  try {
    await run(bridge);
  } finally {
    await bridge.close();
  }
}

test("P6 daemon ask e2e: a hub /bash guard ask parks and an operator allow runs the command", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "p6-hub-ask-ws-"));
  const broker = new PermissionBroker();
  const guard = askGuard();
  try {
    await withBridge(workspace, guard, broker, async (bridge) => {
      // Fire the real /bash lane; it will block on the held ask.
      const bash = post(bridge.url, bridge.token, "/bash", { cwd: workspace, command: "echo hub-ask-e2e" });
      const parked = await waitForParkedAsk(bridge.url, bridge.token);
      assert.match(parked.requestId, /^contained-process-ask-/, "the containment seat synthesizes the ask request id");
      assert.equal(parked.tool, "promotion-gate", "the held ask rides the permission-card shape");
      assert.deepEqual(guard.commands, ["echo hub-ask-e2e"], "the seat consulted the guard for the command");

      const answered = await post(bridge.url, bridge.token, "/api/permission", { id: parked.id, decision: "allow_once" });
      assert.equal(answered.status, 200);
      assert.equal(answered.json.pending, null, "the answered ask no longer pends");

      const result = await bash;
      assert.equal(result.status, 200, `the approved command ran — observed: ${JSON.stringify(result.json)}`);
      assert.deepEqual(result.json, { output: "hub-ask-e2e\n" });
    });
  } finally {
    broker.cancelAsks();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("P6 daemon ask e2e: an operator reject denies fail-closed through the same route", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "p6-hub-ask-ws-"));
  const broker = new PermissionBroker();
  const guard = askGuard();
  try {
    await withBridge(workspace, guard, broker, async (bridge) => {
      const bash = post(bridge.url, bridge.token, "/bash", { cwd: workspace, command: "echo never-runs" });
      const parked = await waitForParkedAsk(bridge.url, bridge.token);
      const answered = await post(bridge.url, bridge.token, "/api/permission", { id: parked.id, decision: "reject_once" });
      assert.equal(answered.status, 200);
      const result = await bash;
      assert.equal(result.status, 500, "a rejected ask refuses the process fail-closed");
      assert.match(String(result.json.error), /guard ask 'promotion-gate' denied \(operator reject or hold timeout, failing closed\)/);
    });
  } finally {
    broker.cancelAsks();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("P6 daemon ask e2e: an unanswered ask times out to reject (the broker's own dialect, never widened)", async () => {
  const broker = new PermissionBroker();
  const reply = await broker.parkAsk({ requestId: "ask-timeout", policy: "promotion-gate", reason: "unanswered" }, undefined, 5);
  assert.equal(reply, "reject", "an unanswered hold never allows");
});
