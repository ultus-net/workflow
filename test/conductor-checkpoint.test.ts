import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CheckpointConflictError,
  ConductorCheckpointStore,
  artifactDigest,
} from "../src/integrations/conductor-checkpoint.js";

/**
 * W199 / durability plan §4.3: the conductor checkpoint store's conflict and
 * resume rules, tested directly.
 */

test("checkpoint: a done dispatch is idempotent on replay and conflicts on a changed digest", () => {
  const store = new ConductorCheckpointStore({ runId: "r1", plan: [{ q: "a" }], dispatched: [], cursor: 0 });
  store.markDispatched({ stepId: "search.1", artifactRef: "f/1.md", status: "done", digest: artifactDigest("body-1") });
  // Same step, same digest: a replay, no-op.
  store.markDispatched({ stepId: "search.1", artifactRef: "f/1.md", status: "done", digest: artifactDigest("body-1") });
  assert.equal(store.checkpoint.dispatched.length, 1);
  // Same step, different digest, already done: fail closed.
  assert.throws(
    () => store.markDispatched({ stepId: "search.1", artifactRef: "f/1.md", status: "done", digest: artifactDigest("changed") }),
    (error: unknown) => error instanceof CheckpointConflictError,
  );
});

test("checkpoint: the cursor never moves backwards and a plan cannot change after dispatch", () => {
  const store = new ConductorCheckpointStore({ runId: "r1", plan: [{ q: "a" }, { q: "b" }, { q: "c" }], dispatched: [], cursor: 0 });
  store.advanceCursor(2);
  assert.throws(() => store.advanceCursor(1), CheckpointConflictError);
  store.markDispatched({ stepId: "search.1", artifactRef: "f/1.md", status: "done", digest: artifactDigest("x") });
  assert.throws(() => store.replacePlan([{ q: "different" }]), CheckpointConflictError);
});

test("checkpoint: round-trips through disk with the plan, dispatches, and cursor intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-checkpoint-"));
  const path = join(dir, "checkpoint.json");
  try {
    const store = new ConductorCheckpointStore({ runId: "r1", plan: [{ q: "a" }, { q: "b" }], dispatched: [], cursor: 0 }, { path });
    store.replacePlan([{ q: "a" }, { q: "b" }]);
    store.markDispatched({ stepId: "search.1", artifactRef: "f/1.md", status: "done", digest: artifactDigest("body") });
    store.advanceCursor(1);

    const reloaded = ConductorCheckpointStore.load(path);
    assert.deepEqual(reloaded.checkpoint.plan, [{ q: "a" }, { q: "b" }]);
    assert.equal(reloaded.checkpoint.cursor, 1);
    assert.equal(reloaded.checkpoint.dispatched[0]!.stepId, "search.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoint: a corrupt file is rejected, not silently emptied", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-checkpoint-bad-"));
  const path = join(dir, "checkpoint.json");
  try {
    writeFileSync(path, JSON.stringify({ version: 99 }), "utf8");
    assert.throws(() => ConductorCheckpointStore.load(path), /invalid conductor checkpoint/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
