import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  LEARNING_STAGES,
  type LearnerEvidence,
  type LearnerProfile,
  type LearningOpportunity,
  type LearningStage,
  type OpportunityType,
} from "./contracts.js";

/**
 * W206 (M6, `augur/docs/integration-plan.md` §F item 2, option (a)): this
 * module is PURE with respect to the learner-profile file. `learning-mcp` is
 * the SOLE writer of `<path>` (it owns the `<path>.lock` and the atomic
 * temp+rename write, `mcp-toolbox/apps/learning-mcp/src/learner-profile.ts`).
 * The plane reads the profile and computes over it, and hands evidence to an
 * injected `LearnerEvidenceRecorder` port when it wants it persisted.
 *
 * There is no write path, no lock, and no `save`/`update` here any more. The
 * pre-W206 module shared the one `<path>.lock` with `learning-mcp`, which was
 * the availability defect this slice removes (two writers, one lock).
 *
 * The concrete recorder that calls the `record_learning_evidence` MCP tool
 * through the assistant tool lane lives in `src/assistant/` — never here. The
 * plane must not import the assistant subtree: the dependency arrow is one-way
 * (assistant imports plane), enforced by `test/assistant-isolation.test.ts`.
 */

const STAGE_ORDER: readonly LearningStage[] = LEARNING_STAGES;

const TYPE_WEIGHT: Record<OpportunityType, number> = {
  foundations: 0.35,
  design: 0.3,
  debugging: 0.25,
  "new-concept": 0.2,
};

/**
 * The injected persistence port (W206). A caller with evidence to persist hands
 * it here; the implementation decides where it lands. The assistant adapter
 * (`src/assistant/learner-evidence.ts`) fulfills it by calling the
 * `record_learning_evidence` MCP tool through the assistant tool lane, so the
 * single writer stays `learning-mcp`. The plane itself holds no implementation.
 */
export interface LearnerEvidenceRecorder {
  /** Persist one observation. Rejects when the persistence lane refuses it. */
  record(evidence: LearnerEvidence): Promise<void>;
}

/**
 * The default recorder: a documented no-op. HONEST NOTE (W206): the tutor
 * pipeline has no live evidence-emission call site today, so nothing composes a
 * real recorder yet. This value exists so a caller that only reads
 * (the TUI profile panel) or a test can hold a recorder without a non-null
 * assertion. It performs no IO and holds no lock. When a real recorder is
 * composed it MUST be the assistant-lane adapter
 * (`src/assistant/learner-evidence.ts`), which routes through the
 * `record_learning_evidence` MCP tool so `learning-mcp` stays the sole writer.
 * Prefer that adapter wherever silently dropping evidence would be wrong.
 */
export const noopLearnerEvidenceRecorder: LearnerEvidenceRecorder = {
  record(): Promise<void> {
    return Promise.resolve();
  },
};

export function createLearnerProfile(): LearnerProfile {
  return { version: 1, concepts: {} };
}

/**
 * Pure path helper: where the profile lives. This module never writes it; the
 * helper exists so the default read path and callers agree on one location.
 */
export function defaultLearnerProfilePath(): string {
  const dataRoot = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataRoot, "workflow", "learner-profile.json");
}

/**
 * Parse and validate a profile from its raw file text. PURE: no IO, no lock.
 * A version mismatch, a malformed `concepts` map, or a concept with an unknown
 * stage, a non-finite `lastObservedAt`, or a non-array `evidence` list all
 * yield a fresh profile rather than a partially trusted one.
 */
export function parseLearnerProfile(raw: string): LearnerProfile {
  try {
    const parsed = JSON.parse(raw) as Partial<LearnerProfile>;
    if (parsed.version === 1 && parsed.concepts && typeof parsed.concepts === "object" && !Array.isArray(parsed.concepts)) {
      const validConcepts = Object.values(parsed.concepts).every(
        (concept) =>
          concept &&
          typeof concept === "object" &&
          STAGE_ORDER.includes(concept.stage) &&
          typeof concept.lastObservedAt === "number" &&
          Number.isFinite(concept.lastObservedAt) &&
          Array.isArray(concept.evidence),
      );
      if (validConcepts) return parsed as LearnerProfile;
    }
  } catch {
    // Ignore corrupt content and fall through to a fresh profile.
  }
  return createLearnerProfile();
}

/**
 * Read the persisted profile. READ-ONLY: no lock, no write, no directory
 * creation. A missing, corrupt, or unreadable file yields a fresh profile, so
 * the plane always has a value to compute over and never throws at a read.
 * `learning-mcp` owns the write; this function only ever reads.
 */
export function loadLearnerProfile(path = defaultLearnerProfilePath()): LearnerProfile {
  try {
    if (!existsSync(path)) return createLearnerProfile();
    return parseLearnerProfile(readFileSync(path, "utf8"));
  } catch {
    // Ignore an unreadable profile and create a fresh one.
    return createLearnerProfile();
  }
}

export function recordLearningEvidence(profile: LearnerProfile, evidence: LearnerEvidence): void {
  const current = profile.concepts[evidence.concept];
  const evidenceStage = evidence.kind === "needs-reinforcement" ? undefined : evidence.kind;
  const stage = evidenceStage ?? current?.stage ?? "exposed";

  const nextStage =
    current && STAGE_ORDER.indexOf(current.stage) > STAGE_ORDER.indexOf(stage)
      ? current.stage
      : stage;

  profile.concepts[evidence.concept] = {
    stage: nextStage,
    lastObservedAt: evidence.timestamp,
    evidence: [...(current?.evidence ?? []), evidence].slice(-20),
  };
}

export interface OpportunitySelectionOptions {
  readonly interventionsThisSession?: number;
  readonly maxInterventionsPerSession?: number;
}

export function selectLearningOpportunity(
  profile: LearnerProfile,
  opportunities: readonly LearningOpportunity[],
  options: OpportunitySelectionOptions = {},
): LearningOpportunity | undefined {
  const used = options.interventionsThisSession ?? 0;
  const budget = options.maxInterventionsPerSession ?? 3;
  if (used >= budget) return undefined;

  let best: { opportunity: LearningOpportunity; score: number } | undefined;

  for (const opportunity of opportunities) {
    const known = profile.concepts[opportunity.concept];
    const needsReinforcement = known?.evidence.at(-1)?.kind === "needs-reinforcement";

    // If already independent, gap is 0 unless reinforcement was requested
    const gap = needsReinforcement
      ? 1.0
      : known
        ? 1.0 - (STAGE_ORDER.indexOf(known.stage) + 1) / STAGE_ORDER.length
        : 1.0;

    // If already mastered and not needing reinforcement, skip
    if (known?.stage === "independent" && !needsReinforcement) continue;

    const score =
      opportunity.relevance * 0.4 +
      opportunity.consequence * 0.3 +
      gap * 0.3 +
      (TYPE_WEIGHT[opportunity.type] ?? 0.2);

    if (score >= 0.5 && (!best || score > best.score)) {
      best = { opportunity, score };
    }
  }

  return best?.opportunity;
}
