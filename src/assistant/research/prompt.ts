import { researchEffort, type ResearchComplexity, type ResearchTask } from "./types.js";

/**
 * The conductor's planning prompt (deep-research step 0). Provider-agnostic:
 * it is plain text handed to whichever frontier model is configured as the
 * conductor, so it survives the OpenRouter -> Foundry move.
 *
 * The effort rules are embedded verbatim in the prompt because that is the
 * documented mechanism that keeps a lead from over-investing (Anthropic's
 * multi-agent research guidance, quoted in `planning-questions.md`).
 */

export function conductorPlanPrompt(input: {
  readonly question: string;
  readonly complexity: ResearchComplexity;
  readonly maxSubagents: number;
}): string {
  const effort = researchEffort(input.complexity);
  return [
    "You are a research conductor. Decompose the question below into a small set of INDEPENDENT sub-questions, each answerable by one cheaper worker with its own web-search loop.",
    "",
    "Rules:",
    `- This is a '${input.complexity}' research task. Emit at most ${input.maxSubagents} sub-questions.`,
    `- Each sub-question should need no more than ${effort.maxToolCallsPerSubagent} tool calls to answer.`,
    "- Sub-questions must be answerable independently: no sub-question may depend on another's answer.",
    "- Prefer breadth of primary sources over depth on one source.",
    "- Do NOT answer the question yourself. Only decompose it.",
    "",
    "Question:",
    input.question,
  ].join("\n");
}

const PLAN_SCHEMA = {
  name: "research_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["subQuestions"],
    properties: {
      subQuestions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["subQuestion"],
          properties: { subQuestion: { type: "string" } },
        },
      },
    },
  },
} as const;

export const CONDUCTOR_PLAN_SCHEMA = PLAN_SCHEMA;

/** Parse a conductor plan response into tasks; a malformed entry is dropped. */
export function parsePlan(text: string, role: ResearchTask["role"] = "search"): ResearchTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (parsed as { subQuestions?: unknown }).subQuestions;
  if (!Array.isArray(list)) return [];
  const tasks: ResearchTask[] = [];
  for (const entry of list) {
    const sub = (entry as { subQuestion?: unknown }).subQuestion;
    if (typeof sub !== "string" || sub.trim().length === 0) continue;
    const stepId = `search.subquestion.${tasks.length + 1}`;
    tasks.push({ stepId, subQuestion: sub.trim(), role });
  }
  return tasks;
}

/**
 * The synthesis prompt: the conductor sees artifact REFERENCES and one-line
 * summaries, never the worker bodies (the "no game of telephone" rule). It may
 * read an artifact only when a summary is insufficient.
 */
export function conductorSynthesizePrompt(input: {
  readonly question: string;
  readonly findings: readonly { readonly stepId: string; readonly artifactRef: string; readonly summary?: string }[];
}): string {
  const lines = input.findings.map(
    (f) => `- ${f.stepId} -> ${f.artifactRef}${f.summary === undefined ? "" : `: ${f.summary}`}`,
  );
  return [
    "You are a research conductor writing the final answer from completed worker findings.",
    "Each finding below is an artifact reference plus a one-line summary. Read an artifact only when its summary is not enough to write a grounded sentence.",
    "Cite only sources the workers actually retrieved. If a claim is not supported by a finding, omit it rather than guessing.",
    "",
    "Findings:",
    ...lines,
    "",
    "Question:",
    input.question,
  ].join("\n");
}
