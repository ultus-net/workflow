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

// ── M6: the single-writer lock ─────────────────────────────────────────────
//
// See `src/pedagogy/learner-profile.ts` for the full rationale: both writers
// share one `<path>.lock`, and the original acquire threw on the first EEXIST.
// The documented defect (`integration-plan.md` §F item 2) is availability, not
// corruption. This keeps the exclusive-create lock and adds stale reclaim plus
// a bounded retry so overlapping sessions serialize instead of one throwing.

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 25;
const MAX_STALE_RECLAIMS = 3;

export interface LearnerProfileLockOptions {
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockIsStale(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8").trim();
  } catch {
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
      if (staleReclaims > MAX_STALE_RECLAIMS) {
        throw new Error("Learner profile lock is stale but cannot be reclaimed. Remove it manually if no process is running.");
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Lost the reclaim race; retry acquisition.
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
