# Base-loop experiment ledger (create-only, append-only)

One structured record per base-loop iteration. This file did not exist when the
loop started (the repo's durable memory is `docs/agents/lessons.md`, a
monolithic append-only file); this ledger was created at iteration LESS-0067 to
carry the reproducibility schema below, which this iteration adopted on its own
initiative — the RSI-lite playbook names only `docs/agents/lessons.md` and does
not define this file or its schema. Never rewrite an existing record; append
supersession notes to a record's tail instead.

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
