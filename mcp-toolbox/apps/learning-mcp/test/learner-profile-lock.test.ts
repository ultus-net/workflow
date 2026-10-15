import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadLearnerProfile, recordLearningEvidence, updateLearnerProfile } from "../src/learner-profile.js";

/**
 * M6 (`integration-plan.md` §F item 2): the learning-mcp writer shares one
 * `<path>.lock` with `src/pedagogy/learner-profile.ts`. This asserts the same
 * stale-reclaim and bounded-retry recovery as the plane's gate, so the two
 * writers cannot drift on the availability contract.
 */

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "learning-mcp-lock-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("M6 (learning-mcp): a dead-PID lock is reclaimed", () => {
  withTempDir((dir) => {
    const profilePath = join(dir, "profile.json");
    writeFileSync(`${profilePath}.lock`, "1073741824", { mode: 0o600 });
    const result = updateLearnerProfile((profile) => {
      recordLearningEvidence(profile, { concept: "async:promises", kind: "developing", summary: "recovered", timestamp: 1000 });
    }, profilePath);
    assert.equal(result.concepts["async:promises"]?.stage, "developing");
  });
});

test("M6 (learning-mcp): an empty lock (crash mid-acquire) is reclaimed", () => {
  withTempDir((dir) => {
    const profilePath = join(dir, "profile.json");
    writeFileSync(`${profilePath}.lock`, "", { mode: 0o600 });
    const result = updateLearnerProfile((profile) => {
      recordLearningEvidence(profile, { concept: "async:promises", kind: "demonstrated", summary: "recovered", timestamp: 1000 });
    }, profilePath);
    assert.equal(result.concepts["async:promises"]?.stage, "demonstrated");
  });
});

test("M6 (learning-mcp): a live lock past the timeout throws", () => {
  withTempDir((dir) => {
    const profilePath = join(dir, "profile.json");
    writeFileSync(`${profilePath}.lock`, String(process.pid), { mode: 0o600 });
    assert.throws(
      () =>
        updateLearnerProfile((profile) => {
          recordLearningEvidence(profile, { concept: "x", kind: "exposed", summary: "no", timestamp: 1 });
        }, profilePath, { timeoutMs: 100, retryDelayMs: 10 }),
      /currently locked by another process/,
    );
    assert.equal(readFileSync(`${profilePath}.lock`, "utf8"), String(process.pid), "a timed-out acquire does not clobber the holder's lock");
    assert.deepEqual(loadLearnerProfile(profilePath).concepts, {}, "a refused update wrote nothing");
  });
});
