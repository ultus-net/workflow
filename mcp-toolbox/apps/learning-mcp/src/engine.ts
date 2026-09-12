import { randomUUID } from "node:crypto";

import type {
  DecisionCheckpointInput,
  LearnerProfile,
  LearningCandidateAnswer,
  LearningCheckpointInput,
  LearningStage,
  PedagogicalMode,
} from "./contracts.js";
import { recordLearningEvidence } from "./learner-profile.js";

/**
 * Prerequisite graph from the spec section 4.1 concept hierarchy: every
 * Intermediate/Systems concept requires all Foundations concepts to be
 * observed and not marked needs-reinforcement.
 */
export const FOUNDATIONS_CONCEPTS = [
  "syntax:variables",
  "syntax:control-flow",
  "types:primitive-vs-object",
  "types:null-safety",
  "functions:signatures",
  "async:promises",
  "errors:handling",
] as const;

export const INTERMEDIATE_CONCEPTS = [
  "architecture:dependency-inversion",
  "concurrency:atomic-operations",
  "state:monotonic-epochs",
  "os:process-isolation",
  "fs:atomic-swaps",
  "testing:invariants",
] as const;

export const PREREQUISITES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  INTERMEDIATE_CONCEPTS.map((concept) => [concept, FOUNDATIONS_CONCEPTS]),
);

export const DEFAULT_MAX_INTERVENTIONS = 3;

export interface CheckpointGateOptions {
  readonly mode: PedagogicalMode;
  readonly sessionInterventions: number;
  readonly maxInterventions?: number;
  readonly now?: number;
}

export interface SocraticCheckpoint {
  readonly concept: string;
  readonly category: LearningCheckpointInput["category"];
  readonly teachableInsight: string;
  readonly socraticQuestion: string;
  readonly candidateAnswers?: readonly LearningCandidateAnswer[];
}

export interface CheckpointGateResult {
  readonly interrupt: boolean;
  readonly reason: string;
  readonly stage?: LearningStage;
  readonly checkpoint?: SocraticCheckpoint;
  readonly profile: LearnerProfile;
}

function needsReinforcement(profile: LearnerProfile, concept: string): boolean {
  return profile.concepts[concept]?.evidence.at(-1)?.kind === "needs-reinforcement";
}

export function evaluateLearningCheckpoint(
  profile: LearnerProfile,
  input: LearningCheckpointInput,
  options: CheckpointGateOptions,
): CheckpointGateResult {
  if (options.mode === "autonomous") {
    return { interrupt: false, reason: "autonomous mode never interrupts the learner", profile };
  }

  const known = profile.concepts[input.concept];
  if (known?.stage === "independent" && !needsReinforcement(profile, input.concept)) {
    return { interrupt: false, reason: `concept "${input.concept}" is already mastered (independent)`, profile };
  }

  const blockedPrerequisite = (PREREQUISITES[input.concept] ?? []).find(
    (prerequisite) => needsReinforcement(profile, prerequisite),
  );
  if (blockedPrerequisite !== undefined) {
    return {
      interrupt: false,
      reason: `prerequisite "${blockedPrerequisite}" needs reinforcement before "${input.concept}"`,
      profile,
    };
  }

  if (options.mode === "socratic-tutor") {
    const budget = options.maxInterventions ?? DEFAULT_MAX_INTERVENTIONS;
    if (options.sessionInterventions >= budget) {
      return { interrupt: false, reason: `socratic-tutor intervention budget exhausted (${budget} per session)`, profile };
    }
  }

  recordLearningEvidence(profile, {
    concept: input.concept,
    kind: "exposed",
    summary: input.teachableInsight,
    timestamp: options.now ?? Date.now(),
  });

  return {
    interrupt: true,
    reason: "teachable moment within the intervention policy for this mode",
    stage: profile.concepts[input.concept]?.stage,
    checkpoint: {
      concept: input.concept,
      category: input.category,
      teachableInsight: input.teachableInsight,
      socraticQuestion: input.socraticQuestion,
      ...(input.candidateAnswers ? { candidateAnswers: input.candidateAnswers } : {}),
    },
    profile,
  };
}

export type DecisionBriefStatus = "pending" | "approved" | "rejected";

export interface DecisionBrief {
  readonly briefId: string;
  readonly input: DecisionCheckpointInput;
  status: DecisionBriefStatus;
  note?: string;
}

export class DecisionLedger {
  readonly #briefs = new Map<string, DecisionBrief>();

  record(input: DecisionCheckpointInput): { briefId: string; brief: DecisionBrief } {
    const briefId = randomUUID();
    const brief: DecisionBrief = { briefId, input, status: "pending" };
    this.#briefs.set(briefId, brief);
    return { briefId, brief };
  }

  resolve(briefId: string, approved: boolean, note?: string): DecisionBrief {
    const brief = this.#briefs.get(briefId);
    if (brief === undefined) throw new TypeError(`unknown decision brief: ${briefId}`);
    brief.status = approved ? "approved" : "rejected";
    if (note !== undefined) brief.note = note;
    return brief;
  }
}
