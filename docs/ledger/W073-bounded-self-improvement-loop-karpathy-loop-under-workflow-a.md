<!-- Ledger fragment: extracted from TASKS.md at line 1094 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W073 - Bounded self-improvement loop (Karpathy loop) under Workflow authority

**Objective:** Implement the propose → apply → test → evaluate → commit/discard
loop described by the operator's two cited sources (MindStudio's "Karpathy
Loop" explainer; Anthropic's "When AI builds itself") as a deterministic
integration-layer orchestrator that routes every candidate through the
canonical run lifecycle, so nothing is committed unless the kernel reached
`VERIFIED` on fresh evidence. The loop is workspace-parameterized, so the same
control-plane capability can later be pointed at other repositories.

**Spec:** `docs/superpowers/plans/2026-09-19-recursive-self-improvement-loop.md`.
**Module:** `src/integrations/self-improvement-loop.ts` (loop, git candidate
workspace, `createAuthorityGate`).

**Depends on:** the run registry / run-lifecycle gates (W038–W042 area) and
the hub reviewer + test runner wiring (`hub-run-gates.ts`). No kernel change.

**Acceptance criteria:**
- [x] A candidate is committed only after `finish("verified")` resolves; every
      rejection path closes the run `failed` and discards the workspace.
- [x] An authority-begin refusal, a malformed proposal, or a proposal-source
      failure stops the loop without mutating (fail closed).
- [x] The loop is single-instance per workspace; a second concurrent run for
      the same workspace is refused.
- [x] Bounds stop the loop deterministically: `maxIterations`,
      `maxConsecutiveRejections`, and an optional cost budget.
- [x] The objective is validated up front (absolute workspace, non-empty
      description, positive integer iteration cap, valid direction/budget).
- [x] A verified-but-uncommittable candidate is audited and stops the loop,
      reporting it uncommitted — never as committed.
- [x] The git candidate workspace detects a change, commits it, and
      destructively discards uncommitted work in a dedicated checkout.
- [x] An integration test composes the real `createRunRegistry` (reviewer +
      test runner) and proves an accepted candidate's run reaches `VERIFIED`
      on recorded reviewer + environment evidence, while a rejected
      candidate's run ends `FAILED` and its change is discarded.
- [x] `npm run lint`, `npm run typecheck`, and the focused test file pass.

**Verification:** `test/self-improvement-loop.test.ts` (21 tests: hermetic
bounds/fail-closed coverage, the registry-composition acceptance path, and
real-git workspace coverage); `npm run lint`; `npm run typecheck`; the recorded
five-axis review.

**Status (2026-09-19, implemented on `feat/w073-self-improvement-loop`):** the
loop, git candidate workspace, and authority adapter landed with the focused
suite green (27 tests: hermetic bounds/fail-closed coverage, the
registry-composition acceptance path, and real-git workspace coverage), lint
and typecheck clean. **Independent five-axis review:** `[REQUEST_CHANGES]`
(2×P2, 5×P3); both P2s fixed and pinned by test — a failed rollback (run close
or discard) is now surfaced on the iteration record and **stops the loop**
instead of continuing over an unsafe tree — and the P3s are fixed
(best-effort commit ref, realpath-keyed single-instance lock, guarded
`usageUsd`/`onIteration`) or recorded as residuals (`git add -A` dirt,
iteration-boundary budget) in the plan's review record. **Re-review:**
`[REQUEST_CHANGES]` on one P2 regression from the fix round (the lock acquired
the realpath key but released the raw path, leaking the lock under path
aliases); fixed and pinned by a symlink-alias symmetry test, with the
remaining new branches pinned too. **Residuals (recorded,
not buried):** the production agent applier and `measure` are composition-time
seams — this item ships the orchestrator and git workspace, not a new agent
runtime; the git command runner runs outside Bubblewrap in this first slice
(hub-side action on a dedicated workspace, not an agent tool call); proposals
are not yet sourced from a live model. A final re-review verdict is recorded
before merge.

**Trigger / monitor / cancel surface (2026-09-19, operator-directed):** the
operator chose the hub-owned **registry + admin CLI + hub API** path with
boundary-scoped cancel. Landed: the loop's cooperative `shouldStop` hook
(checked only at iteration boundaries; a throwing predicate fails closed); the
hub-owned `self-improvement-registry.ts` (`start`/`status`/`cancel`, validated
specs, realpath duplicate refusal, bounded history); the hub routes
`POST /rsi/start|status|cancel` (`hub-http.ts` + `workflow-hub.ts`; 404 when
unconfigured); and the `workflow-rsi` CLI client (`src/cli/rsi.ts`, bin added).

**Adversarial-review round (2026-09-19, operator-directed):** an independent
adversarial reviewer with its own primary-source research returned
`[REQUEST_CHANGES]` (2×P0, 2×P1) and all four blockers were fixed and pinned:
a **clean-baseline precheck** (`CandidateWorkspace.assertBaseline`; refuses a
dirty tree or non-repo, so the destructive discard can only revert the loop's
own candidate changes); **`requiresReview` defaults to true** at `/rsi/start`
with explicit opt-out (`requiresReview:false` / `--no-review`; the vacuous
evidence-free default path is closed); **`/rsi/start` and `/schedule/run-now`
require the verifier credential** (the same trust model as `/run/finish`) with
the CLI reading `verifier.json`; and the reviewer's run ask is the
**operator-authored objective**, never the candidate's hypothesis.
`THREAT_MODEL.md` (2026-09-19 §1–6) records the residuals honestly — notably
that the boundary is credential-scoped, not process-scoped (a same-UID process
that can read `verifier.json` can start a loop), and that reviewer
independence carries a prompt-injection residual through candidate-authored
diffs. Focused suites: loop 32, registry 8, hub API 5, schedule manager 10, CLI
parse 6 — all green; lint and typecheck clean. The production `LoopRunner`
(live proposal source + agent applier + measure) remains a composition-time
seam; `cli/hub.ts` now composes the registry with a fail-closed runner until
Checkpoint F lands it.
