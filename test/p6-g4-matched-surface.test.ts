import assert from "node:assert/strict";
import { test } from "node:test";

import { TaskGraph, WorkflowApplication, hostCapabilities, taskId } from "../src/index.js";
import type { GuardDecision, WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";
import { shellExecutorFor } from "../src/integrations/run-controller.js";
import { PermissionBroker, transportPermissionView, type PendingPermissionRequest } from "../src/ui/permission-broker.js";

/**
 * P6 G4 matched surface (issue #285): the W121 `GuardDecision.matched` field
 * (the concrete surface a guard rule matched) must be a QUERYABLE field on the
 * broker's ONE answer surface when a seat parks a guard `ask` — not only
 * embedded in `input`/`tool` (LESS-0046: the matched surface is a query, not
 * prose). Absent-never-fabricated: an ask whose rule matched no surface, and a
 * permission prompt (no rule ran), carry no `matched`.
 *
 * The field is the ask-path projection of G4; the seats already forward
 * `matched` (acp-workflow-resolver / acp-session fs / opencode-plugin /
 * containment), so this pins the last leg — the answer-surface projection.
 *
 * Posture unchanged: a held ask is a policy decision (not a tool pattern), so
 * reject/timeout fails closed and tighten-never-loosen holds; no-operator still
 * denies immediately.
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

function guardWith(decision: GuardDecision): WorkflowGuardProvider {
  return new FakeGuard(decision) as unknown as WorkflowGuardProvider;
}

function application(): WorkflowApplication {
  const id = taskId("p6-g4-matched");
  const app = new WorkflowApplication(
    new TaskGraph([{ id, title: "P6 G4", state: "READY", dependencies: [], requiredEvidence: [] }]),
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

test("P6 G4: the rule-matched surface rides first-class onto the broker answer surface", async () => {
  const broker = new PermissionBroker();
  try {
    const executor = shellExecutorFor(
      application(),
      undefined,
      false,
      guardWith({ decision: "ask", policy: "protected-path", reason: "protected write requires operator approval", matched: "/etc/hosts" }),
      undefined,
      broker.askHold("g4-gate"),
    );
    const pending = executor("/bin/true", process.cwd(), undefined).then(
      () => undefined,
      (error: unknown) => error,
    );

    const parked = await waitForPending(broker, "g4-gate");
    assert.equal(parked.matched, "/etc/hosts", "the matched surface is queryable, not only embedded in input/tool");
    // The /api/permission projection ("the answer surface") preserves it too.
    assert.equal(transportPermissionView(parked)?.matched, "/etc/hosts", "the transport view carries the matched surface through");
    assert.equal((parked.input as { matched?: unknown }).matched, "/etc/hosts", "the structured input echoes it");

    assert.equal(broker.answer(parked.id, "allow_once", "g4-gate"), true);
    assert.equal(await pending, undefined, "an operator allow proceeds (posture unchanged)");
  } finally {
    broker.cancelPending("test cleanup");
  }
});

test("P6 G4: an unmatched ask and a permission prompt record no matched surface (absent, never fabricated)", async () => {
  // A guard rule that matched no concrete surface (e.g. the promotion gate).
  const broker = new PermissionBroker();
  try {
    const executor = shellExecutorFor(
      application(),
      undefined,
      false,
      guardWith({ decision: "ask", policy: "promotion-gate", reason: "promotion requires operator approval" }),
      undefined,
      broker.askHold("g4-unmatched"),
    );
    const pending = executor("/bin/true", process.cwd(), undefined).then(
      () => undefined,
      (error: unknown) => error,
    );

    const parked = await waitForPending(broker, "g4-unmatched");
    assert.equal(parked.matched, undefined, "an unmatched ask has no matched surface");
    assert.equal("matched" in parked, false, "the field is absent, never fabricated");
    assert.equal(broker.answer(parked.id, "reject_once", "g4-unmatched"), true);
    assert.ok((await pending) instanceof Error, "a rejected ask fails the contained command closed");
  } finally {
    broker.cancelPending("test cleanup");
  }

  // A permission prompt is a tool proposal, not a rule-match: its tool is NOT a
  // matched surface.
  const promptBroker = new PermissionBroker();
  try {
    promptBroker.setMode("ask");
    const decision = promptBroker.intercept(
      {
        sessionId: "prompt-session",
        taskId: taskId("p6-g4-prompt"),
        tool: "bash",
        mutating: true,
        subjects: [],
        input: { command: "echo hi" },
      },
      () => ({ kind: "allow" }),
    );
    const prompt = await waitForPending(promptBroker, "prompt-session");
    assert.equal(prompt.matched, undefined, "a permission prompt carries no matched surface");
    assert.equal(promptBroker.answer(prompt.id, "reject_once", "prompt-session"), true);
    assert.deepEqual(await decision, { kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator" });
  } finally {
    promptBroker.cancelPending("test cleanup");
  }
});

test("P6 G4: tighten-never-loosen holds for a matched ask (an allow_always is only once, no grant)", async () => {
  const broker = new PermissionBroker();
  try {
    const parked = broker.parkAsk(
      { requestId: "g4-matched-ask", policy: "protected-path", reason: "protected write", matched: "/etc/hosts" },
      "g4-scope",
    );
    const pending = broker.pendingRequest("g4-scope");
    assert.equal(pending?.matched, "/etc/hosts");

    assert.equal(broker.answerAsk("g4-matched-ask", "always", "g4-scope"), true);
    assert.equal(await parked, "once", "an ask answer never widens to a persistent grant");
    assert.deepEqual(broker.patterns().alwaysAllow, [], "no always-allow grant is recorded from an ask");
  } finally {
    broker.cancelPending("test cleanup");
  }
});

test("P6 G4: the no-operator posture is unchanged (no hold -> immediate fail closed)", async () => {
  await assert.rejects(
    () =>
      shellExecutorFor(
        application(),
        undefined,
        false,
        guardWith({ decision: "ask", policy: "protected-path", reason: "protected write requires operator approval", matched: "/etc/hosts" }),
      )("/bin/true", process.cwd(), undefined),
    /guard denied process execution: protected-path: protected write requires operator approval/,
  );
});
