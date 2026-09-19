import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createSelfImprovementRegistry,
  type LoopRunControls,
  type SelfImprovementSpec,
} from "../src/integrations/self-improvement-registry.js";
import type { LoopIterationRecord, LoopOutcome } from "../src/integrations/self-improvement-loop.js";

/**
 * W073 trigger surface: the hub-owned loop registry. Start / status / cancel
 * lifecycle, duplicate refusal, cancellation semantics, and crash handling.
 */

function spec(overrides: Partial<SelfImprovementSpec> = {}): SelfImprovementSpec {
  return {
    workspace: "/tmp/wf-rsi-registry-ws",
    objective: "reduce flaky tests",
    maxIterations: 3,
    ...overrides,
  };
}

function iteration(iterationNumber: number): LoopIterationRecord {
  return {
    iteration: iterationNumber,
    proposalId: `p${iterationNumber}`,
    hypothesis: "hypothesis",
    changed: true,
    runId: `rsi:${iterationNumber}:x`,
    verdict: "accepted",
    reason: "candidate verified and committed",
    observedAt: "2026-09-19T00:00:00.000Z",
  };
}

function outcome(status: LoopOutcome["status"], reason: string, iterations: LoopIterationRecord[] = []): LoopOutcome {
  return { status, reason, iterations, accepted: iterations.length, rejected: 0, committed: [], best: undefined };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("start validates the spec before creating a record", () => {
  const registry = createSelfImprovementRegistry({ runLoop: async () => outcome("completed", "done") });
  assert.throws(() => registry.start(spec({ workspace: "relative" })), /must be absolute/);
  assert.throws(() => registry.start(spec({ objective: "  " })), /objective must be a non-empty string/);
  assert.throws(() => registry.start(spec({ maxIterations: 0 })), /maxIterations must be a positive integer/);
  assert.throws(() => registry.start(spec({ budgetUsd: -1 })), /budgetUsd must be a positive number/);
  assert.equal(registry.status().length, 0);
});

test("start refuses a second running loop for the same workspace, including path aliases", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "wf-rsi-reg-base-"));
  const aliasHolder = mkdtempSync(join(tmpdir(), "wf-rsi-reg-alias-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  t.after(() => rmSync(aliasHolder, { recursive: true, force: true }));
  const alias = join(aliasHolder, "alias");
  symlinkSync(base, alias, "dir");

  const gate = deferred<LoopOutcome>();
  const registry = createSelfImprovementRegistry({ runLoop: () => gate.promise });
  const first = registry.start(spec({ workspace: base }));
  assert.equal(first.state, "running");
  assert.throws(() => registry.start(spec({ workspace: alias })), /already running for workspace/);
  gate.resolve(outcome("completed", "done"));
  await Promise.resolve();
  await Promise.resolve();
});

test("start drives the runner, records iterations, and exposes the completed outcome", async () => {
  const registry = createSelfImprovementRegistry({
    runLoop: async (_spec: SelfImprovementSpec, controls: LoopRunControls) => {
      controls.onIteration(iteration(1));
      return outcome("completed", "first verified candidate accepted", [iteration(1)]);
    },
  });
  const started = registry.start(spec());
  assert.equal(started.state, "running");
  assert.equal(started.cancelRequested, false);
  // Let the async runner settle.
  await new Promise((resolve) => setImmediate(resolve));
  const record = registry.get(started.id);
  assert.equal(record?.state, "completed");
  assert.equal(record?.iterations.length, 1);
  assert.equal(record?.outcome?.reason, "first verified candidate accepted");
  assert.ok(record?.finishedAt !== undefined);
});

test("cancel marks a running loop cancelled, and the runner sees the flag", async () => {
  const gate = deferred<void>();
  let sawCancel = false;
  const registry = createSelfImprovementRegistry({
    runLoop: async (_spec: SelfImprovementSpec, controls: LoopRunControls) => {
      controls.onIteration(iteration(1));
      await gate.promise;
      sawCancel = controls.isCancelled();
      return outcome("stopped", sawCancel ? "cancelled by operator" : "some other stop", [iteration(1)]);
    },
  });
  const started = registry.start(spec());
  assert.equal(registry.cancel({ id: started.id }), true);
  assert.equal(registry.get(started.id)?.cancelRequested, true);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sawCancel, true, "the runner observed the cancel request");
  assert.equal(registry.get(started.id)?.state, "cancelled", "a cancelled stop is surfaced as cancelled");
});

test("cancel by workspace targets the active loop; cancel on a finished or unknown loop returns false", async () => {
  const gate = deferred<void>();
  const registry = createSelfImprovementRegistry({
    runLoop: async (_spec: SelfImprovementSpec, controls: LoopRunControls) => {
      await gate.promise;
      return controls.isCancelled()
        ? outcome("stopped", "cancelled by operator")
        : outcome("completed", "released");
    },
  });
  const workspace = mkdtempSync(join(tmpdir(), "wf-rsi-reg-cancel-"));
  const started = registry.start(spec({ workspace }));
  assert.equal(registry.cancel({ workspace }), true, "cancel resolves the active loop by workspace");
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.get(started.id)?.state, "cancelled");
  assert.equal(registry.cancel({ workspace }), false, "a finished loop cannot be cancelled");
  assert.equal(registry.cancel({ id: "rsi-loop:missing" }), false);
  assert.equal(registry.cancel({}), false);
  rmSync(workspace, { recursive: true, force: true });
});

test("a stop with an unrelated reason stays stopped even when a cancel was requested", async () => {
  const gate = deferred<void>();
  const registry = createSelfImprovementRegistry({
    runLoop: async (_spec: SelfImprovementSpec, controls: LoopRunControls) => {
      await gate.promise;
      void controls.isCancelled();
      return outcome("stopped", "budget cap reached");
    },
  });
  const started = registry.start(spec());
  registry.cancel({ id: started.id });
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.get(started.id)?.state, "stopped", "the record never claims a cancellation that did not happen");
});

test("a stop whose reason merely mentions cancel (failed cancel check) stays stopped", async () => {
  const gate = deferred<void>();
  const registry = createSelfImprovementRegistry({
    runLoop: async (_spec: SelfImprovementSpec, controls: LoopRunControls) => {
      await gate.promise;
      void controls.isCancelled();
      // A substring match would mislabel this as an operator cancel; only the
      // loop's exact cancel outcome ("cancelled by operator") counts.
      return outcome("stopped", "cancellation check failed (fail closed): probe exploded");
    },
  });
  const started = registry.start(spec());
  registry.cancel({ id: started.id });
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.get(started.id)?.state, "stopped");
});

test("a crashed runner is recorded as stopped with the error surfaced", async () => {
  const registry = createSelfImprovementRegistry({
    runLoop: async () => {
      throw new Error("runner crashed");
    },
  });
  const started = registry.start(spec());
  await new Promise((resolve) => setImmediate(resolve));
  const record = registry.get(started.id);
  assert.equal(record?.state, "stopped");
  assert.match(record?.lastError ?? "", /runner crashed/);
});

test("the record history is bounded, evicting the oldest finished loops", async () => {
  const registry = createSelfImprovementRegistry({ runLoop: async () => outcome("completed", "done"), maxRecords: 2 });
  for (let index = 0; index < 4; index += 1) {
    registry.start(spec({ objective: `objective ${index}`, workspace: `/tmp/wf-rsi-reg-${index}` }));
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(registry.status().length, 2, "finished records are evicted oldest-first");
});