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

export interface LearnerEvidence {
  readonly concept: string;
  readonly kind: EvidenceKind;
  readonly summary: string;
  readonly timestamp: number;
  readonly context?: string;
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

export const OPPORTUNITY_TYPES = [
  "foundations",
  "design",
  "debugging",
  "new-concept",
] as const;

export type OpportunityType = typeof OPPORTUNITY_TYPES[number];

export interface LearningCandidateAnswer {
  readonly label: string;
  readonly description: string;
}

export interface LearningOpportunity {
  readonly concept: string;
  readonly type: OpportunityType;
  readonly relevance: number;   // 0.0 - 1.0
  readonly consequence: number; // 0.0 - 1.0
  readonly teachableInsight: string;
  readonly socraticQuestion: string;
  readonly candidateAnswers?: readonly LearningCandidateAnswer[];
}

export interface DecisionOption {
  readonly name: string;
  readonly rationale: string;
  readonly blastRadius: "low" | "medium" | "high";
}

export interface DecisionAlternative {
  readonly name: string;
  readonly drawback: string;
}

export interface DecisionBrief {
  readonly title: string;
  readonly context: string;
  readonly chosenOption: DecisionOption;
  readonly rejectedAlternatives: readonly DecisionAlternative[];
  readonly tradeoffs: {
    readonly benefits: readonly string[];
    readonly liabilities: readonly string[];
  };
}

export interface DiagnosticLesson {
  readonly code: number;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly plainEnglishExplanation: string;
  readonly underlyingPrinciple: string;
  readonly guidingHints: readonly string[];
  readonly mode: PedagogicalMode;
}
