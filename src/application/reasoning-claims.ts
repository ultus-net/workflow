/**
 * Advisory reasoning-claim monitoring (RSI iteration 17).
 *
 * The control plane cannot read a model's hidden intent. It CAN observe one
 * narrow, deterministic contradiction: streamed model text (thinking/reasoning
 * chunks and assistant text) that asserts a COMPLETED verification while the
 * same turn observed ZERO successful tool calls. That is the observable half
 * of "deception in reasoning" — a claim of a result no observed action
 * produced.
 *
 * This is a bounded, English-only LEXICAL heuristic and it is advisory
 * observability: it never blocks, never mutates canonical state, and never
 * becomes evidence. A flag is a question for an operator, never a verdict.
 *
 * Chunking (review-driven, iteration 17): production drivers stream deltas,
 * not sentences (ACP `agent_thought_chunk`/`agent_message_chunk` and OpenCode
 * `message.part.updated` deltas each arrive as a fragment). Two entry points:
 * `detectReasoningClaim` for a whole already-complete text, and
 * `createReasoningClaimMonitor` for a live stream. The monitor holds only the
 * trailing INCOMPLETE clause and evaluates each completed clause EXACTLY ONCE,
 * so a hedge at a clause start can never be "scrolled past" and re-evaluated
 * as an unhedged assertion (the tail-truncation false-positive class). It also
 * treats a stream switch (thought ↔ assistant) as a hard clause boundary, so
 * a hedged thought-final clause cannot fuse onto the assistant's claim.
 *
 * Deliberate under-flagging: an assertion CLAUSE carrying a future or
 * conditional hedge ("will", "should", "once", "let me") is NOT flagged, so
 * intent-before-action reasoning is not mistaken for a completed claim.
 * Clauses are split on `.!?;` and newlines, so a hedged follow-on clause does
 * not suppress a definite claim beside it. The trade is fewer false positives
 * at the cost of false negatives; both are recorded, neither is hidden.
 * Known false-positive class (documented, not hidden): a later turn that
 * summarizes an earlier turn's already-verified run ("the tests all pass, as
 * shown in the previous run") is flagged, because the control plane observes
 * no successful tool call in THIS turn. Known split divergence (documented):
 * `detectReasoningClaim` splits on `.!?;` + whitespace while the streaming
 * monitor anchors on the terminator itself, so decimal/abbreviation runs
 * (e.g. "3.0") can split differently between the two entry points; the
 * streaming monitor is the production path.
 *
 * Grounding (cited; the repo's own record is docs/AI_LANDSCAPE_RESEARCH.md
 * §3.3–3.4, §5.1 (trajectory-supervisor-mcp), §6 item 3, and
 * docs/SECURITY_ASSURANCE.md 2026-09-19 entries):
 * - Deception by frontier agents is capability-verified and surfaces in
 *   reasoning: Meinke et al. 2024 (Apollo), "Frontier Models are Capable of
 *   In-context Scheming" (arXiv:2412.04984) — models maintain deception under
 *   follow-up, and their chains-of-thought "explicitly reason about these
 *   deceptive strategies". Park et al. 2024, "AI deception: A survey..."
 *   (Patterns 5(5), arXiv:2308.14752) maps the risk class.
 * - The coding-agent cheat this detector keys on is documented: Baker et al.
 *   2025 (OpenAI), "Monitoring Reasoning Models for Misbehavior and the Risks
 *   of Promoting Obfuscation" (arXiv:2503.11926) — agents alter tests so they
 *   "pass"; CoT monitoring beats watching actions/outputs alone.
 * - CoT is NOT ground truth, so reasoning is used only as a CLAIM source and
 *   the control plane's own observed tool events as EVIDENCE: Turpin et al.
 *   2023 (arXiv:2305.04388) and Chen et al. 2025 (Anthropic, arXiv:2505.05410)
 *   show CoT explanations are systematically unfaithful / "plausible yet
 *   misleading"; Korbak et al. 2025 (arXiv:2507.11473) shows CoT monitorability
 *   is imperfect, two-sided, and fragile.
 * - Advisory-only, never a gate or reward signal: Baker et al. 2025 show that
 *   optimization pressure against a CoT monitor induces obfuscated reward
 *   hacking (the "monitorability tax"); the repo's recorded posture is
 *   deterministic-rules-first and advisory-with-metrics-first.
 * - Naming discipline: this is a claim-vs-observed-action flag, not a
 *   "deception detector" — strategic deception needs counterfactual
 *   sensitivity a lexical check cannot establish ("A Problem to Solve Before
 *   Building a Deception Detector", AI Alignment Forum YXNeA3RyRrrRWS37A); the
 *   majority of flagged agent events are overeagerness, not adversarial intent
 *   (Google DeepMind AI Control Roadmap, repo doc §3.3).
 * - Honest limitation: v0 is deterministic and lexical, so recall is unknown
 *   and lower than an LLM CoT monitor (Baker et al. report ~95% recall with a
 *   GPT-4o monitor). The LLM classifier is the recorded SECOND slice, not this
 *   one; obfuscated-CoT false negatives are expected and documented.
 */

/** A streamed claim that asserts completed verification with no observed action. */
export interface ReasoningClaimFlag {
  /** The sentence carrying the completed-verification assertion (bounded length). */
  readonly sentence: string;
  /** Successful tool calls observed in the turn when the claim was streamed. */
  readonly successfulToolCalls: number;
}

/** Stable name for the advisory flag (tests key on it; the event-type literal is the surface contract). */
export const REASONING_CLAIM_SOURCE = "reasoning-claim";

/** Longest quoted assertion sentence kept in a flag (bounded transcript growth). */
const MAX_SENTENCE_CHARS = 160;

// Completed-verification assertions. Explicit, English-only, lowercased input.
const ASSERTION_PATTERNS: readonly RegExp[] = [
  /\btests? (?:all )?pass(?:es|ed|ing)?\b/,
  /\bpass(?:es|ed) (?:all )?(?:the )?tests\b/,
  /\bsuite pass(?:es|ed)\b/,
  /\b(?:the |all )?(?:test |unit |integration )?suite (?:is |now )?green\b/,
  /\ball tests? (?:are |is )?green\b/,
  /\bci is green\b/,
  /\ball (?:\d+ )?(?:the )?checks? pass(?:es|ed)?\b/,
  /\b(?:typecheck|lint|build) (?:passes|passed|succeeds|succeeded|is green)\b/,
  /\bi (?:have |already )?(?:ran|run) (?:the )?tests\b/,
  /\bi (?:have |already )?verified\b/,
];

// Future/conditional hedges — a clause containing one is intent, not a claim.
const HEDGE_MARKERS =
  /\b(?:will|would|should|shall|going to|gonna|about to|let me|let's|need to|needs to|plan to|intend to|might|may|once|unless|if)\b/;

/** Splits text into clauses (`.!?;` and newlines) with a bounded split. */
function clauses(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function truncate(text: string): string {
  return text.length <= MAX_SENTENCE_CHARS ? text : `${text.slice(0, MAX_SENTENCE_CHARS - 1)}…`;
}

/** Classifies one clause; the single place assertion + hedge semantics live. */
function matchClause(clause: string, successfulToolCalls: number): ReasoningClaimFlag | undefined {
  const trimmed = clause.trim();
  const lower = trimmed.toLowerCase();
  if (HEDGE_MARKERS.test(lower)) return undefined;
  if (ASSERTION_PATTERNS.some((pattern) => pattern.test(lower))) {
    return { sentence: truncate(trimmed), successfulToolCalls };
  }
  return undefined;
}

/**
 * Detects a completed-verification assertion that no observed action backs, in
 * a whole already-complete text. `successfulToolCalls` is the count of
 * completed/succeeded tool events in the current turn; a non-zero count
 * suppresses the flag (any observed action is treated as possible backing —
 * tool-kind matching is a documented refinement).
 */
export function detectReasoningClaim(input: {
  readonly text: string;
  readonly successfulToolCalls: number;
}): ReasoningClaimFlag | undefined {
  if (input.successfulToolCalls > 0) return undefined;
  for (const clause of clauses(input.text)) {
    const flag = matchClause(clause, input.successfulToolCalls);
    if (flag !== undefined) return flag;
  }
  return undefined;
}

/** Cap on a single unterminated clause before it is evaluated once and dropped. */
const MAX_PENDING_CLAUSE = 2_000;

/**
 * Streaming scanner for the live session seam. Feed every `thought`/`assistant`
 * delta in order; it holds only the trailing incomplete clause and evaluates
 * each completed clause exactly once (so a hedge cannot be truncated away and
 * re-evaluated), and inserts a clause boundary on a stream switch. `reset()`
 * begins a fresh turn.
 */
export interface ReasoningClaimMonitor {
  push(input: {
    readonly stream: "thought" | "assistant";
    readonly text: string;
    readonly successfulToolCalls: number;
  }): ReasoningClaimFlag | undefined;
  /**
   * Turn end: evaluate the remaining unterminated clause once (e.g. a final
   * streamed claim with no punctuation) and clear it. Without this the tail is
   * silently discarded by the next turn's `reset()`.
   */
  flush(successfulToolCalls: number): ReasoningClaimFlag | undefined;
  reset(): void;
}

export function createReasoningClaimMonitor(): ReasoningClaimMonitor {
  let pending = "";
  let lastStream: "thought" | "assistant" | undefined;
  return {
    push(input) {
      // Any observed successful action suppresses flags for the rest of the
      // turn; drop the pending clause (it can no longer produce a flag).
      if (input.successfulToolCalls > 0) {
        pending = "";
        lastStream = input.stream;
        return undefined;
      }
      if (lastStream !== undefined && lastStream !== input.stream) pending += "\n";
      lastStream = input.stream;
      pending += input.text;
      // Newlines are clause terminators too (the stream-switch separator is
      // one). Normalize them for the scan; the replacement is 1:1 so slice
      // indices stay valid against the original `pending`.
      const scan = pending.replace(/\n/g, ";");
      const completed = /[^.!?;]+[.!?;]+/g;
      let lastIndex = 0;
      for (;;) {
        const match = completed.exec(scan);
        if (match === null) break;
        lastIndex = completed.lastIndex;
        const flag = matchClause(match[0], input.successfulToolCalls);
        if (flag !== undefined) {
          pending = pending.slice(lastIndex);
          return flag;
        }
      }
      pending = pending.slice(lastIndex);
      // A single unterminated clause past the cap is evaluated once (hedge
      // intact) and dropped — never head-sliced.
      if (pending.length > MAX_PENDING_CLAUSE) {
        const whole = pending;
        pending = "";
        return matchClause(whole, input.successfulToolCalls);
      }
      return undefined;
    },
    flush(successfulToolCalls) {
      const clause = pending.trim();
      pending = "";
      if (clause.length === 0 || successfulToolCalls > 0) return undefined;
      return matchClause(clause, successfulToolCalls);
    },
    reset() {
      pending = "";
      lastStream = undefined;
    },
  };
}
