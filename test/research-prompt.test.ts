import assert from "node:assert/strict";
import test from "node:test";

import { conductorPlanPrompt, conductorSynthesizePrompt, parsePlan } from "../src/assistant/research/prompt.js";
import { researchEffort } from "../src/assistant/research/types.js";

/**
 * The conductor prompts are provider-agnostic text; these pin the effort rules
 * and the artifact-not-transcript handoff so a future edit cannot silently drop
 * the cost controls described in `planning-questions.md`.
 */

test("plan prompt embeds the complexity's effort bound verbatim", () => {
  const prompt = conductorPlanPrompt({ question: "Q", complexity: "comparison", maxSubagents: 4 });
  assert.match(prompt, /at most 4 sub-questions/);
  assert.match(prompt, new RegExp(`no more than ${researchEffort("comparison").maxToolCallsPerSubagent} tool calls`));
  assert.match(prompt, /Do NOT answer the question yourself/);
});

test("parsePlan maps a structured response to stable step ids and drops empties", () => {
  const tasks = parsePlan(JSON.stringify({ subQuestions: [{ subQuestion: "a?" }, { subQuestion: "  " }, { subQuestion: "b?" }] }));
  assert.deepEqual(tasks.map((t) => t.stepId), ["search.subquestion.1", "search.subquestion.2"]);
  assert.deepEqual(tasks.map((t) => t.subQuestion), ["a?", "b?"]);
});

test("parsePlan is defensive on malformed output", () => {
  assert.deepEqual(parsePlan("not json"), []);
  assert.deepEqual(parsePlan(JSON.stringify({ subQuestions: "nope" })), []);
});

test("synthesis prompt hands over artifact references, not bodies", () => {
  const prompt = conductorSynthesizePrompt({
    question: "Q",
    findings: [{ stepId: "search.subquestion.1", artifactRef: "findings/1.md", summary: "one line" }],
  });
  assert.match(prompt, /findings\/1\.md/);
  assert.match(prompt, /one line/);
  assert.match(prompt, /Read an artifact only when its summary is not enough/);
});
