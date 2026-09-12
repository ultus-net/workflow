export const PEDAGOGICAL_MODES = [
  "learn-to-code",
  "socratic-tutor",
  "co-architect",
  "walkthrough",
  "autonomous",
] as const;

export type PedagogicalMode = typeof PEDAGOGICAL_MODES[number];

export const LEARNING_STAGES = [
  "exposed",
  "developing",
  "demonstrated",
  "independent",
  "critique",
] as const;

export type LearningStage = typeof LEARNING_STAGES[number];

export const EVIDENCE_KINDS = [
  ...LEARNING_STAGES,
  "needs-reinforcement",
] as const;

export type EvidenceKind = typeof EVIDENCE_KINDS[number];

export const CHECKPOINT_CATEGORIES = ["foundations", "design", "debugging", "systems"] as const;

export type CheckpointCategory = typeof CHECKPOINT_CATEGORIES[number];

export interface LearnerEvidence {
  readonly concept: string;
  readonly kind: EvidenceKind;
  readonly summary: string;
  readonly timestamp: number;
}

export interface LearnerConcept {
  readonly stage: LearningStage;
  readonly lastObservedAt: number;
  readonly evidence: readonly LearnerEvidence[];
}

export interface LearnerProfile {
  readonly version: 1;
  readonly concepts: Record<string, LearnerConcept>;
}

export interface LearningCandidateAnswer {
  readonly label: string;
  readonly description: string;
}

export interface LearningCheckpointInput {
  readonly concept: string;
  readonly category: CheckpointCategory;
  readonly relevance: number;
  readonly consequence: number;
  readonly teachableInsight: string;
  readonly socraticQuestion: string;
  readonly candidateAnswers?: readonly LearningCandidateAnswer[];
}

export interface DecisionCheckpointInput {
  readonly title: string;
  readonly context: string;
  readonly proposedChoice: {
    readonly name: string;
    readonly rationale: string;
    readonly blastRadius: "low" | "medium" | "high";
  };
  readonly rejectedAlternatives: readonly { readonly name: string; readonly drawback: string }[];
  readonly tradeoffs: {
    readonly benefits: readonly string[];
    readonly liabilities: readonly string[];
  };
}
