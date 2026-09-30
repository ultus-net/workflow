import assert from "node:assert/strict";
import { test } from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { WorkflowContainedProcess } from "../src/containment/workflow-process.js";
import type { ContainedProcessRequest, ContainedProcessResult, ProcessContainment } from "../src/containment/contracts.js";
import type { GuardDecision, WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId } from "../src/kernel/contracts.js";
import { PermissionBroker } from "../src/ui/permission-broker.js";
import { createPermissionAnswerServer, permissionAnswerRoute, type PermissionAnswerServer } from "../src/ui/permission-broker-route.js";

/**
 * P6 standalone contained-shell seat (issue #285): the standalone seat composes
 * a SAME-PROCESS `PermissionBroker` and serves its ONE pending/answer transport
 * (`permissionAnswerRoute`; the same body classifier the hub `/api/permission`
 * route uses) on a dedicated loopback answer route. A guard `ask` raised by the
 * standalone containment seat parks on `broker.askHold()` and is answerable
 * there — instead of the 120s park-then-deny. No cross-process plumbing: the
 * broker, the seat, and the route live in one process.
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

function askGuard(): WorkflowGuardProvider {
  return new FakeGuard({ decision: "ask", policy: "promotion-gate", reason: "promotion requires operator approval" }) as unknown as WorkflowGuardProvider;
}

function application(): WorkflowApplication {
  const id = taskId("p6-standalone");
  const app = new WorkflowApplication(
    new TaskGraph([{ id, title: "P6 standalone answer", state: "READY", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "process"]),
    process.cwd(),
  );
  app.startInteractiveTask();
  return app;
}

/** A containment double that records whether an approved request reached it. */
function recordingContainment(): ProcessContainment & { readonly executed: ContainedProcessRequest[] } {
  const executed: ContainedProcessRequest[] = [];
  return {
    isolation: "enforced" as const,
    executed,
    execute: async (request: ContainedProcessRequest): Promise<ContainedProcessResult> => {
      executed.push(request);
      return { exitCode: 0, stdout: "", stderr: "", enforcement: "enforced", network: "isolated", credentials: "cleared" };
    },
  };
}

const request: ContainedProcessRequest = { executable: "/bin/bash", args: ["-c", "echo standalone"], cwd: process.cwd() };

function fullAction() {
  return { tool: "execute_command", input: {}, mutating: true, capability: "process" as const, requiredCapabilities: ["process"], subjects: [], taskId: taskId("p6-standalone"), sessionId: "standalone" } as const;
}

async function post(server: PermissionAnswerServer, body: unknown, token: string = server.token): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${server.url}/api/permission`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

test("P6 standalone answer route: the broker's pending/answer transport is served on its own loopback route", async () => {
  const broker = new PermissionBroker();
  const server = await createPermissionAnswerServer(broker);
  const hold = broker.askHold();
  try {
    const parked = hold.park({ requestId: "contained-process-ask-1", policy: "promotion-gate", reason: "promotion requires operator approval" });

    const poll = await post(server, {});
    assert.equal(poll.status, 200);
    assert.equal(poll.json.available, true);
    const pending = poll.json.pending as { id: string; tool: string };
    assert.equal(pending.tool, "promotion-gate", "the held ask rides the permission-card shape");
    assert.equal((poll.json.pendingAsks as readonly { requestId: string }[])[0]!.requestId, "contained-process-ask-1");

    const answered = await post(server, { id: pending.id, decision: "allow_once" });
    assert.equal(answered.status, 200);
    assert.equal(answered.json.pending, null, "the answered ask no longer pends");
    assert.equal(await parked, "once", "an operator allow resolves the held ask");
  } finally {
    hold.cancelAll();
    await server.close();
  }
});

test("P6 standalone answer route: a reject denies fail-closed and an unanswered ask times out to reject", async () => {
  const broker = new PermissionBroker();
  const server = await createPermissionAnswerServer(broker);
  const hold = broker.askHold();
  try {
    const parked = hold.park({ requestId: "contained-process-ask-2", policy: "promotion-gate", reason: "needs operator" });
    const poll = await post(server, {});
    const pending = poll.json.pending as { id: string };
    const answered = await post(server, { id: pending.id, decision: "reject_once" });
    assert.equal(answered.status, 200);
    assert.equal(await parked, "reject", "a reject denies the held ask fail closed");
  } finally {
    hold.cancelAll();
    await server.close();
  }

  // The timeout dialect is the broker's own; the route never widens it.
  const timeoutBroker = new PermissionBroker();
  assert.equal(await timeoutBroker.parkAsk({ requestId: "ask-timeout", policy: "promotion-gate", reason: "unanswered" }, undefined, 5), "reject");
});

test("P6 standalone seat: the containment seat composes the broker hold and the route answers it end-to-end", async () => {
  const broker = new PermissionBroker();
  const server = await createPermissionAnswerServer(broker);
  const containment = recordingContainment();
  const seat = new WorkflowContainedProcess(application(), containment, askGuard(), broker.askHold());
  try {
    const pending = seat.execute(fullAction(), request);
    // Poll the route until the seat has parked the ask.
    let parked: { id: string; requestId: string } | undefined;
    for (let i = 0; i < 2000 && parked === undefined; i += 1) {
      const poll = await post(server, {});
      const ask = (poll.json.pendingAsks as readonly { requestId: string }[])[0];
      const p = poll.json.pending as { id: string } | null;
      if (ask !== undefined && p !== null) parked = { id: p.id, requestId: ask.requestId };
      else await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(parked !== undefined, "the seat's guard ask must park on the broker");
    assert.match(parked!.requestId, /^contained-process-ask-/);

    const answered = await post(server, { id: parked!.id, decision: "allow_once" });
    assert.equal(answered.status, 200);
    const result = await pending;
    assert.equal(result.exitCode, 0, "operator approval must reach containment");
    assert.equal(containment.executed.length, 1, "the approved process executed exactly once");
  } finally {
    broker.cancelAsks();
    await server.close();
  }
});

test("P6 standalone answer route: the route requires its bearer token and serves only the permission path", async () => {
  const broker = new PermissionBroker();
  const server = await createPermissionAnswerServer(broker);
  try {
    const untokenized = await fetch(`${server.url}/api/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(untokenized.status, 401, "the answer route must not be reachable uncredentialed");
    const wrongPath = await fetch(`${server.url}/bash`, { method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: "{}" });
    assert.equal(wrongPath.status, 404, "only the permission answer path is served");
    // The shared body classifier is the route's core: a non-record body and an
    // answer id without a valid decision are client faults.
    assert.equal(permissionAnswerRoute(broker, "not-a-record").status, 400);
    assert.equal(permissionAnswerRoute(broker, { id: "perm-x", decision: "maybe" }).status, 400);
  } finally {
    await server.close();
  }
});
