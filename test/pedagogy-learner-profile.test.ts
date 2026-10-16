import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLearnerProfile,
  loadLearnerProfile,
  noopLearnerEvidenceRecorder,
  parseLearnerProfile,
  recordLearningEvidence,
  selectLearningOpportunity,
} from "../src/index.js";
import {
  createAssistantLearnerEvidenceRecorder,
  RECORD_LEARNING_EVIDENCE_TOOL,
} from "../src/assistant/learner-evidence.js";
import type {
  AssistantToolCall,
  AssistantToolContext,
  AssistantToolResult,
} from "../src/integrations/assistant-tool-loop.js";

/**
 * W206 (M6): the plane's learner-profile module is pure with respect to the
 * file. `learning-mcp` is the sole writer. These cover the in-memory evidence
 * merge (unchanged, monotonic), the pure parse, the read-only load, and the
 * assistant-lane recorder that fulfills the injected persistence port. The
 * write/lock assertions that lived here moved out with the write path; the
 * lock's own coverage stays at
 * `mcp-toolbox/apps/learning-mcp/test/learner-profile-lock.test.ts`.
 */

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

test("parseLearnerProfile is pure: a valid document round-trips, a corrupt one is fresh", () => {
  const profile = createLearnerProfile();
  recordLearningEvidence(profile, {
    concept: "variables",
    kind: "independent",
    summary: "Mastered const vs let",
    timestamp: 5000,
  });

  const parsed = parseLearnerProfile(JSON.stringify(profile));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.concepts["variables"]?.stage, "independent");

  // Malformed JSON, wrong version, and an unknown stage all yield a fresh profile.
  assert.deepEqual(parseLearnerProfile("{ not json"), createLearnerProfile());
  assert.deepEqual(parseLearnerProfile(JSON.stringify({ version: 2, concepts: {} })), createLearnerProfile());
  assert.deepEqual(
    parseLearnerProfile(JSON.stringify({ version: 1, concepts: { x: { stage: "nope", lastObservedAt: 1, evidence: [] } } })),
    createLearnerProfile(),
  );
});

test("loadLearnerProfile only reads: it reflects a file it did not write, and a missing file is fresh", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-learner-test-"));
  const profilePath = join(tempDir, "profile.json");

  try {
    // The TEST writes the file (the module no longer can); the module only reads.
    const profile = createLearnerProfile();
    recordLearningEvidence(profile, {
      concept: "variables",
      kind: "independent",
      summary: "Mastered const vs let",
      timestamp: 5000,
    });
    writeFileSync(profilePath, JSON.stringify(profile), "utf8");

    const reloaded = loadLearnerProfile(profilePath);
    assert.equal(reloaded.version, 1);
    assert.equal(reloaded.concepts["variables"]?.stage, "independent");

    const missing = loadLearnerProfile(join(tempDir, "absent.json"));
    assert.deepEqual(missing, createLearnerProfile());
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the no-op recorder resolves without touching disk", async () => {
  await noopLearnerEvidenceRecorder.record({
    concept: "x",
    kind: "exposed",
    summary: "dropped",
    timestamp: 1,
  });
});

test("the assistant-lane recorder routes evidence through the record_learning_evidence tool", async () => {
  const calls: AssistantToolCall[] = [];
  const executor = {
    async execute(call: AssistantToolCall): Promise<AssistantToolResult> {
      calls.push(call);
      return { callId: call.id, content: JSON.stringify({ concept: "closures", stage: "developing" }) };
    },
  };
  const context: AssistantToolContext = { identity: "tutor-user", route: "tutor", iteration: 0 };
  const recorder = createAssistantLearnerEvidenceRecorder({ executor, context });

  await recorder.record({
    concept: "closures",
    kind: "developing",
    summary: "Engaged in closure exercise",
    timestamp: 6000,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, RECORD_LEARNING_EVIDENCE_TOOL);
  // The tool stamps the time; the evidence timestamp is NOT sent.
  assert.deepEqual(JSON.parse(calls[0]!.arguments), {
    concept: "closures",
    kind: "developing",
    summary: "Engaged in closure exercise",
  });
});

test("the assistant-lane recorder rejects (never silently drops) when the tool lane refuses", async () => {
  const executor = {
    async execute(call: AssistantToolCall): Promise<AssistantToolResult> {
      return { callId: call.id, content: "capability or policy denied", isError: true };
    },
  };
  const context: AssistantToolContext = { identity: "tutor-user", route: "tutor", iteration: 0 };
  const recorder = createAssistantLearnerEvidenceRecorder({ executor, context });

  await assert.rejects(
    recorder.record({ concept: "x", kind: "exposed", summary: "nope", timestamp: 1 }),
    /record_learning_evidence refused/,
  );
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
