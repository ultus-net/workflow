# Prompt Design — Asking an LLM to Design Something for a Specific Repo

> Craft notes for turning "design me X" prompts into prompts that produce
> buildable designs. Worked example: self-improvement loops
> (`rsi-loop-playbook.md`).

## Why generic prompts fail

"Design me a self-improving system" produces a plausible essay:

- **No grounding.** The model invents your CI, test runner, and pain points.
- **No metric.** "Better" is unfalsifiable, so no iteration can actually fail.
- **No constraints.** Nothing stops the design from gaming its own evaluator.
- **No deliverable spec.** You get prose instead of an executable checklist.
- **No license to ask.** The model fills gaps with confident guesses instead
  of clarifying questions.

## The five moves

1. **Ground it.** Real repo facts only: stack, build/test commands, CI
   latency, directory map, pain points, backlog items. Best: run the prompt
   inside an agentic CLI at the repo root so it reads files itself.
2. **Pick ONE metric.** A loop needs a falsifiable signal. Two metrics means
   the loop will trade them against each other; pick one and demote the
   other to a regression guard ("coverage may not cost CI time").
3. **State the honesty constraints.** What may never happen: editing tests
   to pass, editing the evaluator, declaring success without an eval run.
4. **Specify deliverables as artifacts.** A diagram, an executable
   checklist, a verifier spec, a failure-mode table, one runnable first
   experiment.
5. **Force clarification first.** "If anything you need is missing, ask up
   to 3 questions before designing."

## Worked example: evolution of the RSI-loop prompt

### v1 — first draft (2026-09-21)

Faithful to the first version produced in conversation:

```text
You are a senior engineer designing a recursive self-improvement loop (RSIL)
for the repository described below. The loop must make the repo measurably
better on every iteration, with humans only at defined approval gates.

## Repository context
- Stack / build / test commands / CI / key dirs / pain points: <real facts>
- THE metric (single, measurable): <one metric>

## Required loop phases
1. Propose    — 1–3 candidates from backlog + last iteration's lessons.
2. Predict    — expected metric delta + how verified, BEFORE coding.
3. Implement  — minimal diff, in a branch/worktree.
4. Evaluate   — run the eval harness, compare to stored baseline.
5. Select     — accept only if prediction was verified; else record a lesson.
6. Integrate  — merge, append lessons to LESSONS.md, derive next backlog items.

## Hard constraints
- Eval harness and metric definitions frozen for N iterations; changing them
  is a separate human-reviewed PR.
- Never modify tests to make them pass. Failures are data, not obstacles.
- Every accepted change must cite the eval run that justified it.
- Budget: max iterations, max eval minutes, automatic rollback on regression.
- Human gates: auth/, migrations, dependency bumps, eval changes.

## Deliverables
1. Mermaid diagram of the loop and its hooks into THIS repo.
2. Iteration protocol: numbered, executable, zero-ambiguity checklist.
3. Eval harness spec: what runs, baseline storage, pass/fail rule, thresholds.
4. Failure-mode table for THIS repo with concrete mitigations.
5. First experiment: the exact first iteration — runnable today.
6. Ask up to 3 clarifying questions BEFORE designing if details are missing.
```

### v2 — what the literature changed

After working through the awesome-rsi taxonomy and its cited papers
(`reading-list.md`):

| v1 | Problem | v2 fix | Source |
|---|---|---|---|
| "recursive" used loosely | the loop improved the repo, not the improver — persistent improvement, not RSI | explicit level declaration + two-timescale loop; meta loop gated by a capability check | awesome-rsi terminology; STOP (2310.02304) |
| eval harness "frozen" | right instinct, crude mechanism — froze everything forever | bounded editable surface instead: agent MAY edit prompts/skills/code; verifier, baselines, run logs, model config are READ-ONLY | AHE (2604.25850) |
| "run the eval harness" | intrinsic self-critique could pass as verification | external verifier only; self-review explicitly is not evidence | Huang et al. (2310.01798) |
| single lineage | rejected attempts discarded; negative lessons lost | archive attempts + failure evidence; negative results preserved | DGM (2505.22954); Weng 2026 |
| `LESSONS.md` append | wholesale rewrites cause context collapse and brevity bias | itemized, id'd, append-mostly bullets; periodic dedupe | ACE (2510.04618) |
| predict-before-implement | strongest v1 idea — kept | strengthened: every edit = falsifiable claim incl. at-risk regressions | AHE decision observability |
| 5 generic failure modes | missed documented LLM-researcher failure modes | + over-optimism, implementation drift, stale defaults, diversity collapse, goal drift | Trehan & Chopra (2601.03315); Weng 2026 |
| no capability check | recursion with a weak improver degrades the system | meta loop enabled only after the base loop proves reliable | STOP cautionary result |
| single model assumed | expensive model doing mechanical work | implement phase routable to cheap models per `task-decomposition.md` | strong-to-weak transfer (2608.12307) |

The full v2 template lives in `rsi-loop-playbook.md`.

## Review checklist for any LLM-produced design

Run the design back through these before building it:

1. **Level check** — does it claim recursion it isn't building? What persists?
2. **Ruler check** — who computes the score, and can the loop edit them?
   The verifier must be read-only to the loop.
3. **Prediction check** — is every change a falsifiable claim made before
   implementation?
4. **Memory check** — will lessons survive 50 iterations without collapsing
   into vague summaries?
5. **Failure check** — concrete, repo-specific failure modes with
   mitigations?
6. **First-step check** — a first experiment small enough to run today?
   Without one, the design is vaporware.
7. **Gate check** — human gates at real risk points (auth, migrations,
   eval), not everywhere (unusable) or nowhere (unsafe).
8. **Cost check** — which steps route to cheap models, and what verification
   stops cheap-output errors from merging?
