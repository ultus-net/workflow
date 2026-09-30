<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record of the 2026-09-30 residual-harvest-2 subtask, working the wave's remaining concrete P3 review debt. Write-once: append dated supersession notes, never rewrite. -->

### Residual harvest 2 — the wave's remaining concrete P3 review debt (2026-09-30)

**Source:** the five-axis reviews of the 2026-09-30 wave recorded four concrete
P3 items (each named below in `Source (item N)`). This subtask works the list:
fix what is small + verifiable (red-first where behavior changes), record the
rest. Branch `feat/residual-harvest-2` off `origin/main`.

**What landed (per item):**

1. **`test/vendor-anthropic-cache-probe.test.ts` — (a) FIXED, (b) RECORDED.**
   - **(a) the zero-length messages-body blind spot — FIXED.** The P9a-era
     capture guarded the messages branch with `inbound.length > 0`, so an empty
     `POST /v1/messages` body was neither parsed nor counted: `malformedBodies`
     undercounted against its own contract ("bodies that were not a parseable
     JSON object"). The guard is REMOVED for the messages branch
     (`src/integrations/model-usage-proxy.ts`); an empty body now parses to
     `undefined`, fails `isRecord`, and increments `malformedBodies`. The lane
     still forwards the empty bytes raw (no 400, pass-through untouched). The
     completions branch keeps its own `inbound.length > 0` (it 400s malformed
     JSON; that is a different, deliberate posture).
   - **(b) the recipe argv-key hygiene — RECORDED, no doc rewrite.** The run
     recipes in `P8-vendor-cache-probe-harness.md:53,58` and
     `P8p-provider-lane-probe.md:63-66` place the keys as ENV-ASSIGNMENT
     PREFIXES (`WORKFLOW_PROVIDER_API_KEY=… node …`), which put the key in the
     child ENVIRONMENT, not in process argv — it does not appear in `ps`
     argv. There is no `--api-key` argv form anywhere in the ledgers (checked).
     The residual exposure is shell history and `/proc/<pid>/environ`, both
     already answered by the documented history-free alternative
     (`~/.config/workflow/<family>-api-key`, 0600). The wording is accurate as
     written; recorded here rather than churned (the fragments are write-once).

2. **`mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts` — PINNED (no
   behavior change).** The P18(e) ledger stated the argument-data
   false-positive class ("a git invocation where `--git-dir` is not a real
   top-level option (e.g. quoted argument data) is read lexically as a gitdir
   spelling") but left it unpinned. A new cell pins it with an
   INCONSISTENCY-FREE triple: `git status "--git-dir=/tmp/bare"` alone allows;
   the same ref-adjacent write with no gitdir spelling allows; only their
   combination denies `protected-branch-write` — so the deny is attributable to
   the lexical read alone. The `--work-tree` twin rides the same cell.

3. **`test/opencode-server-launcher.test.ts` / `test/opencode-server-ask-e2e.test.ts`
   — FIXED.** Both carried a local `ensureGuardBuilt` that checked `existsSync`
   only: a present-but-stale dist (already-built vendored guard, src changed
   after the last build) would run the enforcement seat executing pre-change
   policy — LESS-0010's hazard, and the very gap `guardDistIsStale` (W120) and
   the shared `ensureToolboxGuardBuilt` (W133) were built to close. Both local
   copies now delegate to the shared stale-aware `ensureToolboxGuardBuilt`
   (`test/fixtures/compiled-dist.ts`), which rebuilds when the dist is missing
   OR stale — the same remedy the e2e suites already use. No product change.

4. **`src/integrations/model-usage-proxy.ts` / its test — PINNED.** The P9a
   journal (`messagesLaneLabels()`) has no production consumer yet; the P9a
   ledger records the surfacing as QUEUED. A new anti-drift pin walks `src/`
   and asserts `messagesLaneLabels` appears in NO file except the proxy's own
   definition. The moment a consumer wires the accessor, the pin goes red and
   the queued-surfacing record must be updated (the LESS-0004 source-artifact
   precedent). No consumer added; the boundary cannot silently drift.

**Evidence:**

- RED (item 1a, pre-fix source): the new zero-length pin fails; 24/25 pass.
  Captured verbatim: `an empty body is not parseable JSON and must count as
  malformed` / `+ actual - expected` / `malformedBodies: 0` vs `malformedBodies: 1`.
- GREEN, focused suites (all exit 0):
  - `test/model-usage-proxy.test.ts` 25/25 (includes the 2 new pins).
  - `mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts` 124/124
    (123 before the new cell).
  - `test/vendor-anthropic-cache-probe.test.ts` 8 tests: 4 pass + 4 named skips.
  - consumers: `test/session-budget.test.ts` 18/18, `test/open-model-proxy.test.ts`
    9/9, `test/budget-downgrade-auto-lane.test.ts` 6/6, `test/task-usage.test.ts`
    4/4.
  - `test/opencode-server-launcher.test.ts` 11/11 and
    `test/opencode-server-ask-e2e.test.ts` 2/2 — run AFTER the shared
    `ensureToolboxGuardBuilt` build (`pnpm --dir mcp-toolbox --filter
    workflow-guard-mcp run build`, exit 0), proving the delegated helper builds
    and the stale-aware path composes.
- `npm run lint` exit 0; `npm run typecheck` exit 0 (unpiped);
  `tsc --noEmit -p mcp-toolbox/apps/workflow-guard-mcp/tsconfig.json` exit 0.
- The P18e/W099/W101 and P9a cells are byte-unchanged; both test diffs are
  append-only.

**Recorded, NOT fixed (honestly):**

- **Item 1(b):** the recipe keys ride an env prefix, not argv; the residual
  shell-history / `/proc/<pid>/environ` exposure is the documented file-based
  alternative's job. No wording change earned a diff.
- **Item 2:** the deny-leaning false-positive class is PINNED, not removed. A
  lexical option-scan is deliberate and conservative (it can add a deny, never
  loosen one); a future "skip quoted words" refinement must update the new cell
  AND the P18(e) fragment's recorded boundary.
- **Item 4:** the journal is still not surfaced into the trail/UI — the pin
  documents the queued boundary, it does not wire a consumer. W111's
  no-model-labels gap for the messages lane stays open until the surfacing
  lands.
