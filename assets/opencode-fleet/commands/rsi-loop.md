---
description: Run one manual base-loop iteration of the RSI playbook (propose → predict → … → remember)
subagent: false
---

Run ONE base-loop iteration for this pain point: $ARGUMENTS

Step 0 — ensure scaffolding (do this first, before PROPOSE). The loop depends
on three artifacts in this repo; a missing one means the loop has no grounding
and nowhere to write. For each path below, if it does not exist, create it by
copying the matching template from `~/.config/opencode/templates/rsi/`:

- `docs/agents/rsi-loop-playbook.md` ← `rsi-loop-playbook.md`
- `docs/agents/ledger.md` ← `ledger.md`
- `docs/agents/lessons.md` ← `lessons.md` (and create the `docs/agents/lessons/`
  directory)

If a required file is missing and cannot be created, stop and report — do not
run a crippled iteration that writes nowhere.

Then read `docs/agents/rsi-loop-playbook.md`.

Protocol:

1. **PROPOSE** — pick one minimal candidate change. Read the actual code
   first; cite the files you read in the proposal.
2. **PREDICT** — before editing, register a falsifiable claim: expected
   effect on the metric, how it will be verified, and at-risk regressions.
3. **IMPLEMENT** — delegate mechanical work to the `executor` subagent with
   a full spec (inputs, constraints, acceptance command). Keep the diff
   minimal. Start each subtask on the cheap tier and escalate on an
   observable trigger (two failed acceptance runs, a repeated error loop, or
   half the subtask's step cap burned with no accepted edit) by re-dispatching
   the same spec, with the failed attempt and its acceptance output, to the
   `executor-strong` twin; do not
   guess the tier up front. Judgment-heavy
   edits you do yourself, stating why they were strong-only. On each accepted
   change, note whether the benefit was measured on the *target* tier, not
   just the strong model.
4. **EVALUATE** — run the external verifier (tests / benchmark / harness)
   only; self-review is not evidence. Score candidates on *behavior-relevant*
   tasks behind an attributable-evidence gate, not the whole suite every
   time. Escalate in confidence stages (A) synthetic reproduction, (B) a
   preregistered, frozen diagnostic subset chosen before the first edit and
   never tuned afterward, (C) the full evaluation, (D) repeat the unchanged
   candidate at least three times, (E) the leaderboard-compatible protocol if
   one exists; change one causal axis per iteration. Before crediting a harness
   edit, run a matched-budget test-time-scaling control (2607.12227, 2609.40303)
   and an answer-rescue/eval-defect audit (2610.05533), and report the selection
   score and the held-out score side by side — held-out items never reused for
   selection (2610.09239). Store or cite the run
   output.
5. **SELECT** — regularize the selection: anneal the edit budget (fewer
   bundled edits as rounds progress), run a *critic* that screens proposals
   encoding benchmark specifics (task names, hardcoded answers, raised
   timeouts/resources), and a *pruner* that drops edits that are too small,
   too expensive, or stale. Advance the incumbent only on a minimum effect
   size or strong paired task-level evidence, and only if the change is
   defensible without naming the benchmark it was measured on. Delegate a
   fresh-eyes check to the `reviewer` subagent. Otherwise archive the attempt
   with its failure evidence — never discard it silently.
6. **REMEMBER** — write one lesson file under `docs/agents/lessons/`
   (timestamp id, evidence, one bullet) per the `retrospective` rules,
   either way, but only after the admission gate (does the cited evidence
   actually support the claim?). Extraction must preserve applicability
   conditions: a stripped scope condition fails admission even when the
   experience was verified successful (SkillPoison, 2610.07645). Draw lessons
   only from the current harness — foreign-scaffold traces are
   out-of-distribution (CoTrace, 2610.10426). Append one structured record for
   this
   iteration to `docs/agents/ledger.md` (create-only, reproducible schema).

Hard rules: never edit tests to make them pass; never edit the verifier,
baselines, or run logs; a negative result is a valid result — log it as a
lesson and stop after this one iteration.
