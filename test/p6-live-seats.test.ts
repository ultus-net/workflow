import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OpenCodeHostAdapter,
  TaskGraph,
  WorkflowApplication,
  createWorkflowOpenCodePlugin,
  hostCapabilities,
  taskId,
} from "../src/index.js";
import type { GuardDecision, WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";
import { shellExecutorFor } from "../src/integrations/run-controller.js";
import { PermissionBroker, type PendingPermissionRequest } from "../src/ui/permission-broker.js";

/**
 * P6 live seats (issue #285): the two remaining seats ride the broker's ONE
 * answer transport (`PermissionBroker.askHold`). The ACP permission resolver
 * and the hub fs seat already compose the broker-backed hold
 * (docs/ledger/ask-answer-surface.md); these pins compose a broker-backed hold
 * at (a) the containment process seat's production composition helper
 * `shellExecutorFor` and (b) the in-process OpenCode plugin factory, and prove
 * an ask parks on the SAME `/api/permission` transport a permission prompt uses
 * (`pendingRequest`/`answer`) and is answerable there. `trustedRole` stays
 * unsupplied (brief §5).
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
  const id = taskId("p6-live");
  const app = new WorkflowApplication(
    new TaskGraph([{ id, title: "P6 seat", state: "READY", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    process.cwd(),
  );
  app.startInteractiveTask();
  return app;
}

/** Polls the broker's unified pending transport until the seat has parked. */
async function waitForPending(broker: PermissionBroker, key: string): Promise<PendingPermissionRequest> {
  for (let i = 0; i < 1000; i += 1) {
    const pending = broker.pendingRequest(key);
    if (pending !== undefined) return pending;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the seat never parked on the broker's unified transport");
}

test("P6 live seats: the containment seat's production helper composes the broker-backed hold", async () => {
  const broker = new PermissionBroker();
  const executor = shellExecutorFor(application(), undefined, false, askGuard(), undefined, broker.askHold("run-gate"));
  const pending = executor("/bin/true", process.cwd(), undefined).then(
    () => undefined,
    (error: unknown) => error,
  );

  const parked = await waitForPending(broker, "run-gate");
  assert.equal(parked.tool, "promotion-gate", "the guard ask rides the permission transport's shape");
  assert.equal(parked.mutating, false);
  assert.equal(broker.answer(parked.id, "reject_once", "run-gate"), true, "the owning key answers on the one transport");

  const error = await pending;
  assert.ok(error instanceof Error, "a rejected ask must fail the contained command closed");
  assert.match(error.message, /guard ask 'promotion-gate' denied \(operator reject or hold timeout, failing closed\)/);
});

test("P6 live seats: the OpenCode plugin factory composes the broker-backed hold (the 4th arg)", async () => {
  const broker = new PermissionBroker();
  const id = taskId("opencode-plugin-live");
  const adapter = new OpenCodeHostAdapter({ taskId: id, capabilityForTool: () => "read" });
  const app = new WorkflowApplication(
    new TaskGraph([{ id, title: "OpenCode hook", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    adapter.capabilities,
    [],
    new Set(["read", "mutation", "process"]),
  );
  assert.equal(app.transition(id, "IN_PROGRESS").kind, "accepted");
  const plugin = createWorkflowOpenCodePlugin(app, adapter, askGuard(), broker.askHold("web-1"));

  const input = { tool: "bash", sessionID: "session-ask", callID: "call-ask" };
  const output = { args: { command: "workflow install fleet" } };
  const pending = plugin["tool.execute.before"](input, output).then(
    () => undefined,
    (error: unknown) => error,
  );

  const parked = await waitForPending(broker, "web-1");
  assert.equal(parked.tool, "promotion-gate");
  assert.equal(broker.answer(parked.id, "allow_once", "web-1"), true);

  assert.equal(await pending, undefined, "an operator allow lets the host tool proceed");
});

test("P6 live seats: the no-operator posture is unchanged at both seats", async () => {
  // Regression fence (brief Q3): no hold means no operator channel, so an ask
  // still fails closed with the byte-identical guard-deny message at both seats.
  await assert.rejects(
    () => shellExecutorFor(application(), undefined, false, askGuard())("/bin/true", process.cwd(), undefined),
    /guard denied process execution: promotion-gate: promotion requires operator approval/,
  );

  const id = taskId("opencode-plugin-no-hold");
  const adapter = new OpenCodeHostAdapter({ taskId: id, capabilityForTool: () => "read" });
  const app = new WorkflowApplication(
    new TaskGraph([{ id, title: "OpenCode hook", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    adapter.capabilities,
    [],
    new Set(["read", "mutation", "process"]),
  );
  assert.equal(app.transition(id, "IN_PROGRESS").kind, "accepted");
  const plugin = createWorkflowOpenCodePlugin(app, adapter, askGuard());
  await assert.rejects(
    () => plugin["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "workflow install fleet" } }),
    /guard policy 'promotion-gate'/,
  );
});
