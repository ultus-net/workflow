import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkflowCodingSession, type CodingSessionDriver } from "../src/application/coding-session.js";

/**
 * Web-parity message queue (Tier 2): prompts submitted while a turn runs are
 * queued and submitted in order when the turn ends; cancellation clears the
 * queue and never auto-continues.
 */

/**
 * The first turn gates (so the test can queue against a "running" state);
 * every later turn completes immediately so the queue drains itself.
 */
function gatedFirstDriver(): {
  driver: CodingSessionDriver;
  release(): void;
  started: readonly string[];
} {
  const started: string[] = [];
  let releaseFirst: (() => void) | undefined = undefined;
  // A gated turn's pending promise keeps no handle alive, so node:test
  // considers the loop resolved; hold an interval until the gate opens.
  const keepAlive = setInterval(() => {}, 100);
  const driver: CodingSessionDriver = {
    async start(prompt, emit) {
      started.push(prompt);
      if (started.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      emit({ type: "completed", result: `done: ${prompt}` });
    },
    async cancel() {
      releaseFirst?.();
      releaseFirst = undefined;
    },
  };
  return {
    driver,
    release() {
      releaseFirst?.();
      releaseFirst = undefined;
      clearInterval(keepAlive);
    },
    started,
  };
}

test("prompts submitted while running queue and run in order", async () => {
  const { driver, release, started } = gatedFirstDriver();
  const session = new WorkflowCodingSession(driver);
  const first = session.submit("first");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(session.queuedPrompts(), [], "nothing is queued before the second submit");
  session.submit("second");
  session.submit("third");
  assert.deepEqual(session.queuedPrompts(), ["second", "third"]);

  release();
  await first;
  assert.deepEqual(started, ["first", "second", "third"], "the queue drains in submit order");
  assert.deepEqual(session.queuedPrompts(), []);
  assert.deepEqual(session.snapshot(), { state: "completed", result: "done: third" });
});

test("cancellation clears the queue — a cancelled turn never auto-continues", async () => {
  const { driver, started } = gatedFirstDriver();
  const session = new WorkflowCodingSession(driver);
  const first = session.submit("first");
  await new Promise((resolve) => setTimeout(resolve, 10));
  session.submit("queued-but-doomed");
  await session.cancel();
  await first;
  assert.deepEqual(started, ["first"], "queued prompts must not run after cancellation");
  assert.deepEqual(session.queuedPrompts(), []);
  assert.deepEqual(session.snapshot(), { state: "cancelled" });
});

test("a failed turn still drains the queue (the operator's queued prompts survive)", async () => {
  const started: string[] = [];
  const driver: CodingSessionDriver = {
    async start(prompt, emit) {
      started.push(prompt);
      if (prompt === "boom") {
        emit({ type: "failed", reason: "agent crashed" });
        return;
      }
      emit({ type: "completed", result: "ok" });
    },
    async cancel() {},
  };
  const session = new WorkflowCodingSession(driver);
  const first = session.submit("boom");
  session.submit("after-failure");
  await first;
  assert.deepEqual(started, ["boom", "after-failure"]);
  assert.deepEqual(session.snapshot(), { state: "completed", result: "ok" });
});