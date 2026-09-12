import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLearnerProfile,
  loadLearnerProfile,
  recordLearningEvidence,
  saveLearnerProfile,
  selectLearningOpportunity,
  updateLearnerProfile,
} from "../src/index.js";

test("creates an empty valid learner profile", () => {
  const profile = createLearnerProfile();
  assert.equal(profile.version, 1);
  assert.deepEqual(profile.concepts, {});
});

test("records learning evidence and advances concept stage monotonically", () => {
  const profile = createLearnerProfile();

  recordLearningEvidence(profile, {
    concept: "null-safety",
    kind: "exposed",
    summary: "Introduced null checking",
    timestamp: 1000,
  });
  assert.equal(profile.concepts["null-safety"]?.stage, "exposed");
  assert.equal(profile.concepts["null-safety"]?.evidence.length, 1);

  recordLearningEvidence(profile, {
    concept: "null-safety",
    kind: "demonstrated",
    summary: "Correctly resolved optional chaining question",
    timestamp: 2000,
  });
  assert.equal(profile.concepts["null-safety"]?.stage, "demonstrated");
  assert.equal(profile.concepts["null-safety"]?.evidence.length, 2);

  // Regressive stage reporting does not demote demonstrated stage
  recordLearningEvidence(profile, {
    concept: "null-safety",
    kind: "developing",
    summary: "Partial answer on edge case",
    timestamp: 3000,
  });
  assert.equal(profile.concepts["null-safety"]?.stage, "demonstrated");
  assert.equal(profile.concepts["null-safety"]?.evidence.length, 3);
});

test("needs-reinforcement evidence preserves stage and records gap", () => {
  const profile = createLearnerProfile();

  recordLearningEvidence(profile, {
    concept: "promises",
    kind: "demonstrated",
    summary: "Answered async question",
    timestamp: 1000,
  });

  recordLearningEvidence(profile, {
    concept: "promises",
    kind: "needs-reinforcement",
    summary: "Expressed confusion on microtasks",
    timestamp: 2000,
  });

  assert.equal(profile.concepts["promises"]?.stage, "demonstrated");
  assert.equal(profile.concepts["promises"]?.evidence.at(-1)?.kind, "needs-reinforcement");
});

test("saves and loads learner profile cleanly from disk", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-learner-test-"));
  const profilePath = join(tempDir, "profile.json");

  try {
    const profile = createLearnerProfile();
    recordLearningEvidence(profile, {
      concept: "variables",
      kind: "independent",
      summary: "Mastered const vs let",
      timestamp: 5000,
    });

    saveLearnerProfile(profile, profilePath);

    const reloaded = loadLearnerProfile(profilePath);
    assert.equal(reloaded.version, 1);
    assert.equal(reloaded.concepts["variables"]?.stage, "independent");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("atomic updateLearnerProfile locks and persists changes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-learner-lock-test-"));
  const profilePath = join(tempDir, "profile.json");

  try {
    const result = updateLearnerProfile((profile) => {
      recordLearningEvidence(profile, {
        concept: "closures",
        kind: "developing",
        summary: "Engaged in closure exercise",
        timestamp: 6000,
      });
    }, profilePath);

    assert.equal(result.concepts["closures"]?.stage, "developing");

    const onDisk = loadLearnerProfile(profilePath);
    assert.equal(onDisk.concepts["closures"]?.stage, "developing");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("selectLearningOpportunity respects budget, gap, and mastered concepts", () => {
  const profile = createLearnerProfile();

  recordLearningEvidence(profile, {
    concept: "mastered-topic",
    kind: "independent",
    summary: "Fully independent",
    timestamp: 1000,
  });

  const opportunities = [
    {
      concept: "mastered-topic",
      type: "foundations" as const,
      relevance: 1.0,
      consequence: 1.0,
      teachableInsight: "Already mastered",
      socraticQuestion: "What is this?",
    },
    {
      concept: "new-topic",
      type: "foundations" as const,
      relevance: 0.9,
      consequence: 0.8,
      teachableInsight: "New topic to learn",
      socraticQuestion: "How do you do this?",
    },
  ];

  // Mastered concept is skipped in favor of new topic
  const selected = selectLearningOpportunity(profile, opportunities, {
    interventionsThisSession: 0,
    maxInterventionsPerSession: 3,
  });

  if (!selected) assert.fail("expected opportunity to be selected");
  assert.equal(selected.concept, "new-topic");

  // Budget exceeded returns undefined
  const budgetedOut = selectLearningOpportunity(profile, opportunities, {
    interventionsThisSession: 3,
    maxInterventionsPerSession: 3,
  });
  assert.equal(budgetedOut, undefined);
});
