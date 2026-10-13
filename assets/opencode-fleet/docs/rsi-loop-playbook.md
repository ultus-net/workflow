# RSI Loop Playbook

> Prompt template for designing a persistent, optionally recursive
> self-improvement loop inside a specific software repo. v2 — refined
> against the awesome-rsi literature (`reading-list.md`).

## Design status (re-checked 2026-10-12)

A third literature sweep (MASS's author group and the October arXiv listing;
every id below re-checked against its primary source in `reading-list.md`).
**The design below is still current**, but five results now sharpen or gate
mechanisms the template only implied. Earlier status line (2026-10-02) held
that the evidence only reinforced the seven mechanisms; that pass under-sampled
the negative-results cluster and did not measure the winner's curse.

- **The winner's curse is now measured.** Greedy keep-if-better on 16 selection
  items inflates reported gains 13-20 points over held-out; tested acceptance
  rules don't beat greedy; a 64 never-used item set debiases the average
  (2610.09239). → report selection AND held-out scores side by side.
- **The harness is the only mutable surface that stays reviewable.** A
  hash-chained admission gate admitted 144/7449 candidates with no held-out
  regressions; the ungated loop admitted 309 harmful changes (2610.10629). →
  every self-edit is a named diff + gate + audit record.
- **Failure composition chooses the lever.** Label failed trajectories by the
  first signal that fires: process failures (blocked calls, loops, exhausted
  step budgets) are harness-fixable then trainable; content failures (a poor
  delivered plan) are for weight training. A placebo adapter on answer-shuffled
  traces falls below base (2610.11655).
- **MASS makes role generalization concrete, and names the risk.** One model as
  executor+optimizer+evaluator; training only on task-solving also improves
  optimizer and evaluator (agreement 0.73→0.93); the optimizer, not the
  evaluator, is the bottleneck; the shared blind spot is the RSI Achilles heel;
  absolute scores fall out-of-distribution (2610.12176).
- **Three negative results are now controls, not caveats.** Under matched
  budgets, harness evolution does not consistently beat simple test-time
  scaling and generalizes poorly (2607.12227); SOTA harnesses show no advantage
  over a minimal-harness single session on MLE tasks (2609.40303); harness
  "gains" often come from unreadable-answer rescue, weak baselines, or eval
  defects (2610.05533). → a matched-budget scaling control and an
  answer-rescue/eval-defect audit gate any claim scored by a model. A
  deterministic verifier fixes compute per item, so record that and skip both.

## Design status (re-checked 2026-10-02; superseded by 2026-10-12)

Literature pass (Anthropic, OpenAI, NVIDIA, DeepSeek, Cline practitioner posts,
plus primary papers). **The design below is still current**, but a second,
less-anchored sweep found one mechanism that needed correcting and three
refinements; a follow-up sweep added four Evaluate mechanisms from the
eval-focused arafatkatze RSI prompt. Earlier status line (2026-10-01) claimed
the evidence only reinforced the seven mechanisms; that first pass was
partially anchored to the topics already in `reading-list.md` and missed the
2607-2608 harness-RSI wave.

- **The ruler rule is the whole game.** The ICLR 2026 reward-hacking study
  (`ikrQWGgxYg`) found 74% / 47% of self-declared "optimizations" improved a
  cheap proxy without improving the true objective. Keep the verifier,
  baselines, and model config read-only.
- **Genuine recursion now has a clean datapoint, and a warning.** AIDE²
  (2609.26457) ran the propose→benchmark→keep-winners loop on its own code for
  8 days (gains transferred to four held-out benchmarks). Three mechanisms are
  directly copyable: decouple the signal the loop optimizes (public) from the
  signal used to select (private held-out) — the read-only ruler in code; grade
  every candidate under a fixed per-task budget so a gain is a better algorithm,
  not more compute; and build the selection set for diversity so pressure
  favors general mechanisms. The warning is the **ignition test**: the
  self-improved agent was *not* decisively better at driving the outer loop
  than the human agent (3 seeds, 0.780 vs 0.782, inconclusive), and AIDE²
  cannot distinguish itself in that role due to compounding noise. This is
  direct evidence for why the meta loop stays gated: improving the *task*
  worked; improving the *improver* is unproven.
- **Correction — memory admission, not dedupe.** "When Self-Evolution
  Backfires" (2608.05810) shows skill/lesson accumulation is non-monotonic and
  that a defective entry contaminates everything distilled after it, so
  post-hoc rollback recovers little. Remember now gates admission *before*
  writing; dedupe only clears clutter.
- **Refinement — regularized Select.** RRSI (2609.24972) shows unregularized
  harness evolution overfits (14.1 in-distribution vs 4.7 out-of-distribution);
  Select now anneals the edit budget and runs a critic + pruner.
- **Refinement — behavior-aware Evaluate.** HarnessLens (2608.27311) scores
  candidates on behavior-relevant tasks behind an attributable-evidence gate,
  not the whole suite every time.
- **Two-time-scale is independently validated.** MetaSkill-Evolve (2607.05297)
  reaches the same task-skill/meta-skill split this template designs.
- **Confidence gating has a published protocol.** The Cline Kimi-K3 prompt
  (`KimiK3_HillClimb_Prompt.md`) is a real recursive-harness campaign that
  operationalizes the discipline the template only implies: a preregistered
  frozen diagnostic subset, one causal axis per iteration, an A-E evaluation
  ladder, a minimum-effect-size + repeated-confirmation advancement rule, and
  a structured experiment ledger. See "Benchmark-defensibility and confidence
  gates" below.
- **Cost routing got a mechanical upgrade.** NVIDIA NeMo Switchyard (2026-08)
  gives a concrete escalation/stage-routing policy to replace "route
  mechanical work to cheap models" hand-waving — see the Cost plan below.

### Benchmark-defensibility and confidence gates

Cline's Kimi-K3 prompt is the clearest published treatment of the discipline
this template implies but did not spell out; the eval-focused arafatkatze
prompt (2026-07-27) adds four more. Together these spell out the following
Evaluate/Select additions:

- **Benchmark-defensibility gate (admission test).** A retained change must be
  defensible without naming the benchmark it was measured on. The Cline prompt
  bans, explicitly: modifying the verifier/dataset/tests/rewards; reading
  hidden tests for task-specific behavior; task-name checks or benchmark
  detection; hardcoded answers; task-specific system-prompt text; increasing
  timeouts/CPUs/memory/attempts; excluding or selectively rerunning failed
  tasks; and reporting the luckiest run. A change that needs any of these is
  rejected regardless of score.
- **Confidence ladder and advancement rule.** Escalate verification in stages:
  (A) synthetic reproduction, (B) a *preregistered, frozen* diagnostic subset
  chosen before the first edit and never tuned afterward, (C) the full
  evaluation, (D) repeat the unchanged candidate at least three times, (E) the
  leaderboard-compatible protocol if one exists. Advance the incumbent only if
  the full run completes, it beats the incumbent by a **minimum effect size**
  (Cline uses ≥3 tasks) or has strong paired task-level evidence, and the gain
  is not explained by infrastructure or resource changes. "Do not stop at
  70/89 merely because it is technically higher."
- **Single-axis discipline.** Change one causal axis per iteration wherever
  practical; if a necessary stack improves, ablate its components afterward.
  This is the concrete form of the Predict/attribution rule when a benchmark
  is the verifier.
- **Quantify the noise before promoting.** Run repeated baselines when
  affordable; a small score movement may be sampling variance, provider
  instability, verifier flakiness, or a transient outage. Do not promote a
  change from one lucky run. Record score ranges, task flips, exceptions,
  cost, and duration (arafatkatze eval-RSI prompt).
- **Slice the failure surface four ways.** Do not debug one aggregate
  score; cut it by *task* (which items drive failures or token bloat),
  *model* (does one model gain while another regresses?), *tool* (which
  observations cause bad behavior), and *provider* (routing, caching,
  serialization, inference infrastructure). Then pick the fixed
  diagnostic slice from representative failures plus stable passing
  controls.
- **Treat context reduction as an experiment, not a virtue.** Smaller
  context is not automatically better; read/compaction changes must show a
  gain on the target slice, not just a smaller number. Cut output bloat at
  source (dumps, echoed commands) without deleting state the model needs.
- **Sweep reasoning effort.** More thinking is not automatically better.
  Evaluate reasonable effort settings for the target model and route and
  choose the cost-capability frontier, not the max by default; confirm the
  reasoning history is serialized in the format the provider expects.

#### Experiment ledger (structured archived attempts)

Mechanism 5 archives rejected attempts; the Cline prompt gives the schema that
makes an attempt reproducible. One record per iteration, appended (create-only,
same discipline as lessons):

```text
n · date · hypothesis (falsifiable) · trace evidence · code change · commit SHA
+ git tree · artifact name + checksum · exact command/config · test results ·
eval job path · score · gains · losses · exceptions · token/cost/duration ·
interpretation · keep/revert · next hypothesis
```

Record failures with the same care as successes; idiosyncratic
infrastructure/verifier constraints get named explicitly.

## First, decide the level

From awesome-rsi's Scope & Terminology:

| Level | Meaning | Example |
|---|---|---|
| Self-refinement | improves current output only | retry with feedback in one session |
| Persistent self-improvement | changes carry into the next round | lessons file, improved prompts, new tooling |
| Recursive self-improvement | the improver is itself improved | loop edits its own protocol/prompt |

Most useful repo loops are **persistent self-improvement with a gated path
to recursion**. That is what the template below designs: a fast base loop
plus a slow, capability-gated meta loop.

## The escalation ladder (how far to go)

Weng (2026) observes harness optimization progressing through targets:
**instruction prompts → structured context → workflow → harness code →
optimizer code**. Design the loop to climb this ladder deliberately, not to
start at the top:

1. **Prompts & instructions** — the agent's own instructions evolve from lessons.
2. **Structured context / memory** — a curated lessons/playbook file.
3. **Workflow** — the propose→predict→implement→evaluate→select cycle itself.
4. **Harness code** — scripts/CI that run the loop unattended.
5. **Optimizer code** — a meta loop that edits the loop. Highest risk, most gates.

Stop climbing when the metric stops improving; each level costs more
scaffolding than the last.

### Updating capability ≠ benefit capability

A refinement the 2026 work makes explicit (Lin et al. 2605.30621, via Weng
2026): separate **harness-updating** (can the model *write* a good harness
edit?) from **harness-benefit** (can a model *use* the edited harness well?).
Updating capability is roughly flat across model sizes — a 9B model can write
a procedurally isomorphic skill — but **benefit is non-monotonic: mid-tier
models gain the most, frontier models less, the weakest least.**

Consequences for this loop:
- Choosing a cheap model for the **Implement** phase is not the only routing
  decision. The model that **runs** the improved harness must also be capable
  enough to invoke its skills/tools in the right order over a long horizon.
- A harness edit can be well-written and still not pay off on the deployed
  model. Predict the benefit *on the target tier*, not just "the edit is
  good." This is why Evaluate/Select stay on the strong model.

## Seven mechanisms the template enforces

| # | Mechanism | Prevents | Source |
|---|---|---|---|
| 1 | Predict-then-implement; every edit is a falsifiable claim (expected fixes **and** at-risk regressions) | over-optimism, unattributable edits | AHE (2604.25850) |
| 2 | External verification only; self-critique is not evidence | mistaking "I reviewed it" for "it works" | Huang et al. (2310.01798) |
| 3 | Bounded editable surface; verifier/baselines/logs/model-config read-only | eval gaming, reward hacking | AHE (2604.25850); Weng 2026; harness-only admission (2610.10629); winner's curse (2610.09239) |
| 4 | Append-mostly itemized memory with ids; **pre-commit admission gate**; periodic dedupe for clutter | context collapse, brevity bias, skill contamination | ACE (2510.04618); 2608.05810; failure composition (2610.11655) |
| 5 | Archive rejected attempts + failure evidence | losing negative lessons; retrying dead ends | DGM (2505.22954) |
| 6 | Meta loop capability-gated before it can edit the improver | weaker-model recursion degrading the system | STOP (2310.02304) |
| 7 | Budget caps, rollback, interruptibility, human gates | runaway loops, irreversible damage | DGM precautions; Weng 2026 |

## The template (v2)

```text
You are a senior engineer designing a self-improvement loop for the
repository described below. The design must make the repo measurably better
on every iteration, with humans only at defined approval gates.

## Step 0 — classify the loop (mandatory, first)
Using these definitions, state which level you are designing and why:
- self-refinement — improves the current output; nothing persists.
- persistent self-improvement — changes (prompts, memory, skills, configs,
  code) that carry into the next round.
- recursive self-improvement — the improvement mechanism itself is improved
  by the loop.
Do not claim recursion you are not building. Most designs should be
persistent self-improvement with a GATED path to recursion (see meta loop).

## Repository context
- Stack: {{e.g., TypeScript monorepo, Node 20, pnpm}}
- Build/test commands: {{`pnpm test`, `pnpm lint`, `pnpm build`}}
- CI: {{GitHub Actions, ~9 min average, suite X is flaky}}
- Key dirs: {{src/agent/, scripts/eval/, .github/workflows/}}
- Current pain points: {{e.g., 54% coverage, flaky e2e, slow cold builds}}
- THE metric (single, measurable): {{e.g., mean CI time}}
  Regression guard (may not degrade): {{e.g., coverage, pass rate}}
- Agent runtime: {{opencode / goose / claude code; where the loop runs:
  CI job, cron, or manual invocation}}

## Required loop structure (two timescales)

Base loop — improves artifacts (code, prompts, skills, configs, docs):
1. Propose: 1–3 candidates from the backlog + last iteration's lessons.
2. Predict: expected metric delta and how it will be verified, BEFORE any
   edit. Every edit is a falsifiable claim: expected fixes AND at-risk
   regressions.
3. Implement: minimal diff, in a worktree/branch. Route mechanical subtasks
   to cheaper models only where each subtask has explicit inputs, bounded
   scope, and an executable acceptance check (see task-decomposition.md).
   Start each subtask on the cheap tier and escalate on an observable trigger
   (two failed acceptance runs, a repeated error loop, or sustained
   exploration) rather than guessing the tier up front — the escalation-router
   pattern. On each accepted change, log whether the benefit was measured on
   the *target* tier, not just on the strong model. Appraise before editing:
   label the failure composition first — if the target failures are
   content-class (a poor delivered plan), the harness cannot fix them; hand
   off to weight training and stop (2610.11655).
4. Evaluate: run the external verifier only (tests, benchmarks, harness
   runs). Intrinsic self-critique is not evidence. Compare against the
   stored baseline; run held-in checks (did the weakness resolve?) and
   held-out checks (did anything else break?). Score candidates on
   *behavior-relevant* tasks behind an attributable-evidence gate, not the
   whole suite every time — whole-suite scoring wastes budget and lets an
   aggregate hide a specific regression (HarnessLens, 2608.27311). Escalate
   in confidence stages (synthetic → preregistered frozen diagnostic subset →
   full eval → repeated confirmation), never tune the diagnostic subset to
   favor later candidates, and change one causal axis at a time (see
   "Benchmark-defensibility and confidence gates" above). Report the
   selection score and the held-out score side by side (winner's curse,
   2610.09239). Before crediting any harness edit, match the control to the
   verifier. A model-scored verifier owes a matched-budget test-time-scaling
   control (2607.12227, 2609.40303) and an answer-rescue/eval-defect audit
   (2610.05533). A deterministic verifier fixes compute per item, so record
   that and skip the control. Re-run the incumbent and the revision from the
   same restored state to isolate the edit's effect (HMED, 2610.07979), and
   re-grade unchanged anchor artifacts each run to catch judge drift
   (2609.39958).
5. Select: accept only if the prediction was verified with no held-out
   regression; otherwise log the attempt + failure evidence to the archive.
   Guard against overfitting the evolution tasks the way RRSI does
   (2609.24972): anneal the edit budget (allow fewer bundled edits as rounds
   progress), and run a *critic* (screens benchmark-specific proposals) plus
   a *pruner* (drops edits that are too small, too expensive, or stale). A
   candidate advances only on a minimum effect size or strong paired
   task-level evidence, and a retained change must be defensible without
   naming the benchmark it was measured on.
6. Remember: append itemized lessons to the lessons file — each with an id,
   evidence, and one bullet; NEVER rewrite the file wholesale; dedupe
   periodically. Gate admission *before* a lesson/skill enters the file:
   accumulation is non-monotonic, and a defective entry becomes reference
   material for everything distilled after it, so post-hoc rollback recovers
   little (2608.05810). A new entry must pass an external critical check
   (does the cited evidence actually support the claim?) before it is
   written. Dedupe handles clutter; it cannot undo contamination. Preserve
   applicability conditions when extracting a lesson/skill — stripping scope
   conditions is the SkillPoison vector, which passes verification and
   lexical inspection (2610.07645). Draw lessons only from the current
   harness: foreign-scaffold traces are out-of-distribution (CoTrace,
   2610.10426). Treat skills as versioned falsifiable contracts with a replay
   gate (2610.11781). Only ~5 of 21 skills keep their full gain
   out-of-distribution, so prefer per-task regeneration over a growing
   library (2609.39148).

Meta loop — improves the improver (slower cadence, stricter gates):
- Reviews the base loop's protocol, prompt, and tooling against accumulated
  lessons; proposes BOUNDED edits to the loop itself (one section at a
  time).
- Enabled only after a capability check: the base loop must have run N
  iterations with a reliable accept rate first. Recursion with a weak
  improver makes the system worse, not better.
- Every meta-loop edit is itself subject to the base loop's
  predict→evaluate→select discipline.

## Editable surface (violating this invalidates the design)
- MAY edit: {{agent instructions, prompts, skills, tooling scripts, docs,
  app code}}.
- READ-ONLY to the loop: verifier/eval code, stored baselines, run logs,
  model config — anything that scores the loop. Moving the ruler is not
  improvement.
- Eval-harness changes are separate human-reviewed PRs, never made in-loop.

## Hard constraints
- Tests are never modified to make them pass; failures are data.
- Every accepted change cites the eval run that justified it.
- Archive rejected attempts with their failure evidence — negative results
  are kept, never erased.
- Budget: max {{k}} iterations per run, {{m}} min per eval; automatic
  rollback on regression; the loop must remain interruptible at any point.
- Human gates: auth/, DB migrations, dependency bumps, eval changes, and
  any irreversible operation.

## Deliverables
1. Mermaid diagram of both loops and their hooks into THIS repo.
2. Iteration protocol: a numbered, executable checklist an agent could
   follow with zero further clarification.
3. Verifier spec: what runs, where baselines live, pass/fail rule,
   regression thresholds, the held-out split, and how runs are stored.
4. Failure-mode table for THIS repo — include at minimum: eval gaming,
   goal drift, context collapse, over-optimism ("numerical duct tape"),
   implementation drift, stale training-data defaults, diversity collapse,
   runaway loops — each with a concrete mitigation.
5. Cost plan: which implementation subtasks route to cheaper models, the
   acceptance check for each, and the escalation rule on failure.
6. First experiment: the exact first base-loop iteration (one small change,
   its prediction, the eval command, the accept/reject rule) — runnable
   today.
7. If any repo detail you need is missing, ask up to 3 clarifying questions
   BEFORE designing.
```

## Compact version (chat use)

```text
Here is my repo tree, CI config, and last 3 failed CI runs. Design a
persistent self-improvement loop: propose → predict → implement → evaluate →
select → remember, plus a slower meta loop that improves the loop itself
(gated by a capability check). THE metric is X; guard Y. Constraints: the
verifier, baselines, and model config are read-only to the loop; tests may
never be edited to pass; every accepted change cites its eval run; rejected
attempts are archived with a structured, reproducible ledger; lessons are
itemized and append-mostly with a pre-commit admission gate (bad memory
contaminates later rounds irreversibly). Verification escalates in confidence
stages (synthetic → preregistered frozen diagnostic subset → full eval →
repeated confirmation), candidates advance only on a minimum effect size,
and retained changes must be defensible without naming the benchmark. Budget
caps + rollback + human gates for auth/migrations/eval. Route mechanical
implementation to cheaper models only with an executable acceptance check
per subtask. Output: level declaration, loop diagram, executable iteration
checklist, verifier spec, failure-mode table with mitigations, cost plan,
and the exact first experiment. Ask up to 3 questions before designing.
```

## Failure modes to design against

| Failure mode | What it looks like | Mitigation |
|---|---|---|
| Eval gaming / reward hacking | loop edits the verifier, loosens tests, exploits benchmark artifacts | verifier + baselines read-only to the loop; eval changes are human-gated PRs |
| Goal drift | metric improves while the mission quietly changes | metric frozen for N iterations; periodic audit against the charter |
| Self-critique as "verification" | "I reviewed the diff and it looks correct" | external verifier only; self-review never counts as evidence |
| Context collapse | lessons file rewritten until domain detail is gone | itemized append-mostly bullets with ids; periodic dedupe, never wholesale rewrites |
| Brevity bias | memory compresses into vague summaries losing the evidence | every bullet carries its evidence link / eval-run reference |
| Over-optimism / "numerical duct tape" | declares success on noise; p-hacks the metric | prediction registered before implementation; held-out confirmation required |
| Implementation drift | ships a generic solution instead of the proposed approach | selection compares the shipped diff against the registered prediction |
| Stale training-data defaults | invented repo structure, outdated commands, wrong libs | grounding pass: read actual files before proposing; proposals cite files |
| Diversity collapse / overfit evolution | every iteration is a variant of the same change type, or edits memorize the evolution tasks and vanish out-of-distribution | archive review + novelty check; annealed edit budget; critic screens benchmark-specific proposals; pruner drops stale/tiny/costly edits (RRSI, 2609.24972) |
| Capability mismatch (meta loop) | self-edits by a weaker improver degrade the loop | capability gate: meta loop enabled only after reliable base-loop runs; harness evolution is bounded by feedback fidelity and backbone capability (2608.08466) |
| Runaway loop / runaway spend | unbounded iterations, escalating eval cost | budget caps, wall-clock stop, interruptibility, rollback |
| Cheap-model error leakage | mechanical subtask passes a weak check and merges wrong | executable acceptance check per subtask; escalation on failure; strong-model integration review |
| Noise read as signal | a single lucky run is promoted; sampling variance, provider flakiness, or an outage is mistaken for improvement | repeated baselines; report score ranges and task flips; promote only past a minimum effect size (arafatkatze eval-RSI prompt) |
| Proxy-metric win | cheap proxy improves while the true objective does not (74% / 47% of cases in the ICLR 2026 study) | validate on a held-out, realistically-scored objective; ruler read-only to the loop; never trust the proxy that the loop can influence |
| Benchmark-specific patch | a change only helps because it encodes the eval: task-name checks, hardcoded answers, raised timeouts/resources, excluded or cherry-picked runs | admission gate: a retained change must be defensible without naming the benchmark; explicit ban list + minimum effect size + repeated confirmation (Cline Kimi-K3 prompt) |
| Benefit mismatch | a well-written harness edit does not help the model that actually runs it | predict the benefit on the *target* tier; mid-tier gains most, weakest least; keep Evaluate/Select strong |
| Memory/skill contamination | a defective lesson or skill becomes reference material for later ones; contamination chains are structurally irreversible | pre-commit admission gate: external critical check that cited evidence supports the claim *before* writing; dedupe cannot undo contamination (2608.05810) |
| Misevolution | individually harmless memory/skill edits compound into harmful behavior | periodic audit of lessons/skills against the charter; human review cadence |
| Winner's curse | a gain measured on the selection set does not hold on held-out; small selection sets inflate the effect | report selection and held-out scores side by side; keep a frozen 64+ item holdout; a keep requires a held-out score (2610.09239) |
| Scaling-equivalent gain | a "harness improvement" merely reproduces what extra test-time compute buys | matched-budget test-time-scaling control before crediting a model-scored harness edit (2607.12227; 2609.40303); a deterministic verifier fixes compute per item |
| Answer-rescue gain | the gain comes from rescuing unreadable answers, a weak baseline, or an eval defect, not the harness | answer-rescue/eval-defect audit; inject a known defect and confirm the metric moves (2610.05533) |
| Shared blind spot | in a homogeneous loop the same weakness compromises the behavior and the mechanism meant to correct it | keep the reviewer external and strong; independent anchors; the read-only ruler (2610.12176) |
| Skill scope-stripping | a verified-successful experience is admitted as a skill after its applicability conditions are dropped, so it overgeneralizes | audit scope conditions, not just correctness, at admission; SkillPoison passes verification and lexical inspection (2610.07645) |

## The first experiment

Pick a pain point with a fast, objective verifier. One minimal change;
register the prediction; run the eval; accept or reject; log the lesson
either way. Run three manual iterations before automating anything — if the
verifier signal doesn't survive three rounds, automation will only make bad
signal cheaper.

## Multi-iteration campaigns

The base loop is one iteration; a *campaign* runs it N times in one session
under explicit brakes. It is batched persistent self-improvement, **not
recursion**: it does not edit the loop. The meta loop stays behind the
capability gate — STOP (2310.02304) found recursion helps only with capable
base models, HSI (2608.08466) bounds it by the backbone's own ceiling, and
AIDE²'s ignition test (2609.26457) could not show the self-improved agent
driving the outer loop better than a human agent. Use a campaign when a pain
point has several distinct candidate fixes you want landed as separate PRs
without re-priming the loop between each.

Every mechanism below is grounded in `reading-list.md` (which stays the
citation of record):

- **One iteration = one branch = one PR.** Never bundle two hypotheses into
  one diff; attribution and rollback both depend on the single-axis rule.
- **Build the selection set for diversity first.** AIDE² (2609.26457): assemble
  3–5 candidate hypotheses *before* iterating and tag each with a change-type
  (gate / instrument / cadence / config / docs / routing / security). Prefer
  distinct tags; a campaign that keeps making the same kind of edit is the
  diversity-collapse failure mode, so forbid two consecutive iterations of the
  same type. AIDE²'s bandit policy forks periodically to fight stagnation
  without discarding the best solution.
- **Appraise against the two bounds.** Feedback-fidelity and backbone-
  capability (HSI, 2608.08466): no informative signal, or a task beyond the
  frozen model's ceiling, means no evolution — drop the candidate.
- **Keep an archive, not a lineage.** Darwin Gödel Machine (2505.22954);
  AIDE² (2609.26457) rejected ~25% of rewrites that beat the incumbent on the
  agent-visible signal only, under a public/private signal split. Select on the
  private grade, and keep rejected candidates in the create-only ledger.
- **Advance on a minimum effect or repeated confirmation** — the Cline
  Kimi-K3 prompt's rule and arafatkatze's "quantify the noise first" mechanism.
- **Stop brakes (all enforced).** Stop on: two consecutive no-gain iterations;
  two consecutive same-type iterations; the iteration cap (default 3, hard cap
  5); or a blocking operator decision (hand it over, do not guess). A negative
  result ends its iteration and counts toward the no-gain brake; it is never
  dressed up as a gain.
- **Fan out in batches of up to 3.** Per iteration, dispatch at most three
  subagents in parallel: mechanical subtasks to `executor` (cheap) with an
  executable acceptance check, independent investigations to `explore`, and a
  fresh-eyes `reviewer` at Select. Escalate to `executor-strong` only on an
  observable trigger (two failed acceptance runs, a repeated error loop,
  sustained exploration), re-dispatching the same spec with the failure trace —
  NeMo Switchyard's escalation router. Strong-to-weak transfer (2608.12307)
  justifies routing execution down; HarnessOpt-Bench (2608.06301) and
  "Harness Updating Is Not Harness Benefit" (2605.30621) keep Select/Evaluate
  up.
- **Batch three ways.** (1) within an iteration — up to 3 subtask subagents via
  `task`; (2) across iterations — reuse one long-running helper session by
  passing its `sessionID` back instead of respawning, holding per-call context
  roughly constant (AIDE²); (3) across file-conflicting subtasks —
  `guard_worktree_create` per writer, then `guard_worktree_cleanup`.
- **Regularize Select.** RRSI (2609.24972): anneal the edit budget (fewer edits
  as rounds progress) and prune proposals that are benchmark-specific, too
  small, too expensive, or stale.
- **Evaluate behind the attributable-evidence gate.** Behavior-relevant tasks,
  not the whole suite every time (HarnessLens, 2608.27311); every candidate
  graded under the same per-task budget (AIDE²) so a gain is a better
  algorithm, not more compute.
- **Gate admission before context, not dedupe after.** Memory/skill
  accumulation is non-monotonic and cross-round contamination is structurally
  irreversible (When Self-Evolution Backfires, 2608.05810). The lesson gate is
  the Verifier-as-Gatekeeper; itemized, id'd bullets are the ACE pattern
  (2510.04618) against context collapse and brevity bias.
- **Keep the ruler and the fleet safe.** Evaluate/Select stay on the strong
  model; the verifier, baselines, logs, and model config stay read-only; live
  config changes go through the sanctioned installer, never a direct edit of
  the live `~/.config/opencode/**`. The ban list is the Cline and arafatkatze one; the
  stakes are the ICLR 2026 reward-hacking result (`ikrQWGgxYg`: 73.8%
  KernelBench / 46.8% ALE-Bench proxy-only "wins").
- **Audit for goal drift** — metrics freeze plus goal audits (2505.02709;
  misevolution, 2509.26354).
- **Hold-out discipline.** Every kept iteration reports selection and held-out
  scores; the held-out set is never reused for selection (2610.09239). The
  ledger v2 schema enforces this (`validate-ledger.cjs`, pre-commit Layer 15).
  The held-out chain is tamper-evident: each record carries the sha256 of the
  preceding record block (`prev-chain`, 2610.10629).
- **Control before credit.** The control depends on the verifier. A
  model-scored verifier owes a matched-budget test-time-scaling control and an
  answer-rescue/eval-defect audit, because there more compute can reproduce a
  "gain" (2607.12227, 2609.40303, 2610.05533). A deterministic verifier fixes
  compute per item, so record that and skip the control. A gain the scaling
  control reproduces is a no-gain for the brake.
- **Failure-composition triage.** Run `install/lib/measure-failure-composition.cjs`;
  drop candidates whose target failures are content-class (2610.11655).
- **Idea-level screening.** Screen candidates with the `screener` subagent
  before any evaluation (2610.08993, 2610.12086).
- **Never auto-approve.** A self-modifying loop must not auto-approve its own
  edits (2610.07639: auto-approve 29.2%→95.6% attack success; 2609.38983
  approval laundering).
- **Report at the end.** A table of iteration · branch · PR · change-type ·
  prediction · result · stop reason, then what remains. The campaign's own
  accept-rate and which change-types paid off become lessons for the gated meta
  loop.

The executable form is the `/rsi-campaign` command
(`install/opencode/commands/rsi-campaign.md`, symlinked live into
`~/.config/opencode/commands/`); `/rsi-loop` stays the single-iteration entry.

## Anchoring to this dotfiles repo

Substrates already here:

- `install/opencode/` — the agent fleet: `decompose`, `executor`,
  `executor-strong`, `reviewer`, `retrospective`, each with permission
  boundaries and `steps`
  caps. Agents carry per-role `model:` tier pins (the router adds the failover
  layer), and subagents run in their own context via the `subagent` tool. The
  slash commands
  `/decompose`, `/review-diff`, `/retro`, and `/rsi-loop` make the loop
  invocable manually.
- `opencode-auto-router` (external plugin, symlinked live) — the cost plan
  made mechanical. Primary provider is Synthetic's `syn:*` aliases with a
  cross-provider failover to OpenRouter's Auto Router on rate limits. For the
  fleet, the tier is enforced by each agent's explicit `model:` pin (the
  authoritative mechanism, n=8): heavy/judgment roles (decompose, reviewer,
  executor-strong) pinned to `syn:large:text`, mechanical/light roles (executor,
  retrospective) to `syn:small:text`. The plugin's `ctx.agent.transform`
  role-routing remains for **unpinned** agents — built-ins (measured: `explore`
  -> `syn:small:text`) and strangers — so it is the fallback mechanism, not what
  sets the fleet's tier. Either way the tier is a property of the role, not a
  per-request guess; this is the coarse lever OpenCode V2 exposes (request hooks
  keep `model` readonly).
- `docs/agents/ledger.md` — the structured, create-only experiment ledger
  (mechanism 5's reproducibility schema). `/rsi-loop` appends one record per
  iteration.
- `.config/goose/config.yaml` — goose provider/model wiring.
- `install/opencode/STANDARDS.md` — the seed artifact an improving loop would evolve.
- `install/lib/measure-failure-composition.cjs` (instrument) and
  `install/lib/validate-ledger.cjs` (gate, pre-commit Layer 15) — the
  failure-composition triage ruler (2610.11655) and the held-out/prev-chain
  admission gate (2610.09239, 2610.10629).

An RSI-lite loop for this repo (ladder levels 1–3: persistent
self-improvement, not yet recursive):

1. After real coding sessions, a retrospective subagent writes itemized
   lessons (id, evidence, bullet) as one file per lesson under
   `docs/agents/lessons/` — create-only, dedupe periodically.
2. Periodically, a proposal run turns stable lesson clusters into bounded
   edits to `install/opencode/STANDARDS.md` or opencode agent instructions, each with a
   prediction ("new sessions should need fewer corrections on X").
3. Verify honestly: the updated files still parse, and a fresh-eyes agent
   completes a standard task with fewer interventions than baseline.
4. The meta loop (improving the retrospective prompt itself) stays gated
   until steps 1–3 have survived ~10 iterations.

Honest classification: persistent self-improvement at the prompt/context
level. It becomes recursive only when the loop that edits the retrospective
protocol is itself editable — do that last, deliberately.
