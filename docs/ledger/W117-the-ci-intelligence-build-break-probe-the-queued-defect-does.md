<!-- Ledger fragment: extracted from TASKS.md at line 3779 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W117 - The ci-intelligence build-break probe: the queued defect does not reproduce (Complete - the premise falsified in the committed state; P17 retired to the verification record) (2026-09-24)

**Source:** the park file's P17 (W105's queued item: `error TS18046:
'payload' is of type 'unknown'` twice in mcp-toolbox
`apps/ci-intelligence-mcp/src/github-actions-adapter.ts:171,178`) — the
park file's own rule picked it as a high-value candidate (self-contained,
a live build failure). Per LESS-0015/0018 (probe before implementing),
the END-TO-END state was probed first.

**The probe result: the premise is falsified.** (Facts marked
"executed" below were run by this iteration's session; the fresh-eyes
reviewer — no shell — statically corroborated the core claim and
disclosed the rest as execution-only facts.)
- EXECUTED: `tsc --noEmit -p tsconfig.json` exits 0 in the committed
  tree; the app's suite is 28/28 green (npm test: build + test both
  pass). Statically corroborated by the reviewer: `request` is generic
  (`Promise<z.infer<T>>`), so `payload` is typed, not `unknown` —
  TS18046 at 171/178 is implausible on this source.
- EXECUTED: the adapter source is byte-identical to the vendoring
  commit (8053588) — no code drift.
- The toolchain facts: tsc 5.9.3 (EXECUTED via `tsc --version`);
  zod@3.25.76 lockfile-pinned, and the lockfile pins the SAME zod
  before AND after W105's merge (diff empty) — no lockfile drift; a
  single zod@3.25.76 in the pnpm store and NO zod ^4 anywhere in the
  workspace — no hoist/cross-contamination (read-verified by the
  reviewer from the store listing + the package.json manifests).
- Ruled out: code drift, lockfile drift, sibling zod-4 hoisting. The
  W105-era environment's exact zod/tsc resolution could NOT be
  reconstructed — the failure was environment-dependent and honestly
  stays unexplained beyond "does not reproduce in the committed state".

**Deliberately NOT done:** no src change (there is nothing to fix in
the committed state); no speculative type annotation added (adding a
schema-typing workaround for a non-reproducing error would be
manufacturing work and would drift the file from its pinned
toolchain).

**Acceptance criteria:**
- [x] The probe recorded with its discriminating facts (typecheck exit
      0; tests 28/28; the byte-identity of the adapter since vendoring;
      the ruled-out causes enumerated).
- [x] The park file's P17 superseded with the dated re-verification
      (append-only — the entry stays, its premise retired).
- [x] LESS-0039 records the discipline: probe a queued defect's premise
      BEFORE implementing; an environment-dependent non-reproduction
      retires an entry with a dated supersession, and the unexplained
      root cause stays stated, not guessed.

**Residual (recorded, not fixed):** the W105-era failure's root cause
remains unexplained — if the TS18046 class ever reproduces (a
toolchain/zod drift), the exact error cites in W105's record are the
reproduction recipe; a toolchain pin (a committed typescript/zod
resolution the toolbox already has) is what makes this deterministic
going forward.
