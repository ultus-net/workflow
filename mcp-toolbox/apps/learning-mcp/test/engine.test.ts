import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { evaluateLearningCheckpoint, DecisionLedger, PREREQUISITES } from "../src/engine.js";
import { createLearnerProfile, loadLearnerProfile, recordLearningEvidence, updateLearnerProfile } from "../src/learner-profile.js";

let dataDir: string;
let profilePath: string;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "learning-mcp-engine-"));
  profilePath = join(dataDir, "workflow", "learner-profile.json");
});

after(() => rmSync(dataDir, { recursive: true, force: true }));

const baseInput = {
  concept: "async:promises",
  category: "foundations" as const,
  relevance: 0.9,
  consequence: 0.8,
  teachableInsight: "Microtasks run before the next macrotask.",
  socraticQuestion: "What runs first after await?",
};

test("autonomous mode never interrupts", () => {
  const result = evaluateLearningCheckpoint(createLearnerProfile(), baseInput, {
    mode: "autonomous", sessionInterventions: 0,
  });
  assert.equal(result.interrupt, false);
  assert.match(result.reason, /autonomous/);
  assert.equal(result.checkpoint, undefined);
});

test("socratic-tutor interrupts within budget and returns checkpoint with stage", () => {
  const result = evaluateLearningCheckpoint(createLearnerProfile(), baseInput, {
    mode: "socratic-tutor", sessionInterventions: 0,
  });
  assert.equal(result.interrupt, true);
  assert.equal(result.stage, "exposed");
  assert.equal(result.checkpoint?.socraticQuestion, baseInput.socraticQuestion);
});

test("socratic-tutor enforces the intervention budget (default 3, configurable)", () => {
  const profile = createLearnerProfile();
  assert.equal(evaluateLearningCheckpoint(profile, baseInput, { mode: "socratic-tutor", sessionInterventions: 3 }).interrupt, false);
  assert.match(evaluateLearningCheckpoint(profile, baseInput, { mode: "socratic-tutor", sessionInterventions: 3 }).reason, /budget/);
  assert.equal(evaluateLearningCheckpoint(profile, baseInput, { mode: "socratic-tutor", sessionInterventions: 1, maxInterventions: 2 }).interrupt, true);
  assert.equal(evaluateLearningCheckpoint(profile, baseInput, { mode: "socratic-tutor", sessionInterventions: 2, maxInterventions: 2 }).interrupt, false);
});

test("mastered (independent) concepts are suppressed unless needs-reinforcement", () => {
  const profile = createLearnerProfile();
  recordLearningEvidence(profile, { concept: baseInput.concept, kind: "independent", summary: "built it alone", timestamp: 1 });
  const suppressed = evaluateLearningCheckpoint(profile, baseInput, { mode: "learn-to-code", sessionInterventions: 0 });
  assert.equal(suppressed.interrupt, false);
  assert.match(suppressed.reason, /mastered|independent/);

  recordLearningEvidence(profile, { concept: baseInput.concept, kind: "needs-reinforcement", summary: "struggled", timestamp: 2 });
  const refreshed = evaluateLearningCheckpoint(profile, baseInput, { mode: "learn-to-code", sessionInterventions: 0 });
  assert.equal(refreshed.interrupt, true);
  assert.equal(refreshed.stage, "independent");
});

test("stage updates are monotonic and needs-reinforcement never regresses stage", () => {
  const profile = createLearnerProfile();
  recordLearningEvidence(profile, { concept: "c", kind: "demonstrated", summary: "s", timestamp: 1 });
  recordLearningEvidence(profile, { concept: "c", kind: "exposed", summary: "s", timestamp: 2 });
  assert.equal(profile.concepts["c"]?.stage, "demonstrated");
  recordLearningEvidence(profile, { concept: "c", kind: "needs-reinforcement", summary: "s", timestamp: 3 });
  assert.equal(profile.concepts["c"]?.stage, "demonstrated");
  assert.equal(profile.concepts["c"]?.evidence.at(-1)?.kind, "needs-reinforcement");
  recordLearningEvidence(profile, { concept: "c", kind: "independent", summary: "s", timestamp: 4 });
  assert.equal(profile.concepts["c"]?.stage, "independent");
});

test("prerequisite concepts marked needs-reinforcement suppress advanced concepts", () => {
  const advanced = Object.keys(PREREQUISITES)[0];
  assert.ok(advanced, "graph must encode the spec section 4.1 tiers");
  const prereq = PREREQUISITES[advanced]![0]!;
  const profile = createLearnerProfile();
  recordLearningEvidence(profile, { concept: prereq, kind: "needs-reinforcement", summary: "struggled", timestamp: 1 });
  const result = evaluateLearningCheckpoint(profile, { ...baseInput, concept: advanced, category: "systems" }, {
    mode: "learn-to-code", sessionInterventions: 0,
  });
  assert.equal(result.interrupt, false);
  assert.match(result.reason, /prerequisite/);
});

test("interrupting records exposed evidence in the returned profile", () => {
  const fresh = createLearnerProfile();
  const result = evaluateLearningCheckpoint(fresh, { ...baseInput, concept: "errors:handling" }, {
    mode: "learn-to-code", sessionInterventions: 0,
  });
  assert.equal(result.interrupt, true);
  assert.equal(result.profile.concepts["errors:handling"]?.stage, "exposed");
  assert.equal(result.profile.concepts["errors:handling"]?.evidence.at(-1)?.kind, "exposed");
});

test("profile store round-trips through locked atomic updates", () => {
  const updated = updateLearnerProfile((profile) => {
    recordLearningEvidence(profile, { concept: "types:null-safety", kind: "developing", summary: "guided", timestamp: 10 });
  }, profilePath);
  assert.equal(updated.concepts["types:null-safety"]?.stage, "developing");
  const loaded = loadLearnerProfile(profilePath);
  assert.equal(loaded.concepts["types:null-safety"]?.stage, "developing");
});

test("decision ledger records briefs, resolves them, and rejects unknown ids", () => {
  const ledger = new DecisionLedger();
  const briefInput = {
    title: "Storage engine",
    context: "Need durable writes",
    proposedChoice: { name: "append-log", rationale: "simple", blastRadius: "low" as const },
    rejectedAlternatives: [{ name: "btree", drawback: "complex" }],
    tradeoffs: { benefits: ["fast"], liabilities: ["compaction"] },
  };
  const { briefId, brief } = ledger.record(briefInput);
  assert.ok(briefId);
  assert.equal(brief.status, "pending");
  assert.deepEqual(brief.input.proposedChoice, briefInput.proposedChoice);
  const resolved = ledger.resolve(briefId, true, "looks good");
  assert.equal(resolved.status, "approved");
  assert.equal(resolved.note, "looks good");
  const rejected = ledger.record(briefInput);
  assert.equal(ledger.resolve(rejected.briefId, false).status, "rejected");
  assert.throws(() => ledger.resolve("nope", true), /unknown/);
});
