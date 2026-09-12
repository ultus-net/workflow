import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import {
  LEARNING_STAGES,
  type LearnerEvidence,
  type LearnerProfile,
  type LearningOpportunity,
  type LearningStage,
  type OpportunityType,
} from "./contracts.js";

const STAGE_ORDER: readonly LearningStage[] = LEARNING_STAGES;

const TYPE_WEIGHT: Record<OpportunityType, number> = {
  foundations: 0.35,
  design: 0.3,
  debugging: 0.25,
  "new-concept": 0.2,
};

export function createLearnerProfile(): LearnerProfile {
  return { version: 1, concepts: {} };
}

export function defaultLearnerProfilePath(): string {
  const dataRoot = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataRoot, "workflow", "learner-profile.json");
}

export function loadLearnerProfile(path = defaultLearnerProfilePath()): LearnerProfile {
  try {
    if (!existsSync(path)) return createLearnerProfile();
    const raw = readFileSync(path, "utf8");
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
    // Ignore corrupt or unreadable profile and create fresh
  }
  return createLearnerProfile();
}

export function saveLearnerProfile(profile: LearnerProfile, path = defaultLearnerProfilePath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(profile, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function updateLearnerProfile(
  update: (profile: LearnerProfile) => void,
  path = defaultLearnerProfilePath(),
): LearnerProfile {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new Error("Learner profile is currently locked by another process. Remove stale lock if process terminated.");
  }

  try {
    writeFileSync(lockFd, String(process.pid));
    const profile = loadLearnerProfile(path);
    update(profile);
    saveLearnerProfile(profile, path);
    return profile;
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
    } catch {
      // Ignore if lock file was already unlinked
    }
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
