# Base-loop experiment ledger (create-only, append-only)

One structured record per base-loop iteration. This file did not exist when the
loop started (the repo's durable memory is `docs/agents/lessons.md`, a
monolithic append-only file); this ledger was created at iteration LESS-0067 to
carry the reproducibility schema the playbook specifies. Never rewrite an
existing record; append supersession notes to a record's tail instead.

```text
n · date · hypothesis (falsifiable) · trace evidence · code change · commit SHA
+ git tree · artifact name + checksum · exact command/config · test results ·
eval job path · score · gains · losses · exceptions · token/cost/duration ·
interpretation · keep/revert · next hypothesis
```

---

## Iteration 1 (LESS-0067) — 2026-10-03

- **n:** 1
- **date:** 2026-10-03
- **pain point:** "Please work on 3 items from the issues from github."
- **selection:** no landable code item exists among the open issues. Open-issue audit: 10 open (#448/#447/#446/#445/#444/#439/#290/#284/#142/#141), all parked P20-P24 (P20-P24 NVIDIA re-address queue) or human-gated (P5 live run #284, P11 measurement #290, W148 #141 gated on an AzDO repo, W149 #142 gated on a live tag, W179 #439 whose PR #450 already merged); 0 open PRs. First GitHub Project (board #2) non-Done item worth landing: #142 W149 publish workflow. Chosen one minimal candidate: the workflow's binary verify step, whose recorded review marked it "VERIFIED-OK (no change)" without execution.
- **hypothesis (falsifiable):** the `Verify the vendored binary against the recorded pin` step (`run: sha256sum -c opencode.sha256`) cannot catch a re-tagged release serving a different binary, because it hashes the just-downloaded local copy against a pin file rather than comparing an independently reported download digest. Predicted effect: after wiring the download step's digest through the `-c` contract, a re-tagged asset fails the build; pre-change it exits 0 on drift.
- **trace evidence:** `git grep`/`git show origin/main` on `src/integrations/egress-credential.ts`, `egress-binding.ts`, `credentials.ts`, `model-usage-proxy.ts` (ruled out the W178-W184 egress wave: landable scope exhausted, no missing behavioral test or broken invariant); `.github/workflows/publish-image.yml:45-61` (download step had no `id`/digest output; verify step inline `run: sha256sum -c opencode.sha256`); `docs/ledger/w149-publish-digest.md:45-75` (review's "VERIFIED-OK (no change)" prose disposition). **Probe that falsified the hypothesis:** a throwaway bash block in the worktree executed the real `sha256sum -c` against a correctly-cut pin then a drifted file — output `opencode: OK`/`exit=0` for the match, `opencode: FAILED`/`exit=1` for the drift. The original one-liner already detects tag drift.
- **code change:** proposed workflow hardening IMPLEMENTED then REVERTED (false premise). Landed, test-only: three executable pins for the verify step in `test/publish-image-workflow.test.ts` (match passes; re-tagged asset exits non-zero with coreutils `did NOT match`; characterization pin constrains the check to the committed pin file) + `runBlockForStep` generalized to read inline `run:` scalars. No workflow code changed.
- **commit SHA:** `0893cbd2` on `fix/w149-binary-pin`
- **git tree / base:** based on `origin/main@521992f1`; worktree `.worktrees/w149-binary-pin`
- **artifact name + checksum:** `test/publish-image-workflow.test.ts` — sha256 `(see git blob at 0893cbd2)`
- **exact command/config:** `node --import tsx --test test/publish-image-workflow.test.ts`; `npm run lint`; `npm run typecheck`
- **test results:** focused 6/6 pass / 0 fail; lint exit 0; typecheck exit 0. Mutation verification (fresh-eyes reviewer, worktree): verify `run:` -> `echo skip` makes tests 5+6 red; verify `run:` -> `sha256sum -c nonexistent.sha256` makes tests 4+5+6 red (positive pin non-vacuous). Pre-existing record-step tests (3) unchanged and green.
- **eval job path:** local focused run only (the curated `test:ci` suite includes this file); no CI run (commit not pushed — operator gate: never push without direction).
- **score:** N/A (test-only characterization; no benchmark metric). Confidence stage A/B: synthetic reproduction (executed block + mutation).
- **gains:** the previously unexecuted verify-step contract is now frozen by an executable pin; a future weakening (`true`, wrong file) fails loudly.
- **losses:** the iteration did not add a new security property (the hypothesized gap did not exist); no other candidate advanced.
- **exceptions:** reviewer toolset lacked shell earlier in the repo's history but in this session the `general` reviewer had shell and independently mutation-tested; no CI run.
- **token/cost/duration:** single executor-less iteration; one `general` reviewer subagent; bounded (< 1 session).
- **interpretation:** negative result — the predicted defect was falsified by probe; the honest residue (an untested contract) was landed as a characterization pin and the falsified prediction recorded rather than hidden.
- **keep/revert:** keep the pin-only characterization (review APPROVE, five axes, fingerprint `1c56fa3ffb30`); revert the workflow hardening (not committed).
- **next hypothesis:** another base-loop iteration should either (a) take the one genuinely-open W-item with an offline-acceptable slice if the operator authorizes a live/gated run, or (b) explicitly name the selection exhaustion (all open issues parked/human-gated/merged-but-open) instead of manufacturing a third item; a future candidate class is the missing `docs/ledger/` fragments for W178-W184 on main (docs-only, but must not duplicate the issues' own records).

---

# Campaign 1 — bounded multi-iteration RSI campaign (2026-10-04)

Protocol: `docs/agents/rsi-loop-playbook.md` "Multi-iteration campaigns";
reading-list citations per the campaign template. N = 3 (default; hard cap 5).

**Candidate set (built before iterating — AIDE² 2609.26457 diversity):**

1. `security` — **SHA-pin the GitHub Action refs.** All 13 `uses:` across the
   three workflows are mutable major-version tags (`@v4`/`@v3`/`@v6`); none is
   an immutable commit. Moving a major tag is the standard supply-chain vector.
2. `gate` — **Make the kernel-purity rule executable.** `AGENTS.md` states
   `src/kernel/` "can never depend on a host surface," but no test enforces it
   (all kernel imports are relative today; a future `node:`/SDK import would
   pass CI silently).
3. `docs` — **Reconcile the worktree convention with guard confinement.**
   `AGENTS.md` "Worktrees" says add at `/var/home/hunter/worktrees/<name>`, but
   the guard confines mutations to the workspace root and blocked that path
   repeatedly this session; the guidance contradicts the enforced policy.

**Appraisal (HSI 2608.08466 two bounds):** each candidate has an informative
offline signal and is within the frozen model's ceiling — no drop.

## Iteration 2 (campaign n=1) — 2026-10-04

- **n:** 2
- **date:** 2026-10-04
- **pain point:** campaign candidacy 1 (`security`).
- **selection:** highest-value unblocked candidate; no previous tag (first
  iteration). Tag: `security`.
- **hypothesis (falsifiable):** every `uses:` in `.github/workflows/` resolves
  through a mutable tag, so a compromised/moved upstream tag can execute
  arbitrary code in this repo's CI with `contents: write` / `packages: write`
  (publish) or `contents: read` (ci). Predicted effect: after pinning each
  action to the exact commit SHA its current major tag points at (with the
  human-readable tag retained in a trailing comment), the workflows become
  content-addressed: a moved tag cannot change what runs. Pre-change a
  `uses: actions/checkout@v4` is mutable; post-change the SHA is fixed.
- **at-risk regressions:** (a) a wrong SHA breaks CI outright; (b) a nested
  annotated tag needs dereferencing (pnpm/action-setup@v4 is `type=tag`, every
  other is `type=commit`); (c) the tag comment must survive lint/format.
- **accept/reject rule:** accept iff every `uses:` is a 40-hex SHA, each SHA
  equals `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` dereferenced to a
  commit, the trailing `# <tag>` comment names the human-readable ref, and
  `npm run lint` + `npm run typecheck` exit 0. Reject if any SHA cannot be
  resolved or any workflow breaks.
- **non-goals:** no new workflow features, no permission-narrowing (separate
  axis), no Dependabot/renovate config.
- **trace evidence:** `grep -rn "uses:" .github/workflows/` = 13 refs
  (ci.yml:22,23,27,41,42,46; publish-image.yml:48,99,102,110;
  update-deps.yml:11,12,15); `grep -rnE "uses:.*@[0-9a-f]{40}"` = empty;
  SHAs resolved via `gh api` (checkout v4.4.0 `11d5960a…`, setup-node v4.4.0
  `49933ea5…`, pnpm v4 deref `b906affc…`, buildx v3 `8d2750c6…`, login v3
  `c94ce9fb…`, build-push v6 `10e90e36…`).
- **preregistered:** before edit (this entry).

### Result — iteration 1 (campaign n=1)

- **change:** `.github/workflows/{ci,publish-image,update-deps}.yml` — 13 refs
  pinned to 40-hex commits with trailing `# <tag>` comments;
  `test/workflow-action-pins.test.ts` added (2 shape pins);
  `package.json` `test:ci` gains the new suite (the gate is CI-enforced, not
  just present).
- **commit:** `b5603fda` on `w185/actions-sha-pin`.
- **SHA↔tag correspondence (verified live, `gh api`, 2026-10-04):**
  | action | tag | committed SHA |
  |---|---|---|
  | actions/checkout | v4.4.0 | `11d5960a326750d5838078e36cf38b85af677262` |
  | actions/setup-node | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
  | pnpm/action-setup | v4 (annotated → deref) | `b906affcce14559ad1aafd4ab0e942779e9f58b1` |
  | docker/setup-buildx-action | v3 | `8d2750c68a42422c14e847fe6c8ac0403b4cbd6f` |
  | docker/login-action | v3 | `c94ce9fb468520275223c153574b00df6fe4bcc9` |
  | docker/build-push-action | v6 | `10e90e3645eae34f1e60eeb005ba3a3d33f178e8` |
- **evidence (external verifier):** `node --import tsx --test
  test/workflow-action-pins.test.ts` = 2/2; mutation test (one ref reverted to
  `@v4`) = 2/2 RED, restored GREEN; `test/publish-image-workflow.test.ts` =
  8/8; `npm run lint` exit 0; `npm run typecheck` exit 0.
- **score:** gain. Prediction held: all 13 refs content-addressed; a moved
  upstream tag can no longer change what executes in this repo's CI.
- **losses/exceptions:** the vendored `mcp-toolbox/.github/workflows/ci.yml`
  is NOT scanned — GitHub runs only root `.github/workflows/`, so the nested
  file is inert; scope stated in the test header. Reviewer P2 (wire into
  `test:ci`) and P3 (count 14→13) fixed in this iteration.
- **keep/revert:** keep.
- **next hypothesis:** candidate 2 (`gate`, kernel-purity executable) — the
  reviewer's own findings also suggest a `docs` follow-up (scope note shipped
  inline here).

Protocol: `docs/agents/rsi-loop-playbook.md` "Multi-iteration campaigns".
N = 3 (default; cap 5). Candidate set and appraisal recorded in the iteration-1
branch `w185/actions-sha-pin` (PR #472): (1) `security` SHA-pin actions,
(2) `gate` executable kernel purity, (3) `docs` worktree-convention
reconciliation. This branch is candidate 2.

## Iteration 2 (campaign n=2) — 2026-10-04

- **n:** 2
- **date:** 2026-10-04
- **pain point:** campaign candidacy 2 (`gate`).
- **selection:** highest-value unblocked candidate; previous iteration's tag was
  `security`, this one is `gate` (diversity brake satisfied). Tag: `gate`.
- **hypothesis (falsifiable):** `AGENTS.md` states the kernel layer
  (`src/kernel/`) "can never depend on a host surface" (no LLM, IO, UI, or SDK
  imports), but NO test enforces it. Every kernel import is relative today
  (`grep` of `src/kernel/**.ts` shows only `./contracts.js`, `./state-diff.js`),
  so a future `import { readFileSync } from "node:fs"` or an SDK import would
  pass lint, typecheck, and every focused suite silently, eroding the
  architectural invariant the repo's whole trust argument rests on. Predicted
  effect: an offline gate test that scans every `src/kernel/**.ts` module
  specifier and fails on any non-relative specifier.
- **at-risk regressions:** none to production code (test-only addition); the
  risk is a false positive if a legitimate relative-with-extension or a
  type-only import is misclassified.
- **accept/reject rule:** accept iff the gate passes on the clean tree; a
  mutation (injecting `import "node:fs"` into a kernel file) turns it RED with
  the offending file named; `npm run lint` + `npm run typecheck` exit 0.
- **non-goals:** no kernel source change; no runtime behavior change; no new
  layering beyond the documented purity rule.
- **trace evidence:** `find src/kernel -name "*.ts"` = 6 files
  (admission-gate, contracts, execution-log, invariants, state-diff,
  task-graph); all module specifiers = `./contracts.js`, `./state-diff.js`;
  `grep "import("`/`require(` = none.
- **preregistered:** before edit (this entry).

### Result — iteration 2 (campaign n=2)

- **change:** `test/kernel-purity.test.ts` added (1 gate); `package.json`
  `test:ci` gains the new suite (CI-enforced). No `src/` change.
- **commit:** (this branch `w186/kernel-purity-gate`).
- **evidence (external verifier):** clean run 1/1 pass; mutation (inject
  `import "node:fs"` as line 1 of `src/kernel/contracts.ts`) -> RED naming
  `src/kernel/contracts.ts: node:fs`; restored -> 1/1 pass.
  `npm run lint` exit 0; `npm run typecheck` exit 0; `test/contracts.test.ts`
  5/5 (regression sanity).
- **score:** gain. Prediction held: the kernel-purity rule is now executable;
  a future non-relative kernel import (IO/SDK) fails CI with the offending
  file and specifier named.
- **losses/exceptions:** none to production code. Coverage caveat (reviewer
  P2, closed in-round): the first cut allowed any relative specifier, so
  `../application/...` traversal to a host layer would have passed; the gate
  now resolves each specifier and requires it to stay inside `src/kernel/`.
  The remaining honest gap is *import-free ambient IO* (`fetch`, `process.env`,
  `Date.now`, `Math.random`), a different class needing a separate scan; the
  test's bounded claim says so.
- **keep/revert:** keep.
- **next hypothesis:** candidate 3 (`docs`) — reconcile the AGENTS.md worktree
  convention with the guard's workspace confinement.

N = 3 (default; cap 5). Candidate set and appraisal recorded in iteration 1
(`w185/actions-sha-pin`, PR #472); iteration 2 = `gate` (PR #473). This branch
is candidate 3.

## Iteration 3 (campaign n=3) — 2026-10-04

- **n:** 3
- **date:** 2026-10-04
- **pain point:** campaign candidacy 3 (`docs`).
- **selection:** last candidate; previous tag was `gate`, this one is `docs`
  (diversity brake satisfied). Tag: `docs`. Edit budget annealed (single file).
- **hypothesis (falsifiable):** `AGENTS.md` "Git / PR conventions" tells an
  agent to create worktrees at `/var/home/hunter/worktrees/<name>` and claims
  `.git/info/exclude` covers them, but the enforced guard confines mutations
  to the workspace root (`/var/home/hunter/Documents/projects/personal/Workflow`)
  and blocks any write/symlink outside it; this session tripped that block
  three times before discovering `.worktrees/` (inside the checkout) is the
  path `.git/info/exclude:13` actually covers. Predicted effect: after the doc
  points at the in-checkout `.worktrees/` path (and notes the guard boundary),
  an agent following it can create+use a worktree without a blocked mutation.
- **at-risk regressions:** none (docs-only); the risk is under-updating (leaving
  the old path implied) or over-editing unrelated guidance.
- **accept/reject rule:** accept iff the documented path is one the guard
  permits (inside the workspace root), `.git/info/exclude` actually covers it,
  and the surrounding conventions are unchanged except the worktree bullet.
- **non-goals:** no guard-policy change; no new workflow; no code.
- **trace evidence:** `.git/info/exclude:13` = `.worktrees/` (confirmed via
  `git check-ignore -v .worktrees/x`); `git check-ignore .campaign/x` exit 1
  (not ignored); the guard block message this session named the workspace root
  and rejected `/var/home/hunter/worktrees/w185-actions-pin/node_modules`.
- **preregistered:** before edit (this entry).

### Result — iteration 3 (campaign n=3)

- **change:** `AGENTS.md` "Git / PR conventions" worktree bullet — documents
  the in-checkout `.worktrees/<name>` path the guard permits and
  `.git/info/exclude` covers, and names the out-of-checkout path as blocked.
  Single file (annealed edit budget).
- **commit:** (this branch `w187/worktree-doc-reconcile`).
- **evidence:** `.git/info/exclude:13` = `.worktrees/` (via
  `git check-ignore -v .worktrees/x`); `git check-ignore .campaign/x` exit 1;
  the guard's own block message this session named the workspace-root
  confinement. Docs-only: `npm run lint` + `npm run typecheck` unaffected by a
  markdown edit (re-run for the record: exit 0).
- **score:** gain. Prediction held: the guide now points at a path the enforced
  policy allows, removing the three-block friction this campaign hit.
- **losses/exceptions:** docs-only; no executable pin (the guard is the
  enforcement, and prose is the right artifact for a convention). Cannot be
  fully "verified" beyond the check-ignore/info-exclude facts.
- **keep/revert:** keep.

## Campaign close-out (2026-10-04)

- **iterations:** 3 (N=3, cap 5), each one branch one PR, distinct
  change-types `security` -> `gate` -> `docs` (no diversity collapse; no
  no-gain streak).
- **PRs:** #472 (w185, security), #473 (w186, gate), campaign-3 PR (w187,
  docs) — all open for operator review.
- **stop reason:** N iterations done.
- **next hypothesis:** the `security` and `gate` candidates both landed a new
  CI-enforced pinch; the natural follow-on families are (a) `config` — a
  Dependabot/renovate lane so the SHA pins do not rot (explicitly a non-goal
  of #472), and (b) `gate` — extend the purity gate to the import-free ambient
  IO class (`fetch`/`process.env`/`Date.now`/`Math.random`) the kernel-purity
  test's bounded claim excludes.

---

# Campaign 2 — bounded multi-iteration RSI campaign (2026-10-04)

Protocol: `docs/agents/rsi-loop-playbook.md` "Multi-iteration campaigns";
citations by name + id per the campaign template. N = 3 (default; hard cap 5).
Feedback-fidelity / backbone-capability appraisal per HSI (2608.08466).

**Candidate set (built before iterating — AIDE² 2609.26457 diversity):**

1. `config` — **A Dependabot lane so the W185 SHA pins do not rot.** W185
   content-addressed every `uses:` (13 refs across ci/publish-image/update-deps)
   but nothing refreshes them; over time the pinned commits drift behind the
   mutable tags security wanted to leave. No `.github/dependabot.yml` exists
   (`git ls-tree origin/main` → empty). This was the campaign-1 close-out's
   explicit follow-on (a).
2. `docs` — **Backfill the `docs/ledger/` fragments for W178–W184.** W178,
   W180–W184 are merged/closed issues with no fragment; only `w179-pool-gate2.md`
   exists. TASKS.md's frozen-roadmap note claims "one write-once file per item"
   (137 fragments at 52aa74d); 6 landed items diverged. Docs-only; must not
   duplicate the issues' own records.
3. `gate` — **Extend kernel purity to the import-free ambient-IO class.**
   `src/kernel/**.ts` has zero `fetch`/`process.env`/`Date.now`/`Math.random`
   occurrences today (trace), but the W186 gate deliberately excludes these;
   a future `Date.now()` or `fetch()` in the kernel would pass CI silently.
   This was the campaign-1 close-out's explicit follow-on (b).

Appraisal: each has an informative, purely-offline signal (route check,
fragment-existence check, source scan) and asks nothing beyond the frozen
model's ceiling — no drop.

## Iteration 1 (campaign n=1) — 2026-10-04

- **n:** 1
- **date:** 2026-10-04
- **pain point:** campaign candidacy 1 (`config`) — the campaign-1 close-out
  follow-on (a).
- **selection:** highest-value unblocked candidate; no previous tag (first
  iteration). Tag: `config`.
- **hypothesis (falsifiable):** W185 made every workflow `uses:` an immutable
  commit SHA, but with no update automation the pins silently rot: the pinned
  commit is never advanced when upstream cuts a release, so this repo keeps
  running an ever-older action while `security` intent reads as "pinned = safe."
  Predicted effect: a `.github/dependabot.yml` with a `github-actions` update
  lane (weekly) makes Dependabot open a PR that advances the pinned SHA when
  upstream tags move, so the pin stays current without losing immutability; a
  `npm` lane keeps the same discipline for the runtime deps.
- **at-risk regressions:** (a) a Dependabot PR that *reverts* a pin to a
  mutable tag would defeat W185 — the W185 shape pin must stay the enforcement
  and must be checked against any such PR (Dependabot's github-actions updater
  rewrites the SHA, retaining the `# vX` comment; verify); (b) over-broad
  lanes (e.g. vendored `mcp-toolbox/**`) create noise; (c) the file must be
  valid YAML accepted by GitHub, or the lane is silently inert.
- **accept/reject rule:** accept iff the config is valid YAML, names only the
  root ecosystems (`github-actions` on `/`, `npm` on `/`), uses a bounded
  weekly schedule, and a parse check confirms the lane entries; reject if the
  lane targets the vendored subtree or the file fails to parse. No `src/`
  change; no workflow behavior change.
- **non-goals:** no action-version bumps themselves (Dependabot proposes those
  later); no renovate; no change to the W185 pin test; no auto-merge config.
- **trace evidence:** `grep -rn "uses:" .github/workflows/` = 13 refs, all
  40-hex-pinned; `git ls-tree -r origin/main --name-only | grep -iE
  'dependabot|renovate'` = empty; root ecosystems available: `github-actions`
  (native) + `npm` (package.json at root; lockfile present).
- **preregistered:** before edit (this entry).
- **result:** (filled on completion; append, never rewrite)

### Result — iteration 1 (campaign n=1)

- **change:** `.github/dependabot.yml` added (version 2; `github-actions`
  weekly on `/`, `npm` weekly on `/` with `open-pull-requests-limit: 5`);
  `test/dependabot-lane.test.ts` added (1 gate); `package.json` `test:ci` gains
  the suite (CI-enforced, not just present).
- **commit:** (this branch `w188/dependabot-lane`).
- **evidence (external verifier):** `node --import tsx --test
  test/dependabot-lane.test.ts` = 1/1 pass; mutations (drop the
  `github-actions` lane; remove the `updates:` key; drop the `schedule` block;
  retarget a lane to `mcp-toolbox/`) -> each RED with a distinct message;
  reorder (directory before package-ecosystem, a schema-legal YAML mapping
  order) -> GREEN; restored -> GREEN. `npm run lint` exit 0; `npm run
  typecheck` exit 0. The config parses under a real YAML parser
  (Python `yaml`), confirming the shape assertions sit on valid YAML.
- **score:** gain. Prediction held: the W185 SHA pins now have a lane that
  advances them when upstream releases, closing the "pinned but stale" gap
  the close-out named, without reintroducing mutable refs.
- **review (fresh-eyes, 4 rounds REQUEST_CHANGES x3 -> fixes -> ACCEPT at tip
  71949e64):** no P0/P1. Round 0 P2s fixed in-iteration: (1)
  the line-wise parser never required `updates:` or a `schedule` block, so the
  pin could stay GREEN over a config Dependabot would ignore — the test now
  asserts the top-level `updates:` list and a `schedule.interval` per entry;
  (2) the docstring overclaimed "YAML validity is asserted" — restated as
  structural shape only. P3s: the parser was document-order dependent (a legal
  reorder of `directory`/`package-ecosystem` mis-parsed) — rewritten to read
  each list block's keys independently of order; the "rewrites the SHA in
  place and retains the comment" claim in the config comment softened to
  "expected to", with the W185 shape pin named as the authoritative
  enforcement. Round 1 found the dead-lane class was still unguarded
  (`open-pull-requests-limit: 0`, `ignore`, `target-branch` all pass GREEN),
  the block-splitter truncated an entry at a nested list (a non-blanket
  `ignore:` before `schedule:` false-failed), and the interval allowlist was
  too narrow / unanchored. Round 2 showed the kill-switch checks enumerated
  SPELLINGS, not the property (single-quoted `'0'`/`'*'`, a trailing
  `# comment`, flow-style `ignore`, or a second entry all bypassed). The final
  (round-3) design matches on a NORMALIZED form and PARSED VALUES: full-line
  and inline comments stripped, quotes removed, keys read as `key : value`
  (whitespace before the colon tolerated), the limit tested numerically
  (`Number(value) === 0`, catching `'0'`/`00`/`+0`/`0x0`), the ignore glob
  tested as all-stars (`*`/`**`, block or flow), `target-branch` and group
  constructs rejected file-wide. Probe matrix (23 shapes): 17 bypass shapes RED
  with distinct messages, 6 legitimate shapes GREEN (quoted values,
  trailing/leading comments including one documenting `target-branch:`/
  `dependency-name: *`, a non-blanket nested `ignore:`, a scalar key reorder).
  `test:ci` wiring confirmed present via `node -e` on the parsed
  package.json. The npm lane is within scope (the preregistration above
  predicts it: "a `npm` lane keeps the same discipline for the runtime deps").
  Residual (honest, non-blocking, reviewer-accepted): a value on the NEXT line
  is not modeled; escape-encoded globs (`"\x2a"`) and YAML 1.1 exotic integers
  (`0_000`, sexagesimal) evade the parsed-value checks; `directory: ./` (a
  legal synonym for `/`) false-fails by deliberate strictness; the list-block
  boundary latches the file's first dash, so a future config with an earlier
  value-list would need the parser anchored to `updates:`. The docstring states
  the parser is not a YAML validator. Reviewer verdict: ACCEPT/APPROVE across
  test integrity, task completeness, cleanliness, security, platform fit.
- **losses/exceptions:** Dependabot's actual SHA-rewrite behavior (does it
  preserve the 40-hex shape and the `# vX` comment?) is GitHub-side and cannot
  be executed offline; the W185 pin test is the backstop that fails any
  regression, and this is stated rather than claimed as verified. Docs/ledger
  only; no `src/` change.
- **keep/revert:** keep.
- **next hypothesis:** candidate 2 (`docs`) — backfill the W178–W184
  `docs/ledger/` fragments; or candidate 3 (`gate`) — ambient-IO kernel purity.

## Iteration 2 (campaign n=2) — 2026-10-04

- **n:** 2
- **date:** 2026-10-04
- **pain point:** campaign candidacy 3 (`gate`) — the campaign-1 close-out
  follow-on (b).
- **selection:** previous iteration's tag was `config`, this one is `gate`
  (diversity brake satisfied). Tag: `gate`. Edit budget annealed (single test
  file).
- **hypothesis (falsifiable):** the W186 gate closes the kernel's
  *import-graph* half but its own docstring names the excluded class:
  import-free ambient IO (`fetch`/`process.env`/`Date.now`/`Math.random`). Today
  `src/kernel/**.ts` has zero such tokens even in comments (grep), so the gap is
  latent: a future `Date.now()` for a timestamp or a `process.env` read would
  pass lint, typecheck, and every focused suite silently, eroding the
  determinism the kernel's whole trust argument rests on. Predicted effect: an
  offline scan that strips comments/strings, then fails on any ambient-global
  reference (`Date`, `Math.random`, `fetch`, `process`, `require`, timers,
  `crypto`, `performance`, `globalThis`, host globals, `console`, `Buffer`) in
  `src/kernel/**.ts`, naming the file, line, and token.
- **at-risk regressions:** (a) false positives from `Date`/`Math` appearing as
  substrings (e.g. `update`, `Math.max`) — the scan is token-bounded
  (`\bDate\b`, `Math.random`) so `Math.max`/`Math.min` (pure) stay allowed;
  (b) a comment or string literal mentioning a token could false-trip — the
  scan strips comments and string/template contents first; (c) over-broad
  token selection flagging legitimate pure code.
- **accept/reject rule:** accept iff the scan is GREEN on the current tree and
  a mutation (inject `Date.now()` into a kernel file) turns it RED naming the
  file, line, and token; `npm run lint` + `npm run typecheck` exit 0. Reject if
  any false positive on the existing tree.
- **non-goals:** no kernel source change; no attempt to model every host global
  (the list is the documented high-value class, stated as such); no change to
  the W186 import gate.
- **trace evidence:** stripped-source scan over `src/kernel/**.ts` = 0 hits for
  the token set; the lone raw match is a comment (`task-graph.ts:161` "would
  require IO...") which comment-stripping removes; `Math` appears only as
  `Math.max`/`Math.min` in pure code (allowed by the token-bounded scan).
- **preregistered:** before edit (this entry).

### Result — iteration 2 (campaign n=2)

- **change:** `test/kernel-purity.test.ts` gains a second test, "src/kernel
  does not reach ambient host globals", plus a local `scanAmbient()` single-pass
  scanner (comments and string/template literal text blanked, newlines
  preserved, template `${...}` bodies RE-EMITTED as scannable). No `src/`
  change; the file was already wired into `test:ci` by W186.
- **commit:** (this branch `w189/kernel-ambient-purity`).
- **evidence (external verifier):** `node --import tsx --test
  test/kernel-purity.test.ts` = 2/2 pass. Probe matrix (25 shapes): 19 RED —
  `Date.now()`/`new Date()`, `Math.random()`, `fetch`, `process.env`,
  `require("x")`, `setTimeout`, `crypto`, `performance`, `globalThis`,
  `globalThis["fetch"]`, `console`, `Buffer`, `window`, `eval`, and the two
  regression probes the review forced (`${Date.now()}` template interpolation;
  a `http://` string before a `Date.now()`); 6 GREEN — comments (line/block),
  a string/template mentioning tokens, `Math.max`/`Math.min`, and the
  `update`/`procession` substrings. `npm run lint` exit 0; `npm run typecheck`
  exit 0; the three pin suites 5/5.
- **score:** gain. Prediction held: the ambient class the W186 docstring
  excludes is now executable, so kernel nondeterminism (a future `Date.now()`
  / `process.env` read) fails CI instead of passing silently.
- **review (fresh-eyes, rounds 0-3 REQUEST_CHANGES -> fixed; round 4 ACCEPT):**
  no P0. Round 0 P1: template `${...}` interpolation
  was blanked by the naive template regex, so `${Date.now()}` survived GREEN —
  a real vector in the named class; fixed with a scanner that re-emits
  interpolation bodies (regression probe added). Round 0 P2: comment-stripping
  ran before string stripping, so a `//` or `/*` inside a string could truncate
  the line and hide a later token; fixed. Round 1 then showed the interpolation
  handler was a naive brace counter: a `}` inside a string/comment/regex within
  `${...}` closed the body early and hid a following `Date.now()` (P1), and
  literal text inside `${...}` was re-emitted causing new false positives (P2);
  block-comment deletion could also fuse two identifiers past the `\b` anchors
  (`await/*c*/fetch()`). Fixed by rewriting `scanAmbient` as a recursive lexer:
  `${...}` bodies are lexed with full string/comment/escape state, and every
  blanked region emits a separator (space) so token boundaries survive; escaped
  newlines preserve line numbers. Round 2 found the remaining blocking item:
  regex-literal state is absent, so a `}` inside a regex in a `${...}` body
  closes the interpolation early and hides a following `Date.now()`. The
  reviewer allowed either implementing regex-literal state or narrowing the
  stated contract; chose the latter (a kernel regex lexer is over-engineering
  for a file with zero regex literals — verified, below) and first enumerated
  four regex-driven modes. Round 3 (P1) then showed a categorical enumeration is
  itself an overclaim (a quote or backtick inside a regex also opens the
  string/template branch and can hide code), so the count was dropped for the
  umbrella bound the reviewer confirmed accurate: the guarantee holds ONLY
  without regex literals; if one is added the scanner needs regex-literal state.
  The mutable-state claim ("the kernel has none today") was moved out of the
  test docstring to this ledger entry (round-3 P3).
  Probe matrix (26 shapes): 19 RED including the round-1 residuals
  (`${"}" + Date.now()}`, `${/* } */ Date.now()}`, a nested template inside
  `${}`, `await/*c*/fetch()`, `return/*c*/Date.now()`), 7 GREEN (comments,
  strings/templates mentioning tokens, a string arg `fmt("Date")` and a
  `/* Date */` inside `${}`, `Math.max`/`Math.min`, substrings).
- **losses/exceptions:** the token list is the named high-value class, not
  exhaustive; regex-literal state is absent, so the bounded claim is the
  umbrella bound only (a regex can false-trip or blank following code; the
  guarantee holds only without regex literals). Verified: `src/kernel` has zero
  regex literals (a tokenizing scan over the six files after stripping
  strings/comments matched none), so the residual is latent, not live. `Math`
  reached other than by a dot is also unmodelled. Round-3 P3 (accepted,
  out of scope): test 1's pre-existing `stripComments` is string-unaware, so a
  `//` or `/*` inside a string could in principle truncate a line before a
  specifier — a candidate for a future iteration, not this one. Offline and
  deterministic; no `src/` change.
- **keep/revert:** keep.
- **next hypothesis:** candidate 2 (`docs`) — backfill the W178–W184
  `docs/ledger/` fragments (the last remaining candidate; tag would be `docs`,
  distinct from `gate`).

## Iteration 3 (campaign n=3) — 2026-10-04

- **n:** 3
- **date:** 2026-10-04
- **pain point:** campaign candidacy 2 (`docs`) — the missing `docs/ledger/`
  fragments for the W178–W184 egress wave.
- **selection:** last candidate; previous tag was `gate`, this one is `docs`
  (diversity brake satisfied). Tag: `docs`. Edit budget: six write-once
  fragments plus one ledger entry.
- **hypothesis (falsifiable):** `origin/main` carries a `docs/ledger/` fragment
  for W179 (`w179-pool-gate2.md`) but none for W178 or W180–W184, so five-plus
  merged issues in the same wave (the egress policy/credential/approval/network
  work, #438 and #440–#443, plus the W184 activation wiring #457) have no
  durable write-once record; `git ls-tree origin/main docs/ledger/` shows the
  W001–W177 fragments and `w179` but nothing for W178/W180–W184. Predicted
  effect: after adding one fragment per gap, following the existing W-fragment
  convention (write-once, source/decision/verification/residual), every W-number
  in the W178–W184 wave resolves to a fragment, and the "activation-pending"
  drift W184's own ledger-era docs closed is recorded where a future session
  looks (the ledger).
- **at-risk regressions:** the fragments must NOT duplicate the issues' own
  records or invent source not in the repo; every claim is sourced to a landed
  file, test, or doc. The main hazard is doc drift (a fragment overclaiming
  `enforced`, or restating a superseded "activation-pending" status).
- **accept/reject rule:** accept iff each of W178, W180, W181, W182, W183, W184
  has a fragment, each fragment's Source/Decision/Verification lines resolve to a
  real `src/`, `test/`, or `docs/` artifact, and no new claim exceeds what the
  landed code and the W184 activation docs support.
- **non-goals:** no `src/`/test change; no new claim or status change; no
  rewrite of the existing W179 fragment; do not invent a W185/W186 fragment
  (those are the campaign-1 iterations, recorded in this ledger, not issues).
- **trace evidence:** `git ls-tree --name-only origin/main docs/ledger/` lists
  `w179-pool-gate2.md` but no `W178`/`W180`–`W184` file; the source-of-truth
  docs are `docs/EGRESS_CAPABILITY_AUDIT.md` (W178/W180/W181 §3b/§7),
  `docs/HUB_PROTOCOL.md` (W182 §egress routes, W183 token generation),
  `docs/HOST_ADAPTERS.md` + `THREAT_MODEL.md` (W183), and
  `docs/NVIDIA_ADOPTION_PLAN.md` (the wave table, PR #457 supersession); commit
  stats for the six W-commits (`5d528dbd`, `966bdb3f`, `fa7e70cc`, `1c207304`,
  `f737f3f3`, `a6c6b195`) name the exact files and tests.
- **preregistered:** before edit (this entry).

### Result — iteration 3 (campaign n=3)

- **change:** six write-once `docs/ledger/` fragments following the W179
  convention (`<!-- Write-once... -->` + `### Wxxx — title` +
  Source/Decision/Honest boundary/Verification) — `W178-egress-policy-ssrf-core.md`,
  `W180-proxy-function-allowlist.md`, `W181-egress-ledger-autofeed.md`,
  `W182-egress-deny-approval.md`, `W183-proxied-network-generation-tokens.md`,
  `W184-egress-activation-wiring.md`. No `src/` or test change.
- **commit:** PR #477 (this branch `w190/ledger-backfill`).
- **evidence (external verifier):** every `src/`, `test/`, and `mcp-toolbox/`
  path cited in the six fragments was checked to exist (20 tests + 14 src files,
  all present). Focused suites: `test/egress-policy.test.ts`,
  `test/egress-policy-revisions.test.ts`, `test/egress-policy-file.test.ts`,
  `test/hub-egress-approvals.test.ts`, `test/hub-tokens.test.ts`,
  `test/egress-forward-proxy.test.ts`, `test/egress-binding.test.ts`,
  `test/egress-audit-client.test.ts`, `test/runtime-context.test.ts`,
  `test/opencode-server-egress-wiring.test.ts`, `test/text-hygiene.test.ts` =
  89 tests, 88 pass, 0 fail (1 skipped: the env-gated `WORKFLOW_ACP_CONTAINED_EGRESS`
  probe). `npm run lint` exit 0; `npm run typecheck` exit 0.
- **score:** gain. Prediction held: `origin/main` had a fragment for W179 but
  none for W178/W180–W184; after this change every W-number in the W178–W184
  wave resolves to a fragment. The W183 fragment states the "activation-pending"
  posture and carries the explicit supersession pointer to W184, so the drift
  W184's docs closed is recorded where a future session looks.
- **losses/exceptions:** docs-only; cannot be "verified" beyond the source-path
  existence check and the suites staying green. The fragments restate what the
  landed code and the existing audit/hub/threat docs already claim — they add
  no new claim and no enforcement status. No fragment is created for W185/W186
  (campaign-1 iterations, recorded in this ledger, not issues).
- **keep/revert:** keep.

## Campaign close-out (campaign 2, 2026-10-04)

- **iterations:** 3 (N=3, cap 5), each one branch one PR, change-types
  `config` -> `gate` -> `docs` (no diversity collapse; no no-gain streak).
- **PRs:** #475 (w188, `config` — Dependabot lane), #476 (w189, `gate` —
  ambient-host-global kernel purity, stacked on #475), #477 (w190, `docs` —
  W178–W184 fragment backfill, stacked on w189). Merge order: #475 -> #476 -> #477.
- **stop reason:** N iterations done.
- **next hypothesis:** the campaign's three chosen families are now spent. The
  open candidate classes: (a) route test 1's `stripComments` through the W189
  lexer (round-3 P3 on iteration 2 — make the import gate string-aware); (b) a
  `config`/`gate` follow-on that pins the Dependabot lane's shape against the
  W185 SHA-pin gate on a schedule; (c) the base-loop selection exhaustion noted
  in campaign 1 — the remaining open issues are parked P20–P24 or human-gated
  (W149 #142, W179 #439 already merged).



---

# Campaign 3 — bounded multi-iteration RSI campaign (2026-10-06)

Protocol: `docs/agents/rsi-loop-playbook.md` "Multi-iteration campaigns";
reading-list citations per the campaign template. N = 3 (default; hard cap 5).
Base `origin/main@a326cfa7` (PR #488 merge). Each iteration: one branch, one PR.

**Candidate set (built before iterating — AIDE² 2609.26457 diversity):**

1. `gate` — **Make the import gate's comment stripping string-aware.** The
   W186 import gate blanks comments with a regex `stripComments`
   (`source.replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/[^\n]*/g,"")`) that
   ignores string context, so a `//` or `/*` inside a string/template blanks
   the rest of the line — potentially hiding a real `import` specifier. The
   W189 ambient gate already solved this with a lexer; the import gate should
   route through the same lexer. This is campaign-2 close-out next-hypothesis
   (a) and a round-3 P3 on W189.
2. `docs` — **Backfill the missing ledger fragments** for any W-item lands
   without one (candidate (c)-adjacent, docs-only).
3. `config`/`gate` — **Pin the Dependabot lane shape against the W185 SHA-pin
   gate on a schedule** (campaign-2 next-hypothesis (b)).

**Appraisal (HSI 2608.08466 two bounds):** candidate 1 has an informative
offline signal (a synthetic input that the old stripper mis-handles) and is
within the frozen model's ceiling; candidates 2/3 depend on new lands or are
already partly covered (W188's own test pins the lane). Candidate 1 picked.

## Iteration 1 (campaign n=1) — 2026-10-06

- **n:** 1
- **date:** 2026-10-06
- **pain point:** kernel-purity gate truthfulness. Change-type: `gate`.
- **selection:** highest-value unblocked candidate (campaign-2 follow-on (a));
  no previous tag (first iteration).
- **hypothesis (falsifiable):** the W186 import gate's regex `stripComments`
  can hide a real import violation whose specifier sits on the same line after
  a string containing `//` (or after a block-comment marker inside a string),
  because the regex blanks from the `//` to end-of-line regardless of string
  context. Predicted effect: after routing the import gate through the W189
  lexer (`blankComments` = `lexBlank(source, false)`, strings preserved,
  comment markers inside strings not treated as comments), a `node:fs` import
  placed after a `//`-bearing string is detected; pre-change it is missed.
- **at-risk regressions:** (a) the import gate would false-report a comment
  mentioning an import (must still strip real comments); (b) the ambient gate
  would change behavior (the lexer is shared); (c) blanked regions must keep
  emitting newlines so line numbers stay exact.
- **accept/reject rule:** accept iff (i) the shared lexer passes the current
  kernel (both gates green), (ii) a mutation restoring the old regex makes a
  new string-awareness pin RED, (iii) a hidden-in-string `node:fs` import is
  RED under the lexer and GREEN (undetected) under the old regex, (iv) ambient
  tokens only inside string literals do NOT trip the ambient gate and a real
  `Date.now()` still does, and (v) lint + typecheck exit 0.
- **non-goals:** no `src/` change; no new ambient token names; no regex-literal
  modelling (documented bounded claim retained on the shared lexer).
- **trace evidence:** `test/kernel-purity.test.ts:42-44` (old
  `stripComments`); the W189 `scanAmbient` lexer at `:132-231`; no `//` or `/*`
  occurs inside a string/template in the three current `src/kernel/` modules
  (author scan), so no live kernel input exercises the gap — the pin is the
  only regression witness.
- **preregistered:** before edit (this entry).

### Result — iteration 1 (campaign n=1)

- **change:** `test/kernel-purity.test.ts` — the W189 lexer is factored into one
  shared `lexBlank(source, blankStrings)`; `blankComments(source)` =
  `lexBlank(source, false)` (comments only, strings preserved) feeds the import
  gate; `scanAmbient(source)` = `lexBlank(source, true)` keeps the ambient
  gate's behavior; the dead regex `stripComments` is removed. One new pin:
  "the import gate is string-aware (a // inside a string is not a comment)".
  Test-only; no `src/` change.
- **commit:** uncommitted on branch `w191/kernel-purity-lexer` at record time.
- **artifact name + checksum:** `test/kernel-purity.test.ts` — sha256 (see git
  blob of the commit).
- **exact command/config:** `node --import tsx --test test/kernel-purity.test.ts`;
  `npm run lint`; `npm run typecheck`.
- **test results:** focused 3/3 pass. Mutation evidence (orchestrator-executed,
  worktree): (A) restoring the old regex `stripComments` as `blankComments`
  makes the new pin RED (tests 2/3); (B) with a synthetic
  `src/kernel/.probe-gen.ts` containing `const u="a//b"; import {x} from
  "node:fs";`, the lexer REDs the import gate naming `node:fs`, while the old
  regex leaves the import gate GREEN (the violation is hidden) — the
  discriminating pair; (C) a probe whose only ambient tokens (`Date`,`fetch`,
  …) live inside string/template literals stays GREEN, and appending a real
  `Date.now()` REDs the ambient gate. `npm run lint` exit 0; `npm run typecheck`
  exit 0.
- **score:** gain. Prediction held: the old stripper hides a specifier on the
  same line after a `//`-bearing string; the shared lexer finds it without
  false-reporting a genuine comment.
- **losses/exceptions:** the reviewer subagent in this session had no shell, so
  it verified the refactor by reading + symbolic trace rather than execution;
  the orchestrator supplied the executed mutation evidence it could not. The
  refactor is behavior-neutral on the current kernel (no string contains a
  comment marker), so the change's value is future-proofing the gate, not a
  live defect fix — an honest characterization, not a claimed current bug.
- **keep/revert:** keep (review APPROVE, five axes, reviewer-w191-r1,
  fingerprint 2b581a37b1fe, bound a326cfa7ec6c).
- **next hypothesis:** the import gate still preserves string LITERALS
  verbatim, so a string whose DATA contains `from "node:x"` would false-trip it
  (conservative direction, pre-existing). Candidate (b) for iteration 2: not
  landable until a new W-item appears; the Dependabot shape is already pinned by
  W188. If no distinct-tag candidate remains, stop early per the diversity
  brake.




