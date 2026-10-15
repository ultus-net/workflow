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

// ── M6: the single-writer lock ─────────────────────────────────────────────
//
// Two writers share one `<path>.lock` (this module and `learning-mcp`). The
// original acquire threw on the first EEXIST, so a concurrent session failed
// outright and a crash between `openSync` and the PID write stranded the lock
// forever ("Remove stale lock if process terminated"). This is the documented
// availability defect (`integration-plan.md` §F item 2): the defect was never
// corruption (the write is atomic temp+rename), it was liveness. The fix keeps
// the same exclusive-create lock but adds two recoveries:
//
//   1. Stale reclaim: a lock whose PID is unreadable (crash mid-acquire) or
//      whose process is gone is abandoned, reclaimed, and retried.
//   2. Bounded retry: a live holder is waited on up to `timeoutMs`, so two
//      overlapping sessions serialize instead of one throwing.
//
// Ownership is unchanged: whoever holds the lock does the read-modify-write.

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 25;
const MAX_STALE_RECLAIMS = 3;

export interface LearnerProfileLockOptions {
  /** Wait this long for a live holder before failing. Default 5000ms. */
  readonly timeoutMs?: number;
  /** Delay between acquire attempts. Default 25ms. */
  readonly retryDelayMs?: number;
}

/** Synchronous sleep; the update path is sync, so a blocking wait is required. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Is the lock at `lockPath` abandoned? True when it already vanished, holds no
 * readable PID (a crash between open and write), or names a process that is
 * gone. A live PID, including one owned by another user (EPERM), is not stale.
 */
function lockIsStale(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8").trim();
  } catch {
    // The holder released it between our EEXIST and this read; take it.
    return true;
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function acquireLearnerProfileLock(lockPath: string, options: LearnerProfileLockOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
  const deadline = Date.now() + timeoutMs;
  let staleReclaims = 0;
  for (;;) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (lockIsStale(lockPath)) {
      staleReclaims += 1;
      // A lock we cannot reclaim (e.g. unlink denied) must not spin forever.
      if (staleReclaims > MAX_STALE_RECLAIMS) {
        throw new Error("Learner profile lock is stale but cannot be reclaimed. Remove it manually if no process is running.");
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Lost the reclaim race; the next iteration retries acquisition.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("Learner profile is currently locked by another process. Remove stale lock if process terminated.");
    }
    sleepSync(retryDelayMs);
  }
}

export function updateLearnerProfile(
  update: (profile: LearnerProfile) => void,
  path = defaultLearnerProfilePath(),
  options: LearnerProfileLockOptions = {},
): LearnerProfile {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const lockFd = acquireLearnerProfileLock(lockPath, options);

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
