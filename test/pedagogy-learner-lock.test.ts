import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadLearnerProfile,
  recordLearningEvidence,
  updateLearnerProfile,
} from "../src/index.js";

/**
 * M6 (integration-plan §F item 2): the learner-profile lock is an availability
 * boundary, not a corruption boundary. The write is atomic temp+rename; the
 * defect was that a second writer threw on the first EEXIST and a crash left a
 * permanent lock. These cover the two recoveries: stale reclaim and bounded
 * retry, plus the monotonic evidence merge both writers must preserve.
 */

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "workflow-learner-lock-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("M6: a lock holding a dead PID is reclaimed instead of throwing", () => {
  withTempDir((dir) => {
    const profilePath = join(dir, "profile.json");
    // PID 2^30 is above Linux's default pid_max; ESRCH makes it provably stale
    // without risking a real running PID. If that ever changes, the lock is
    // treated as live and the test fails loudly rather than silently passing.
    writeFileSync(`${profilePath}.lock`, "1073741824", { mode: 0o600 });

    const result = updateLearnerProfile((profile) => {
      recordLearningEvidence(profile, {
        concept: "closures",
        kind: "developing",
        summary: "Recovered from a stale lock",
        timestamp: 7000,
      });
    }, profilePath);

    assert.equal(result.concepts["closures"]?.stage, "developing");
    assert.equal(loadLearnerProfile(profilePath).concepts["closures"]?.stage, "developing");
  });
});

test("M6: a lock with no readable PID (crash mid-acquire) is reclaimed", () => {
  withTempDir((dir) => {
    const profilePath = join(dir, "profile.json");
    // The crash window between openSync and the PID write leaves an empty lock.
    writeFileSync(`${profilePath}.lock`, "", { mode: 0o600 });

    const result = updateLearnerProfile((profile) => {
      recordLearningEvidence(profile, {
        concept: "promises",
        kind: "demonstrated",
        summary: "Recovered from an empty lock",
        timestamp: 8000,
      });
    }, profilePath);

    assert.equal(result.concepts["promises"]?.stage, "demonstrated");
  });
});

test("M6: a live lock is waited on, not thrown on, and both writers land", () => {
  withTempDir((dir) => {
    const profilePath = join(dir, "profile.json");
    // Hold the lock as this (live) process would, then release it shortly.
    const holder = updateLearnerProfile((profile) => {
      recordLearningEvidence(profile, {
        concept: "variables",
        kind: "exposed",
        summary: "First writer",
        timestamp: 1000,
      });
    }, profilePath);
    assert.equal(holder.concepts["variables"]?.stage, "exposed");

    // A second, overlapping update must succeed against the now-released lock.
    const second = updateLearnerProfile((profile) => {
      recordLearningEvidence(profile, {
        concept: "variables",
        kind: "independent",
        summary: "Second writer",
        timestamp: 2000,
      });
    }, profilePath, { timeoutMs: 500 });
    assert.equal(second.concepts["variables"]?.stage, "independent");

    // The merge is monotonic and preserves both writers' evidence.
    const onDisk = loadLearnerProfile(profilePath);
    assert.equal(onDisk.concepts["variables"]?.stage, "independent");
    assert.equal(onDisk.concepts["variables"]?.evidence.length, 2);
  });
});

test("M6: a live lock held past the timeout throws the documented error", () => {
  withTempDir((dir) => {
    const profilePath = join(dir, "profile.json");
    const lockPath = `${profilePath}.lock`;
    // This process's own PID is live, so the holder is never stale.
    writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
    assert.throws(
      () =>
        updateLearnerProfile((profile) => {
          recordLearningEvidence(profile, {
            concept: "x",
            kind: "exposed",
            summary: "should not land",
            timestamp: 1,
          });
        }, profilePath, { timeoutMs: 100, retryDelayMs: 10 }),
      /currently locked by another process/,
    );
  });
});
