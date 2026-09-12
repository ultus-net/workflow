import assert from "node:assert/strict";
import test from "node:test";

import {
  approveCheckpoint,
  createCheckpointLedger,
  mutationGate,
  openCheckpoint,
  requireCheckpoint,
  verifyingGate,
} from "../src/pedagogy/checkpoints.js";

test("requireCheckpoint encodes the mode gating rules from spec section 2", () => {
  assert.equal(requireCheckpoint("learn-to-code", "learning"), true);
  assert.equal(requireCheckpoint("learn-to-code", "decision"), false);
  assert.equal(requireCheckpoint("socratic-tutor", "learning"), true);
  assert.equal(requireCheckpoint("co-architect", "decision"), true);
  assert.equal(requireCheckpoint("co-architect", "learning"), false);
  assert.equal(requireCheckpoint("walkthrough", "inspection"), true);
  assert.equal(requireCheckpoint("walkthrough", "learning"), false);
  assert.equal(requireCheckpoint("autonomous", "learning"), false);
  assert.equal(requireCheckpoint("autonomous", "decision"), false);
  assert.equal(requireCheckpoint("autonomous", "inspection"), false);
});

test("learn-to-code gates mutation on a pending learning checkpoint and clears on approval", () => {
  const ledger = createCheckpointLedger("learn-to-code");
  assert.equal(mutationGate(ledger, "task-a"), undefined);

  openCheckpoint(ledger, { id: "cp-1", taskId: "task-a", kind: "learning", summary: "explain the loop" });
  const gate = mutationGate(ledger, "task-a");
  assert.equal(gate?.id, "cp-1");
  assert.equal(gate?.kind, "learning");

  approveCheckpoint(ledger, "cp-1");
  assert.equal(mutationGate(ledger, "task-a"), undefined);
});

test("learn-to-code keeps gating during edits: a second checkpoint re-gates the same task", () => {
  const ledger = createCheckpointLedger("learn-to-code");
  openCheckpoint(ledger, { id: "cp-1", taskId: "task-a", kind: "learning", summary: "first" });
  approveCheckpoint(ledger, "cp-1");
  openCheckpoint(ledger, { id: "cp-2", taskId: "task-a", kind: "learning", summary: "second" });
  assert.equal(mutationGate(ledger, "task-a")?.id, "cp-2");
});

test("checkpoints are tracked per task and do not leak across tasks", () => {
  const ledger = createCheckpointLedger("learn-to-code");
  openCheckpoint(ledger, { id: "cp-1", taskId: "task-a", kind: "learning", summary: "for a" });
  assert.equal(mutationGate(ledger, "task-a")?.id, "cp-1");
  assert.equal(mutationGate(ledger, "task-b"), undefined);
});

test("co-architect gates consequential mutation on an approved decision checkpoint", () => {
  const ledger = createCheckpointLedger("co-architect");
  openCheckpoint(ledger, { id: "cp-1", taskId: "task-a", kind: "decision", summary: "ADR: ports vs inheritance" });
  assert.equal(mutationGate(ledger, "task-a")?.kind, "decision");

  approveCheckpoint(ledger, "cp-1");
  assert.equal(mutationGate(ledger, "task-a"), undefined);
});

test("socratic-tutor gates on pending learning checkpoints within the intervention budget", () => {
  const ledger = createCheckpointLedger("socratic-tutor");
  openCheckpoint(ledger, { id: "cp-1", taskId: "task-a", kind: "learning", summary: "why DI here?" });
  assert.equal(mutationGate(ledger, "task-a")?.id, "cp-1");
});

test("socratic-tutor suppresses gating once the per-task intervention budget is exhausted", () => {
  const ledger = createCheckpointLedger("socratic-tutor"); // default budget 3
  for (let index = 0; index < 3; index += 1) {
    openCheckpoint(ledger, { id: `cp-${index}`, taskId: "task-a", kind: "learning", summary: `q${index}` });
    assert.ok(mutationGate(ledger, "task-a") !== undefined, `checkpoint ${index} should gate`);
    approveCheckpoint(ledger, `cp-${index}`);
  }
  // Budget exhausted: further learning checkpoints are recorded but do not gate.
  openCheckpoint(ledger, { id: "cp-3", taskId: "task-a", kind: "learning", summary: "q3" });
  assert.equal(mutationGate(ledger, "task-a"), undefined);

  // A different task has its own budget.
  openCheckpoint(ledger, { id: "cp-4", taskId: "task-b", kind: "learning", summary: "q4" });
  assert.equal(mutationGate(ledger, "task-b")?.id, "cp-4");
});

test("socratic-tutor budget is configurable", () => {
  const ledger = createCheckpointLedger("socratic-tutor", { maxSocraticInterventionsPerTask: 2 });
  for (let index = 0; index < 2; index += 1) {
    openCheckpoint(ledger, { id: `cp-${index}`, taskId: "task-a", kind: "learning", summary: `q${index}` });
    approveCheckpoint(ledger, `cp-${index}`);
  }
  openCheckpoint(ledger, { id: "cp-2", taskId: "task-a", kind: "learning", summary: "q2" });
  assert.equal(mutationGate(ledger, "task-a"), undefined);
});

test("walkthrough does not gate mutation but gates VERIFYING on human inspection", () => {
  const ledger = createCheckpointLedger("walkthrough");
  openCheckpoint(ledger, { id: "cp-1", taskId: "task-a", kind: "inspection", summary: "review the diff invariants" });

  assert.equal(mutationGate(ledger, "task-a"), undefined);
  assert.equal(verifyingGate(ledger, "task-a")?.id, "cp-1");

  approveCheckpoint(ledger, "cp-1");
  assert.equal(verifyingGate(ledger, "task-a"), undefined);
});

test("autonomous gates nothing even when checkpoints exist", () => {
  const ledger = createCheckpointLedger("autonomous");
  openCheckpoint(ledger, { id: "cp-1", taskId: "task-a", kind: "learning", summary: "ignored" });
  openCheckpoint(ledger, { id: "cp-2", taskId: "task-a", kind: "decision", summary: "ignored" });
  openCheckpoint(ledger, { id: "cp-3", taskId: "task-a", kind: "inspection", summary: "ignored" });
  assert.equal(mutationGate(ledger, "task-a"), undefined);
  assert.equal(verifyingGate(ledger, "task-a"), undefined);
});

test("approveCheckpoint rejects unknown checkpoints and double approval", () => {
  const ledger = createCheckpointLedger("learn-to-code");
  openCheckpoint(ledger, { id: "cp-1", taskId: "task-a", kind: "learning", summary: "x" });
  assert.throws(() => approveCheckpoint(ledger, "cp-missing"), /unknown checkpoint/);
  approveCheckpoint(ledger, "cp-1");
  assert.throws(() => approveCheckpoint(ledger, "cp-1"), /not pending/);
});

test("openCheckpoint rejects duplicate ids", () => {
  const ledger = createCheckpointLedger("co-architect");
  openCheckpoint(ledger, { id: "cp-1", taskId: "task-a", kind: "decision", summary: "x" });
  assert.throws(
    () => openCheckpoint(ledger, { id: "cp-1", taskId: "task-a", kind: "decision", summary: "y" }),
    /duplicate/,
  );
});

