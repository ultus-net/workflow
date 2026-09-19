import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkflowCodingSession, type CodingSessionDriver, type CodingSessionEvent } from "../src/application/coding-session.js";

class ScriptedDriver implements CodingSessionDriver {
  readonly prompts: string[] = [];
  constructor(private readonly emitsToolCall: boolean) {}
  async start(prompt: string, emit: (event: CodingSessionEvent) => void): Promise<void> {
    this.prompts.push(prompt);
    if (this.emitsToolCall) emit({ type: "tool", callId: "c1", title: "edit", toolKind: "edit", status: "completed", subjects: [] });
    emit({ type: "completed", result: "ok" });
  }
  async cancel(): Promise<void> {}
}

test("coding session re-prompts a stalled mutation-scoped turn at most twice then escalates", async () => {
  const driver = new ScriptedDriver(false);
  const escalations: string[] = [];
  const session = new WorkflowCodingSession(driver, {
    toolExpectedTurn: {
      scope: () => ({ mutationScoped: true, taskInProgress: true }),
      maxRetries: 2,
      onEscalate: ({ message }) => escalations.push(message),
    },
  });
  await session.submit("do the work");

  // Original turn + exactly two bounded corrective re-prompts.
  assert.equal(driver.prompts.length, 3);
  assert.deepEqual(session.toolExpectedTurnStats(), { toolTurns: 0, noToolTurns: 3, reprompts: 2, escalations: 1 });
  assert.equal(escalations.length, 1);
  assert.match(escalations[0] ?? "", /surfacing to the operator/);
});

test("coding session does not re-prompt a turn that made a tool call", async () => {
  const driver = new ScriptedDriver(true);
  const session = new WorkflowCodingSession(driver, {
    toolExpectedTurn: { scope: () => ({ mutationScoped: true, taskInProgress: true }) },
  });
  await session.submit("do the work");
  assert.equal(driver.prompts.length, 1);
  assert.deepEqual(session.toolExpectedTurnStats(), { toolTurns: 1, noToolTurns: 0, reprompts: 0, escalations: 0 });
});

test("coding session leaves steering off when no policy is supplied", async () => {
  const driver = new ScriptedDriver(false);
  const session = new WorkflowCodingSession(driver);
  await session.submit("do the work");
  assert.equal(driver.prompts.length, 1);
  assert.equal(session.toolExpectedTurnStats(), undefined);
});
