import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import {
  LEARNING_STAGES,
  type LearnerEvidence,
  type LearnerProfile,
  type LearningStage,
} from "./contracts.js";

const STAGE_ORDER: readonly LearningStage[] = LEARNING_STAGES;

export function createLearnerProfile(): LearnerProfile {
  return { version: 1, concepts: {} };
}

export function defaultLearnerProfilePath(): string {
  const override = process.env.LEARNING_MCP_DATA_DIR;
  const dataRoot = override ?? (process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"));
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
