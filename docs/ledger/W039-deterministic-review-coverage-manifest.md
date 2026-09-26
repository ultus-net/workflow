<!-- Ledger fragment: extracted from TASKS.md at line 685 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W039 - Deterministic review coverage manifest

**Objective:** Make review scope a control-plane fact rather than an LLM judgment by deriving the exact changed/untracked files, relevant tasks, tests, authority boundaries, and required review rules before a reviewer runs.

**Depends on:** W038

**Acceptance criteria:**
- [x] A deterministic manifest identifies every in-scope changed/untracked file and the review obligations attached to it.
- [x] Secondary review cannot report complete coverage while required manifest entries remain unreviewed.
- [x] Manifest generation and completion checks have behavioral tests for large diffs, untracked files, and security-sensitive changes.

W039 is complete. `src/review/manifest.ts` derives the manifest deterministically from `git status --porcelain=v1 -z --untracked-files=all` output — every changed and untracked file (renames carry their source path), obligations attached from the explicit `REVIEW_OBLIGATION_RULES` table (security/authority/tests/docs plus the always-present baseline `general`), a code-unit-sorted entry list, and a stable sha256 digest for W041 provenance. The hub reviewer sources status through the same contained shell seam as the diff (`createGitStatusSource`), embeds the rendered manifest in the rubric prompt, and fails closed on any approval whose final `[COVERAGE]` line leaves manifest entries unreviewed (`src/integrations/hub-reviewer.ts`, wired through `createReviewerFactory`); `changes_requested` verdicts are never coverage-gated, and a missing status source leaves the gate dormant rather than fabricating scope. Behavioral coverage in `test/review-manifest.test.ts` proves large diffs (801 synthetic entries), untracked files (including the exact `git diff HEAD` omission they close), renames, deletions, and security-sensitive obligation attachment against a real git repository, plus exact-gap completion checks; `test/hub-reviewer.test.ts` proves the approval coverage gate fail-closed, the no-status-source backward-compatible path, and status-sourcing failure containment. Honest limits, stated plainly: the `[COVERAGE]` line binds reviewer claims to the deterministic scope list — it cannot prove the reviewer actually read each file (the same process discipline as the ≥3-axis rule); direct verifier-token `/run/review` submissions are not manifest-gated (honest-client discipline, unchanged); W040 partitioning and W041 provenance are expected to build on the manifest and its digest.
