<!-- Ledger fragment: extracted from TASKS.md at line 2963 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W104 - The npm-12 package-shape repair (Complete - the twice-queued W088/W099 debt closed for the recorded apps; the 11-app sibling class discovered and queued) (2026-09-23)

**Source:** the pain-point queue's item 5 — the twice-queued W088 and
W099 records: `npm pack --json` on npm 12.0.2 returns a KEYED object
(keyed by package name) while the package tests destructure the legacy
array, so the destructure itself throws (`object is not iterable`) and
the artifact tests fail on a pristine tree (LESS-0007 recorded it for
workflow-guard-mcp AND browser-verification-mcp; LESS-0016 confirmed
the failure environmental by probing the raw npm shape).

**What landed (tests only — no src changes anywhere):**
- The two recorded apps' package tests are version-portable: the pack
  output is extracted either as the legacy array's first entry or as
  the keyed object's entry FOR THIS PACKAGE, and the entry's `name` is
  now pinned (`assert.equal(entry.name, ...)`) — the old array
  destructure never checked which entry it got, so the repair
  STRENGTHENS the test (a wrong-entry or shape regression now fails).
- DISCOVERED AND QUEUED (not this iteration): the same stale destructure
  exists in 11 MORE toolbox apps (grep: change-intelligence, ci-
  intelligence, code-intelligence, git-intelligence, learning, project-
  memory, review-accountability, skills, test-intelligence,
  verification-accountability, egress-audit) — `toolbox:verify` runs
  every app's suite (`pnpm -r ... run test`), so all 13 package tests
  are red on npm 12 at the release gate. Spot-probe executed live:
  project-memory-mcp fails with the identical
  `object is not iterable`. The sibling sweep is its own next item
  (mechanical, same fix shape, one app at a time or batched by the
  executor with per-app green evidence).

**Evidence:** workflow-guard-mcp — red-first captured live (`object is
not iterable` at the destructure, line 19) then the FULL app suite
94/0 (package + policy 83 + redirect 5 + mcp 5, zero collateral);
browser-verification-mcp — dist built, package test 1/0; project-
memory-mcp spot-probe red live (the queued class); repo lint/typecheck
exit 0; security-assurance checker 7/0; both vendored typechecks OK.

**Acceptance criteria:**
- [x] The two recorded apps' package tests pass on npm 12.0.2 and keep
      their full assertion set (bin maps, executable bits, MCP launch,
      tools list / CDP evidence) unchanged.
- [x] The extraction is version-portable (legacy array or npm-12 keyed
      object) and discriminates by package name (the new name pin).
- [x] No src changes; no verifier weakened (the test gains an
      assertion).
- [x] The 11-app sibling class recorded as a queued finding with the
      grep + live spot-probe evidence.
