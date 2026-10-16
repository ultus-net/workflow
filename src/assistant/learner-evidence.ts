/**
 * W206 (M6): the assistant-lane adapter for the plane's learner-evidence port.
 *
 * The plane's `LearnerEvidenceRecorder` port (`src/pedagogy/learner-profile.ts`)
 * is fulfilled HERE, under `src/assistant/`, because this adapter reaches the
 * assistant tool lane (`src/integrations/assistant-tool-loop.ts`). The plane
 * must never import the assistant subtree — the dependency arrow is one-way and
 * `test/assistant-isolation.test.ts` pins it — so the implementation lives on
 * the assistant side and the plane keeps only the interface.
 *
 * It persists by calling the `record_learning_evidence` MCP tool through the
 * injected `AssistantToolExecutor`. That executor runs the canonical authority
 * ordering (kernel gate, then guard) and dispatches to `learning-mcp` — the
 * SOLE writer of the learner-profile file (M6, integration-plan §F item 2,
 * option (a)). This adapter holds no file path and no lock.
 *
 * Honest status: the tutor pipeline has NO live evidence-emission call site
 * today, so nothing composes this adapter yet. It is wired by the follow-up
 * that emits evidence from the tutor loop; until then the plane's default is
 * `noopLearnerEvidenceRecorder`. This adapter is real and exercised by
 * `test/pedagogy-learner-profile.test.ts` against a fake executor.
 *
 * (Template literals are deliberately absent: `+` concatenation keeps sources
 * patchable under the guard shell classifier.)
 */

import type { LearnerEvidence } from "../pedagogy/contracts.js";
import type { LearnerEvidenceRecorder } from "../pedagogy/learner-profile.js";
import type {
  AssistantToolCall,
  AssistantToolContext,
  AssistantToolExecutor,
} from "../integrations/assistant-tool-loop.js";

/** The MCP tool `learning-mcp` exposes for the one evidence write. */
export const RECORD_LEARNING_EVIDENCE_TOOL = "record_learning_evidence";

export interface AssistantLearnerEvidenceRecorderOptions {
  /** The assistant tool executor (authorize + guard + dispatch). */
  readonly executor: AssistantToolExecutor;
  /**
   * The tool-call context for every recorded observation. The tool lane needs
   * an identity and a route; the tutor route is the natural seat for learning
   * evidence, but the caller owns that choice.
   */
  readonly context: AssistantToolContext;
}

/**
 * `record_learning_evidence` takes `concept`, `kind`, and `summary` only: the
 * tool stamps the observation time server-side, so the evidence's own
 * `timestamp` is not sent. Returns the tool's JSON argument string.
 */
function toolArguments(evidence: LearnerEvidence): string {
  return JSON.stringify({ concept: evidence.concept, kind: evidence.kind, summary: evidence.summary });
}

/**
 * Compose a `LearnerEvidenceRecorder` that routes each observation through the
 * assistant tool lane. A call id is derived from the evidence so a refusal is
 * traceable; the executor never throws, so this adapter inspects the result and
 * rejects on `isError` (the port's "the persistence lane refused it" case).
 */
export function createAssistantLearnerEvidenceRecorder(
  options: AssistantLearnerEvidenceRecorderOptions,
): LearnerEvidenceRecorder {
  let sequence = 0;
  return {
    async record(evidence: LearnerEvidence): Promise<void> {
      sequence += 1;
      const call: AssistantToolCall = {
        id: "learner-evidence-" + String(sequence) + "-" + evidence.concept,
        name: RECORD_LEARNING_EVIDENCE_TOOL,
        arguments: toolArguments(evidence),
      };
      const result = await options.executor.execute(call, options.context);
      if (result.isError === true) {
        throw new Error("record_learning_evidence refused the observation: " + result.content);
      }
    },
  };
}
