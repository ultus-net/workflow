<!-- Ledger fragment: extracted from TASKS.md at line 3010 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W105 - The npm-12 sibling sweep: the remaining 11 package tests (Complete - 13/13 package tests green on npm 12; the ci-intelligence pre-existing build break discovered and queued) (2026-09-23)

**Source:** the W104 item's queued discovery — the same stale legacy-
array destructure in 11 more toolbox apps' package tests (the
`toolbox:verify` release gate runs every app's suite).

**What landed (tests only — no src changes anywhere):** the landed
W104 extraction pattern applied to all 11 sibling package tests —
version-portable extraction (legacy array or npm-12 keyed object) with
the entry's `name` pinned per app, ending `const filename =
entry.filename;` so every downstream reference survived unchanged.
Six INLINE-destructure files additionally received the packOutput
binding; five SPLIT files changed only the destructure line. Comment-
block attribution: the inserted blocks carry the W105 tag (not the two
landed apps' W104 tag) because the tag names the iteration that
touched the file — W104 never edited these 11; the review round
confirmed the tag update is correct per-item attribution. The
shared-helper question (the W104 review's P3) is decided for now:
inline per-app, consistent with the two landed W104 apps (per-app test
locality; the apps are standalone packages) — re-open if a future
drift class hits again.

**DISCOVERED AND QUEUED (not this iteration):** ci-intelligence-mcp's
BUILD/typecheck fails pre-existing on main — `error TS18046: 'payload'
is of type 'unknown'` twice in src/github-actions-adapter.ts (lines
171, 178). tsc emits output despite the errors (noEmitOnError
default), so the app's package test runs and passes with the sweep
fix; the failure is unrelated to this diff (zero src changes; the
errors pre-date it at the base commit). Its fix is its own item.

**Evidence:** 11/11 package tests green (each 1/0, per-app dist built)
— 13/13 across the toolbox on npm 12.0.2; per-app typechecks 10/11 OK
(ci-intelligence's pre-existing failure recorded above); repo
lint/typecheck exit 0; security-assurance checker 7/0. The executor
applied the two-variant spec with zero deviations (structural
verification: no stale destructure residue repo-wide, 13 name pins =
11 new + 2 landed, 6 packOutput bindings in the 6 inline files).

**Acceptance criteria:**
- [x] All 11 sibling package tests pass on npm 12.0.2 with the same
      version-portable extraction and name pin as the two landed apps.
- [x] Downstream `filename` references preserved in every file (the
      `const filename = entry.filename;` ending); no other lines
      changed; no src changes.
- [x] 13/13 package tests green across the toolbox — the npm-12
      package-shape class is closed at the release gate.
- [x] The ci-intelligence pre-existing build/typecheck break recorded
      as a queued finding with the exact TS error lines.
