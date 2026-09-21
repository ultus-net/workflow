---
description: Run one manual base-loop iteration of the RSI playbook (propose → predict → … → remember)
subagent: false
---

Run ONE base-loop iteration for this pain point: $ARGUMENTS

Read `docs/agents/rsi-loop-playbook.md` first if it exists in this repo.

Protocol:

1. **PROPOSE** — pick one minimal candidate change. Read the actual code
   first; cite the files you read in the proposal.
2. **PREDICT** — before editing, register a falsifiable claim: expected
   effect on the metric, how it will be verified, and at-risk regressions.
3. **IMPLEMENT** — delegate mechanical work to the `executor` subagent with
   a full spec (inputs, constraints, acceptance command). Keep the diff
   minimal. Judgment-heavy edits you do yourself, stating why they were
   strong-only.
4. **EVALUATE** — run the external verifier (tests / benchmark / harness).
   Self-review is not evidence. Store or cite the run output.
5. **SELECT** — delegate a fresh-eyes check to the `reviewer` subagent.
   Accept only if the prediction was verified with no held-out regression.
   Otherwise archive the attempt with its failure evidence — never discard
   it silently.
6. **REMEMBER** — append an itemized lesson (id, evidence, one bullet) to
   `docs/agents/lessons.md` per the `retrospective` rules, either way.

Hard rules: never edit tests to make them pass; never edit the verifier,
baselines, or run logs; a negative result is a valid result — log it as a
lesson and stop after this one iteration.
