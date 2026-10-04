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
