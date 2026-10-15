import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DurableStepJournal, StepConflictError, type StepKey } from "../src/integrations/step-journal.js";

/**
 * W199 / durability plan acceptance check D1.
 *
 * Append a step twice with the same (runId, stepId, attempt) and digest; the
 * second call returns the recorded entry and the side-effect callback is
 * invoked ONCE. The same key with a different digest throws (fail closed).
 */

const key: StepKey = { runId: "run-1", stepId: "search.subquestion.3", attempt: 0 };

test("D1: a replay serves the recorded result and the effect runs once", async () => {
  const journal = new DurableStepJournal({ now: () => new Date("2026-10-15T00:00:00.000Z") });
  let calls = 0;
  const effect = async (input: unknown): Promise<{ hits: string[] }> => {
    calls += 1;
    return { hits: [`result-for-${JSON.stringify(input)}`] };
  };

  const first = await journal.step(key, { question: "who won the 2026 X" }, effect);
  assert.equal(first.replayed, false);
  assert.equal(calls, 1);

  const second = await journal.step(key, { question: "who won the 2026 X" }, effect);
  assert.equal(second.replayed, true, "the second call is a replay");
  assert.equal(calls, 1, "the side-effect callback was invoked exactly once");
  assert.deepEqual(second.output, first.output);
  assert.deepEqual(second.record, first.record);
});

test("D1: the same key with a different input digest throws (fail closed)", async () => {
  const journal = new DurableStepJournal();
  await journal.step(key, { question: "original" }, async () => "done");
  await assert.rejects(
    () => journal.step(key, { question: "something else entirely" }, async () => "done"),
    (error: unknown) => error instanceof StepConflictError && (error as StepConflictError).key.stepId === key.stepId,
  );
});

test("D1: a bumped attempt is a deliberate re-run, not a replay", async () => {
  const journal = new DurableStepJournal();
  let calls = 0;
  const effect = async (): Promise<string> => {
    calls += 1;
    return `call-${calls}`;
  };
  await journal.step(key, { q: "x" }, effect);
  const retry = await journal.step({ ...key, attempt: 1 }, { q: "x" }, effect);
  assert.equal(retry.replayed, false);
  assert.equal(calls, 2, "a new attempt runs the effect again");
});

test("D1: the journal round-trips through disk and still dedupes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-step-journal-"));
  const path = join(dir, "journal.json");
  try {
    let calls = 0;
    const effect = async (): Promise<{ value: number }> => {
      calls += 1;
      return { value: 42 };
    };
    const first = new DurableStepJournal();
    await first.step(key, { q: "persist me" }, effect);
    first.save(path);

    const reloaded = DurableStepJournal.load(path);
    const replay = await reloaded.step(key, { q: "persist me" }, effect);
    assert.equal(replay.replayed, true);
    assert.equal(calls, 1, "the effect did not run after a reload");
    assert.deepEqual(replay.output, { value: 42 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D1: an absent journal file loads as empty (ENOENT only)", () => {
  const journal = DurableStepJournal.load(join(tmpdir(), "wf-step-journal-does-not-exist.json"));
  assert.deepEqual(journal.entries(), []);
});

test("D1: a corrupt journal file is rejected, not silently emptied", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-step-journal-bad-"));
  const path = join(dir, "journal.json");
  try {
    writeFileSync(path, "{ not json", "utf8");
    assert.throws(() => DurableStepJournal.load(path), /invalid step journal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
