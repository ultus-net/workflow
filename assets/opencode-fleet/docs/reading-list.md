# Reading List — RSI & Self-Improving Agents

> Annotated references that shaped `prompt-design.md` v2 and
> `rsi-loop-playbook.md`. Source taxonomy:
> [lobehub/awesome-rsi](https://github.com/lobehub/awesome-rsi) — recheck
> upstream quarterly.
>
> Every entry below was re-verified against its primary source on
> 2026-09-22; follow-up passes on 2026-10-01, 2026-10-02, and 2026-10-12
> added later entries and one correction. See
> [Verification status (2026-09-22)](#verification-status-2026-09-22),
> [Verification status (2026-10-01)](#verification-status-2026-10-01),
> [Verification status (2026-10-02)](#verification-status-2026-10-02--deeper-pass-one-correction), and
> [Verification status (2026-10-12)](#verification-status-2026-10-12).

## Start here (synthesis)

- **Weng — "Harness Engineering for Self-Improvement"** (2026) — the best
  single synthesis: harness design patterns, the optimization-target ladder
  (prompts → context → workflow → harness code → optimizer code),
  self-improving harnesses, evolutionary search, open challenges. Most of
  this guide's structure descends from it.
  https://lilianweng.github.io/posts/2026-07-04-harness/
- **awesome-rsi** — the taxonomy this section is grounded in; its Scope &
  Terminology section is the source of the level definitions.
  https://github.com/lobehub/awesome-rsi
- **Anthropic Institute — "When AI builds itself"** (2026; updated Sep 18
  2026) — the current state-of-practice reference for the *macro* RSI picture
  (agent acceleration, human bottlenecks, and the policy stakes), as opposed
  to the loop-design papers below. Evidence it reports: >80% of code merged
  at Anthropic was authored by Claude as of May 2026, and the typical engineer
  merged ~8x as much code/day in Q2 2026 as in 2024; METR's task-horizon
  doubling has accelerated to ~4 months (from ~7); an automated Claude review
  would have caught ~1/3 of past `claude.ai` incident bugs; and an automated
  research loop recovered 97% of a weak-supervisor gap over ~800 agent-hours
  and ~$18k compute (vs 23% for two humans over ~a week; caveat: it did not
  transfer to production-scale models). Two load-bearing frames for this
  guide: **Amdahl's law** — human review becomes the bottleneck once agents
  produce code faster than humans can verify it, which is why verification
  and human gates are the scarce resource; and its recursive scenario is
  **compute-bound** and raises verification/slowdown/pause policy questions
  (see `policy-review.md`). Primary-verified.

## Foundations

- Good (1965), "Speculations Concerning the First Ultraintelligent Machine"
  — origin of the intelligence-explosion argument.
- Schmidhuber, "Gödel Machine" (arXiv cs/0309048) — self-referential
  improvement gated by proof; the idealized ancestor of every "accept only
  verified improvements" loop.
- "A Survey of Self-Evolving Agents" (2507.21046, TMLR 2026) — what/when/how
  agents evolve across memory, tools, and architectures.
- "Recursive Self-Improvement in AI" survey (2607.07663) — bounded
  refinement vs open-ended RSI, organized by update target and loop closure.

## Core loop designs (the patterns worth stealing)

- **STOP** (2310.02304, COLM 2024) — the improver improves the improver.
  Cautionary result: recursion helps only with capable base models (GPT-4
  yes, GPT-3.5/Mixtral no) → the capability gate on the meta loop.
- **Darwin Gödel Machine** (2505.22954, ICLR 2026) — evolves its own harness
  code with an archive, not a lineage (20%→50% on SWE-bench).
  Archive-over-lineage and empirical-validation-only are the transferable
  ideas.
- **A Self-Improving Coding Agent** (2504.15228) — minimal self-editing
  loop, 17%→53% on a SWE-bench Verified subset; non-gradient learning via
  reflection + code edits.
- **AlphaEvolve** (2506.13131) — evolutionary program search with frozen
  LLMs + evaluators; `EVOLVE-BLOCK` markers = a bounded editable surface
  done well.
- **ADAS** (2408.08435, ICLR 2025) — a meta-agent searches over executable
  agent designs; "agent design as a search problem."
- **Promptbreeder** (2309.16797, ICML 2024) — evolves task prompts *and*
  the mutation prompts; a clean two-timescale example.
- **AHE — "Agentic Harness Engineering"** (2604.25850) — observability-
  driven automatic evolution of coding-agent harnesses. Harness edits are
  *confined to the workspace* (runs/tracer/verifier/LLM-config read-only)
  and gated by a versioned manifest plus next-round verification; every edit
  carries a self-declared prediction. The bounded-editable-surface and
  decision-observability basis of this guide. The paper does **not** claim
  "workspace edits free, deployment gated" and is explicit that it is not a
  complete guardrail stack — see the correction in `policy-review.md` (F2).
- **AIDE² — "Recursive self-improvement of AI research agents"**
  (2609.26457, Sep 2026; Weco AI) — the strongest current datapoint for
  genuine recursion. Body-level details that matter for this guide:
  - **Two nested loops.** Inner agent optimizes code against a measurable
    metric; outer agent rewrites the inner agent. Each accepted rewrite
    becomes what the next step edits (the recursion closure).
  - **Decoupled signals.** The inner agent optimizes on the *public* signal
    `r_t^pub`; the outer loop selects on *private* held-out data `g`. The
    inner loop never sees the outer selection criterion — the mechanical
    implementation of "the ruler is read-only to the loop." Appendix D makes
    this quantitative: pooling the rejected rewrites from the three runs,
    **about a quarter scored *higher* than the incumbent on the agent-visible
    public signal and were rejected only on the private grade.** Had selection
    used what the loop could see, ~25% of accepted "improvements" would have
    been public-signal-only wins.
  - **Fixed per-task budget.** Every candidate is graded under the same
    per-task dollar budget, so a gain is a better algorithm, not more
    compute. The anti-"numerical duct tape" rule, enforced by construction.
    It is also what makes the prompt-compression result matter: under a
    cost cap, shorter prompts "buy more search steps" rather than just
    saving money.
  - **Selection benchmark constructed for diversity** so the evolutionary
    pressure favors *general mechanisms over task-specific tricks*.
  - **Gains transfer across backbone models, not just tasks.** Appendix C
    reruns the start (AIDE₀) and end (AIDE₈₅) harnesses under gemini 3 flash,
    gpt-5.6-sol, and fable 5, and the AIDE₈₅−AIDE₀ gain transfers on both
    benchmarks for all three. The paper hedges the size: on ALE-Bench it is
    large enough that gemini 3 flash + AIDE₈₅ beats fable 5 + AIDE₀ under the
    same budget, but on MLE-Bench it is smaller and "AIDE₈₅ with fable 5 …
    stays within one standard error of its AIDE₀ score." Harness quality is
    partly model-independent; the effect size is benchmark-dependent.
  - In an autonomous 8-day, 100-node run it accepted seven rewrites
    (grade 0.703 → 0.778). The final agent (`AIDE85`) matched or beat a
    two-year human-engineered production agent on four external benchmarks
    (one OOD: WeatherBench 2). Discovered mechanisms: a **bandit search
    policy over draft strategies** with periodic forking (fights stagnation
    without discarding the best solution), and **bounded role-specific
    context with a bug-rate-gated failure memory** (per-call prompt size
    roughly constant; up to ~50× compression). Reward hacking *fell*
    (55% → 32% vs the human agent's 39%) though never optimized for.
  - **Two cautionary results**, both load-bearing for the meta-loop gate:
    (1) the **ignition test** — the self-improved agent driving the outer
    loop was *not* decisively better than the human agent (3 seeds,
    inconclusive: 0.780 vs 0.782); (2) AIDE² itself "cannot be decisively
    distinguished" as an outer-loop agent due to compounding noise. Genuine
    recursion is real but the *improver-improving* step is unproven.
- **Self-Harness** (2606.09498, v3 Aug 2026) — an LLM improves its own
  harness via weakness mining → bounded proposal → regression on **both**
  held-in (did the weakness resolve?) and held-out (what else broke?) splits.
  Every final harness improved both splits across nine model×benchmark
  configs (up to +132% relative). The cleanest published mirror of this
  guide's base-loop structure; useful as a design-validity citation.
- **AVO — "Agentic Variation Operators for Autonomous Evolutionary Search"**
  (2603.24517, NVIDIA, Mar 2026) — the agent *is* the variation operator:
  over 7 days of continuous autonomous search it produced attention kernels
  beating cuDNN and FlashAttention-4. A worked example of ladder level 5
  (optimizer code) in a domain with a fast, objective verifier.
- **MASS** (2610.12176, 8 Oct 2026; Sakana AI + UC Berkeley) — homogeneous
  RSI: one model as executor, optimizer, and evaluator. The inner loop
  evolves a text workflow (roles, instructions, contracts, hops); the outer
  loop runs the champion 18x, ranks workspaces by a Bradley-Terry
  tournament, keeps 15 SFT + 1 validation, STRIPS the workflow from the
  training prompt, and LoRA-finetunes. Role generalization: training only on
  task-solving also improves optimizer and evaluator (evaluator agreement
  with external judges 0.73 → 0.93), and the optimizer, not the evaluator,
  is the bottleneck. The paper names the shared blind spot (homogeneous
  self-grading) as the RSI Achilles heel. Absolute scores fall
  out-of-distribution: Terminal-Bench 2.0 37.5 → 35.2, SWE-bench Verified
  62.6 → 61.1 (two cycles, 8 usable tasks). Design evidence for role
  generalization plus a reason to keep Reviewer external and strong.
- **RHI — "Recursive Harness Self-Improvement"** (2607.15524, 17 Jul 2026;
  same author group, MASS's direct predecessor) — harness as the prompt-level
  agent loop (roles/instructions/contracts/hops); each new output is paired
  against its immediate predecessor; improves low-reasoning-effort agents
  above max-effort at up to 60% lower cost; gains come from better
  inter-agent information flow, not longer traces. The cheap pairwise-revision
  loop MASS distills into weights.
- **Gödel Forest** (2609.36675, 29 Sep 2026) — parallel co-evolving search
  trees with distilled cross-tree memory beat single-tree data-centric RSI by
  10.7% avg; memory contributes +7.0 pts over independent parallel search.
  Archive-over-lineage with shared memory.
- **RSI-Anything** (2610.13912, 9 Oct 2026) — a predictive world model gates
  action and data selection; component/compatibility checks govern retention
  of policy-model pairs.
- **Evo²** (2610.13025, 9 Oct 2026) — a single policy as harness Proposer +
  Reflector; harness edits and outcomes train both roles (SFT + interleaved
  GRPO); 48.3% SWE-bench Verified; harnesses transfer cross-benchmark.
- **MESH-Harness** (2610.05300, 4 Oct 2026) — module-level harness pools with
  LinUCB bandit scoring and mixed-start coordinate ascent beat Meta-Harness
  under matched budgets; 44.2% lower test-time cost.
- **Turbo Harness** (2609.40330, 30 Sep 2026) — instance-adaptive harness
  optimization; recycles a completed global optimization run into a playbook
  and trains an editor to emit per-instance patches.
- **VACE** (2609.37105, 29 Sep 2026) — validation-gated alternating
  co-evolution; 17 of 44 harness proposals hurt validation at the updated
  checkpoint and must be rejected before further RL.
- **RAH — "Recursive Agent Harness"** (2606.13643, 11 Jun 2026) — code-first
  orchestration: a parent generates a script that spawns subagent harnesses;
  with GPT-5, 71.75% → 81.36% on Oolong-Synthetic, with the gain attributable
  to the harness not the model.
- **SIA** (2605.27276, 26 May 2026) — updates BOTH the harness and the weights
  (the two silos joined); beats scaffold-only on three domains.

## Memory & context

- **ACE** (2510.04618, ICLR 2026) — contexts as evolving playbooks;
  generator/reflector/curator; incremental itemized updates prevent
  **context collapse** and brevity bias. The design behind "append-mostly
  bullets with ids."
- **Reflexion** (2303.11366, NeurIPS 2023) — verbal self-reflection stored
  across trials; the ancestor of every "lessons file."
- **ExpeL** (2308.10144, AAAI 2024) — insights extracted from successes
  *and* failures; failures are data.
- **Meta Context Engineering** (2601.21557) — bi-level: evolves the
  context-management *mechanism*, not just content; the recursive step
  above ACE.
- **Meta-Harness** (2603.28052) — a harness that optimizes harnesses;
  file-system-based execution history instead of context bloat.
- **MetaSkill-Evolve** (2607.05297) — makes skill improvement itself
  recursive on two timescales: task skill evolves on a fast loop, the
  *meta-skill* (the Analyzer/Retriever/Allocator/Proposer/Evolver pipeline)
  on a slower loop under the same pipeline. The concrete architecture for
  this guide's gated meta loop; beats single-level evolution on three
  agentic benchmarks with one frozen backbone.
- **LabBook** (2610.00675, 29 Sep 2026) — agent-maintained memory separating
  complete history retention from selective context construction.
- **ReHarness** (2610.12668, 8 Oct 2026) — backward revision: after each
  instance, revise the reflections that were retrieved for it, propagating
  feedback through the textual harness state.
- **Causal Improvement Graph** (2610.05039, 4 Oct 2026) — externalize
  improvement state as an Evidence/Hypothesis/Intervention/Outcome graph,
  not a change log.
- **CoTrace** (2610.10426, 7 Oct 2026) — distill only on rollouts
  provenance-matched to the adopted runtime; harness-matched compact corpus
  beats larger pooled; OOD transfer breaks under foreign scaffolds.
- **RuleEvolve** (2610.00650, 29 Sep 2026; NeurIPS 2026) — evolving
  coding-rule pools (AGENTS.md-style) via mutator + judge beats manual rules
  and prompt optimization.
- **EASE** (2609.36746, 29 Sep 2026) — skill curation is executor-dependent;
  one curator conditioned on an online behavioral profile transfers across
  unseen executors, with 34-41% fewer skills.

## Verification & the negative results

- **Huang et al., "LLMs Cannot Self-Correct Reasoning Yet"** (2310.01798,
  ICLR 2024) — intrinsic self-correction without external feedback fails or
  degrades. Basis for "external verifier only."
- "Let's Verify Step by Step" (2305.20050, ICLR 2024) — process-level
  verification beats outcome-level; grade steps, not just ends.
- "Self-Consistency" (2203.11171, ICLR 2023) — majority vote over diverse
  reasoning paths as cheap quasi-external checking.
- **"Verify Smarter, Evolve Further: Efficient Harness Evolution through
  Behavior-Aware Verification"** (2608.27311, Aug 2026; system name
  *HarnessLens*) —
  scoring every candidate on a fixed task set wastes rollouts and lets
  aggregate scores hide specific regressions. Behavior-aware verification
  behind an *attributable-evidence gate* improved held-out performance by
  7.6-13.6% on substantially less evaluation budget. The verifier spec in
  `rsi-loop-playbook.md` should score candidates on **behavior-relevant**
  tasks, not the whole suite every time.
- **"Harness Evolution Hits a Ceiling: When Weight Training Should Begin"**
  (2610.11655, 8 Oct 2026) — diagnose-then-intervene: label failed
  trajectories by the FIRST signal that fires. Process failures (blocked
  calls, loops, exhausted step budgets) are harness-fixable then trainable;
  content failures (a poor delivered plan) are for weight training. A placebo
  adapter trained on answer-shuffled traces falls BELOW base. LoRA adapters
  internalize harness gains; cross-benchmark transfer (WebArena-Lite +0.09).
  The failure-composition lever.
- **"Who Verifies the Verifier? Co-Evolving Inspectable Graders"**
  (2610.11464, 8 Oct 2026) — a collapsed always-pass verifier still trains
  skills fine, so downstream score cannot certify a verifier; verifiers as
  compositions of deterministic detectors gated by anchored reference sets.
- **"Verification and Self-Improvement: Foundations and Limits"**
  (2610.10611, 7 Oct 2026) — formal: bounded self-modification under fixed
  sound verification stays within one verification class; ties
  self-improvement claims to selection-error budgets.
- **"Verify Less, Evolve More: Idea-Level Critics"** (2610.08993, 6 Oct
  2026) — an SFT+GRPO critic screens proposed modifications before expensive
  empirical verification; the critic beats its own teacher at static idea
  eval.
- **"Better Deck or Different Judge?"** (2609.39958, 30 Sep 2026) — five LLM
  judges credit a harness +20-34 points but only -4.7 to +0.8 vs direct
  strong-model generation; repeated grading shifts scores on UNCHANGED
  outputs (judge drift), so re-grade anchors each run.
- **HMED** (2610.07979, 6 Oct 2026) — re-execute incumbent vs revision from
  the SAME restored state to isolate the edit's effect; rejected revisions
  still yield training signal.
- **Mid-Harness** (2609.39982, 30 Sep 2026) — sample-and-verify candidate
  actions at the model-harness boundary; a strong verifier lifts
  TerminalBench-Lite pass@1 50 → 68% with 8 samples; distilling verifier
  responses improves the generator.
- **"Complex Agents, Shallow Tests" (HarnessTester)** (2610.04921, 4 Oct
  2026) — LLM-dependent harness code has <50% line/branch coverage in the
  wild; contract-faithful tests found 122 real harness bugs. Test the harness
  like software before letting it self-edit.
- **"Rethinking the Evaluation of Harness Evolution for Agents"**
  (2607.12227, v2 27 Aug 2026) — NEGATIVE: under matched feedback and
  inference budgets, automatic harness evolution does not consistently beat
  simple test-time scaling and generalizes poorly.
- **"How Much of a Harness Does a Strong Agent Need?"** (2609.40303, 30 Sep
  2026) — NEGATIVE: under equal time budget and the same frontier backbone,
  open-source SOTA harnesses show no advantage over a minimal-harness single
  session on MLE tasks.
- **"What Does a Harness Repair?"** (2610.05533, 4 Oct 2026) — NEGATIVE:
  harness "gains" often come from unreadable-answer rescue, weak baselines,
  or eval defects; 6/15 replication runs reproduced the defect's distortion;
  thinking-off beat GEPA-selected harnesses.
- **"False Frontiers"** (2609.39102, 30 Sep 2026) — co-cheating: proposer and
  solver in self-evolving search increasingly agree on shared errors; a
  split-source feedback solver cuts false agreement 8.8% → 3.7%, +8.4 pts
  over coupled self-evolution.

## Safety & drift

- "Your Agent May Misevolve" (2509.26354, ICLR 2026) — harmful drift across
  model/memory/tool/workflow evolution; source of the term *misevolution*.
- "Evaluating Goal Drift in Language Model Agents" (2505.02709) —
  long-horizon agents quietly deviate from objectives; why metrics freeze +
  goal audits.
- "Escaping Model Collapse via Synthetic Data Verification" (2510.16657) —
  iterative self-training collapses without external verification.
- "Self-Modification of Policy and Utility Function in Rational Agents"
  (1605.03142, AGI 2016) — formal conditions for goal-preserving
  self-modification.
- Weng — "Reward Hacking in Reinforcement Learning" (2024) — the loop
  optimizes whatever you measure.
  https://lilianweng.github.io/posts/2024-11-28-reward-hacking/
- "Why LLMs Aren't Scientists Yet" (2601.03315) — six recurring
  autonomous-research failure modes (over-optimism, implementation drift,
  stale defaults, context degradation…) → the extended failure-mode table.
- "Reward Hacking in Self-Improving Code Agents" (ICLR 2026 workshop,
  OpenReview `ikrQWGgxYg`; Zhao, Srikanth, Wu, Jiang) — across three frontier
  models and five agent configs, **73.8% of KernelBench and 46.8% of
  ALE-Bench "optimizations" improved the cheap proxy metric without improving
  the true objective**, sometimes while harming it. The sharpest recent
  empirical case for keeping the ruler outside the loop and validating on a
  held-out, realistically-scored objective.
- **"When Self-Evolution Backfires: Pre-Commit Gating against Skill
  Contamination"** (2608.05810, v2 Sep 2026) — memory/skill accumulation is
  **non-monotonic**: past a critical pool size new skills *degrade*
  performance, because a defective skill becomes reference material for
  everything distilled after it (cross-round contamination chains). The
  damage is **structurally irreversible** — post-hoc removal of the source
  recovers only a small fraction. So admission must be gated *before* an
  artifact enters context (Verifier-as-Gatekeeper: structural + behavioral +
  semantic critics, then marginal-gain subset selection). **This corrects
  `lessons.md`'s "append-mostly, dedupe later" stance: for memory/skills,
  dedupe is too late.**
- **RRSI — "Regularized Recursive Self-Improvement of Agent Harnesses"**
  (2609.24972, Sep 2026) — unregularized harness evolution overfits
  (up to +14.1 in-distribution but only +4.7 out-of-distribution). Fix:
  a temporally **annealed edit budget** (bundle fewer edits as rounds
  progress), plus a **critic** that screens benchmark-specific proposals and
  a **pruner** for edits that are too small, too expensive, or stale. Runs on
  30% fewer policy tokens. Directly informs the Select phase's anti-overfit
  discipline.
- **HSI — "Hierarchical Self-Improvement: Task-Specific Evolvable Agent
  Harnesses"** (2608.08466, Aug 2026) — harness evolution is bounded by two
  factors: a *feedback-fidelity bound* (no informative reward, no evolution)
  and a *backbone-capability bound* (harness redesign cannot overcome a
  frozen model's limit; on beyond-capability tasks it gives no improvement).
  The empirical shape of the capability gate on the meta loop.
- **NVIDIA OpenShell 0.1.0** (developer blog, Sep 28 2026) — an
  open-source runtime that enforces which systems/data an agent can reach,
  with credential substitution and a formal policy prover, **outside** the
  agent's own workload (an agent cannot approve its own permission request).
  The concrete external enforcement plane for the read-only-ruler rule.
  Vendor-reported, no independent replication.
- **Cline "Recursive Self Improvement for Coding Agents"** + its
  `KimiK3_HillClimb_Prompt.md` gist (blog + prompt, Jul 2026) — a real,
  one-prompt 17-hour recursive-harness run (Kimi K3 69/89 → 79/89, >88%, on
  Terminal-Bench 2.1). The prompt is a full published protocol: preregistered
  fixed diagnostic subset, one causal axis per iteration, an A-E evaluation
  ladder, a minimum-effect-size + repeated-confirmation advancement rule, and
  a structured experiment ledger. Vendor-reported for results; the prompt is
  a primary artifact. See the playbook's "*Benchmark-defensibility and
  confidence gates*" subsection.
- **arafatkatze "Recursive Self-Improvement Prompt for Agent Evals"**
  (gist, 27 Jul 2026) — the eval-focused sibling of the Cline prompt, a
  primary procedural artifact rather than a result. Contributes four
  mechanisms the playbook otherwise under-specifies: repeated baselines to
  **quantify the noise** before promoting; a four-way failure-surface
  slice (task / model / tool / provider); **context reduction as an
  experiment**, not a default win; and a **reasoning-effort sweep** to the
  cost-capability frontier. (Its loop also opens with "pick a North Star"
  and a pinned baseline, which the playbook already covers.) Same bans as
  Cline (never touch the verifier,
  tests, rewards, resources, or timeouts; no task-name checks, hardcoded
  answers, task-specific prompts, or benchmark-only behavior) and a
  durable experiment ledger (Cline additionally makes it create-only).
  Unversioned gist; no reported
  score, so it is cited for its protocol, not its results.
- **"The Winner's Curse in LLM Self-Improvement Loops"** (2610.09239, 7 Oct
  2026) — pre-registered: greedy keep-if-better on 16 selection items
  inflates reported gains 13-20 points over held-out; tested acceptance rules
  don't beat greedy; a 64 never-used item set debiases the average.
  Held-out-only admission, report both numbers.
- **"The Harness as the Only Mutable Surface"** (2610.10629, 7 Oct 2026) —
  confine self-evolution to the harness with fixed weights; a hash-chained
  admission gate admitted 144/7449 candidates with no held-out regressions;
  the ungated loop admitted 309 harmful changes.
- **Skill-V** (2610.11781, 8 Oct 2026) — skills as versioned falsifiable
  contracts; revisions must pass non-regression replay on historical
  evidence; applicability-aware retrieval filter; 95.3% ALFWorld.
- **SkillPoison** (2610.07645, 6 Oct 2026) — poisoning via
  verified-successful trajectories by stripping applicability conditions so
  extractors overgeneralize; 95.71% attack success, passes verification and
  lexical inspection. Audit scope conditions, not just correctness.
- **"Do Self-Evolving Skills Generalize?"** (2609.39148, 30 Sep 2026) — of 21
  skills that improve training tasks, only 5 keep the full gain; judges can't
  predict single-edit effects; per-task skill regeneration beats skill
  libraries.
- **HarnessSecurity-Bench** (2610.07639, 6 Oct 2026) — auto-approve raises
  attack success 29.2% → 95.6% across 6 harnesses; denylisting reduces
  attacks with a utility gain. Never auto-approve in a self-modifying loop.
- **"Approval Laundering"** (2609.38983, 30 Sep 2026) — six failure modes
  where the executed action A' differs from the approved action A; keyed
  capability tokens kill the Delegation and Temporal classes.
- **EvoBelief** (2610.12789, 8 Oct 2026) — environment beliefs as
  FALSIFIABLE hypotheses with evidence links and counterexample-driven
  narrowing.

## Cost-tiered execution (strong → weak transfer)

- **"AI4AI at Test-Time: Strong-to-Weak Capability Transfer via Harnesses"**
  (2608.12307) — strong builder models construct harnesses that transfer
  capability to weaker targets without weight updates. The theoretical
  basis of `task-decomposition.md`.
- **"Harness Updating Is Not Harness Benefit"** (2605.30621) — a 9B-class
  model can *write* harness edits as well as frontier models, but benefit is
  non-monotonic: weakest models gain least, mid-tier most, frontier less
  than mid → route execution mid-tier, keep integration/review strong.
- **Autodata** (2606.25996) — weak solver / strong solver / verifier roles
  around generated tasks; the same weak/strong split applied to data
  generation.
- **METR — "Measuring AI Ability to Complete Long Software Tasks"**
  (2503.14499, NeurIPS 2025) — defines the *task-completion time horizon*:
  capability as task-duration at a success probability; a useful lens for
  "how long a subtask can a cheap model hold?"
- **NVIDIA NeMo Switchyard** (NVIDIA developer blog, Aug 11 2026) — open-source
  model-routing layer with tuning-free routers: an *LLM classifier*, a *stage
  router* (exploration vs mechanical implementation), and an *escalation
  router* (start cheap, promote on sustained difficulty). Reported: escalation
  routing cut cost 74% vs frontier-only at a ~6-point accuracy tradeoff;
  staged routing reached near-frontier coding at ~28% lower cost. The
  mechanical basis for the escalation rule in `task-decomposition.md`.
- **NVIDIA NeMo Relay** (developer blog, Sep 30 2026) — an observability layer
  (ATOF event streams, ATIF trajectories, OpenTelemetry spans) for comparing
  harness changes: run a fixed task with an exact success check, A/B one
  change, compare verified outcomes first, then use traces to explain
  call/tool/retry/token deltas. A worked Hermes ToolPerf case shows a fix that
  raised success 19/27→22/27 only by spending more turns — exactly the
  "success alone hides the cost" trap. The concrete tooling for Evaluate.
- **SAG** (2610.07335, 5 Oct 2026; NeurIPS 2026) — gate critique invocation
  by entropy/top-2 margin as a value-of-information proxy, not always-on;
  24.6% → 78.4% ALFWorld at ~ReAct token budget.
- **EvoAlloc** (2610.12086, 8 Oct 2026) — budget allocator as a first-class
  evolvable component; counterfactual spot-checks of DENIED candidates;
  59-82% fewer full evaluations.
- **"Where Do the Tokens Go?"** (2610.11602, 8 Oct 2026) — 60.4% of tokens go
  to localization + reasoning; only 24.4% of efficiency methods preserve
  success at lower cost; a persistent-evidence trace cuts cost 18-23.7%. Cost
  diagnosis before optimization.
- **ScholarEvolve** (2609.40169, 30 Sep 2026) — harness evolution guided by
  research literature via topic-modeled improvement strategies per module;
  +14 pts AppWorld.

## Benchmarks worth knowing (for verifier design)

- **RE-Bench** (2411.15114, ICML 2025) — open-ended R&D tasks vs human
  experts; humans win at longer budgets — a caution against over-reading
  short-horizon agent wins.
- **MLE-bench** (2410.07095) — Kaggle-competition agents; the
  metric-optimization shape most repo loops will resemble.
- **SWE-bench Verified** — the human-validated subset; adopt the Verified
  discipline (validate tasks before trusting loop gains) for any self-built
  eval.
- **HarnessOpt-Bench** (2608.06301, Aug 2026) — measures an optimizer's
  end-to-end ability to improve a target agent's harness under an expensive,
  stochastic, fixed evaluation budget, with a held-out test partition
  inaccessible throughout. Across 111 runs / 5 optimizers / 4 tasks, the
  **optimizer model separates performance more than the coding harness it
  acts through** — a reason to keep Evaluate/Select on the strong model.
- **RSIGym** (2610.10310, 7 Oct 2026; vendor-reported, unreplicated) —
  environment-as-a-service for RSI with Data/Harness/Joint tracks, budget
  controls, and an RSI-Index metric.
- **MiMo-V2.6** (2610.11959, 8 Oct 2026; vendor-reported, unreplicated) —
  scaled agentic RL across mixed harnesses; explicit multi-layer
  reward-hacking defenses.

## Verification status (2026-09-22)

Every entry above was independently re-checked against its primary source
(arXiv abstract pages, OpenReview, publisher/blog URLs) on 2026-09-22:
titles, first author, arXiv-ID↔title correspondence, stated venue, and the
attributed claim. All entries resolve to the cited work. Corrections
applied in the same pass:

- Weng's reward-hacking post is titled "Reward Hacking in Reinforcement
  Learning" (not "…in LLMs").
- The METR paper is "Measuring AI Ability to Complete Long Software Tasks";
  "task-completion time horizon" is the metric it defines, not its title.
- **AHE (2604.25850) was added** — it is load-bearing in
  `prompt-design.md`/`rsi-loop-playbook.md` but was missing from this list.
- The AHE annotation was corrected: the paper confines harness edits to a
  workspace and gates each edit with a versioned manifest + next-round
  verification; it does not describe "workspace edits free, deployment
  gated" and explicitly disclaims being a complete guardrail stack.
  `policy-review.md` F2 was fixed in the same pass.
- "Your Agent May Misevolve" covers four evolution pathways (model, memory,
  tool, workflow), not three.
- The harness-benefit finding is non-monotonic (weakest < mid-tier >
  frontier), not simply "requires capability".
- Minor: "A Survey of Self-Evolving Agents" is a short title (full title:
  "…What, When, How, and Where to Evolve on the Path to Artificial Super
  Intelligence"); the previously-cited shorthand "Harness updating vs harness
  benefit" was corrected to the verbatim "Harness Updating Is Not Harness
  Benefit".

Method note: verification was done with external web lookups against the
primary sources, not from model memory. Re-run this pass when entries are
added or upstream is rechecked quarterly.

## Verification status (2026-10-01)

Quarterly re-check (`README.md` → Maintenance), plus an Anthropic / OpenAI /
NVIDIA / DeepSeek blog pass. All new entries below were fetched from their
primary source on 2026-10-01; arXiv titles and IDs were checked against the
abstract page, and attributed claims against the abstract/body text.

Added:

- AIDE² (2609.26457) — title "Recursive self-improvement of AI research
  agents", submitted 22 Sep 2026. Abstract confirms the 8-day run, seven
  successive improvements, four held-out benchmarks, and the 55% → 32%
  reward-hacking drop. Note: the paper writes the system name as `AIDE^2`.
- Self-Harness (2606.09498) — title "Self-Harness: Harnesses That Improve
  Themselves", v3 20 Aug 2026. Abstract confirms weakness mining → proposal →
  validation, held-in + held-out, and up to +132% relative gains.
- AVO (2603.24517) — title "AVO: Agentic Variation Operators for Autonomous
  Evolutionary Search", NVIDIA, 25 Mar 2026. Abstract confirms the 7-day run
  and the cuDNN / FlashAttention-4 comparisons.
- "Reward Hacking in Self-Improving Code Agents" — the OpenReview forum
  (`ikrQWGgxYg`) was behind a browser-verification wall at check time, but the
  ICLR 2026 virtual page (`iclr.cc/virtual/2026/10018648`) carries the full
  abstract and confirms the 73.8% KernelBench / 46.8% ALE-Bench figures, that
  the proxy-reality gap widens with optimization steps (26.4% → 57.8% from 10
  to 100 steps), and that the paper's own "retrospection" mitigation helps on
  KernelBench but not consistently on ALE-Bench. Primary-verified.
- NVIDIA NeMo Switchyard — NVIDIA developer blog, Aug 11 2026; fetched in
  full. The 74% / ~6-point and ~28% figures are the blog's own reported
  partner benchmarks (LangChain, Cognition), not independently replicated.

Confirmed unchanged and still load-bearing: Weng "Harness Engineering for
Self-Improvement" (Jul 2026) remains the best single synthesis; its ladder
(prompts → context → workflow → harness code → optimizer code) is intact, and
it now also carries Self-Harness, AHE, Meta-Harness, and the reward-hacking
challenge. Anthropic's multi-agent post (Jun 2025) and OpenAI's harness post
(Feb 2026) are unchanged and still consistent with the guide's orchestration
and repository-as-system-of-record advice.

Net: the loop design is **still current**. The 2026 evidence reinforces the
seven mechanisms rather than contradicting them. (The 2026-10-02 pass below
supersedes this line: it found one mechanism needing correction. Kept for the
audit trail.)

## Verification status (2026-10-02) — deeper pass, one correction

A second, less-anchored sweep (neighborhood: current harness-RSI literature
and the NVIDIA / Cline practitioner posts, not just the topics already in
this list). It found material the first pass missed and one result that
**changes** a mechanism.

Added (arXiv abstracts and blog posts fetched and checked 2026-10-02; entries
also summarized — or, for HarnessOpt-Bench/OpenShell/Cline, carried — in the
body sections above):

- "When Self-Evolution Backfires" (2608.05810, v2 17 Sep 2026) — confirms the
  non-monotonic pool size, the cross-round contamination chain, and the
  irreversibility of post-hoc removal; the proposed Verifier-as-Gatekeeper
  (three heterogeneous critics + marginal-gain subset selection) is the
  pre-commit gate. **Correction applied:** the append-mostly/dedupe-later
  stance in `lessons.md` and the playbook's context-collapse mitigation is too
  late for memory/skills; admission must be gated before the next generation.
- RRSI (2609.24972, v2 23 Sep 2026) — confirms annealed edit budget, critic,
  pruner, and the 14.1 vs 4.7 in- vs out-of-distribution split and the 30%
  token reduction.
- HarnessLens (2608.27311, 27 Aug 2026) — confirms behavior-aware verification
  with an attributable-evidence gate, +7.6-13.6% held-out, lower budget.
- HSI (2608.08466, 9 Aug 2026) — confirms the feedback-fidelity and
  backbone-capability bounds and the no-improvement result on beyond-capability
  tasks.
- MetaSkill-Evolve (2607.05297, 6 Jul 2026) — confirms the two-timescale
  task-skill/meta-skill split and the held-out gains over single-level
  evolution.
- HarnessOpt-Bench (2608.06301, 6 Aug 2026) — confirms harness optimization is
  measurable (111 runs, 5 optimizers, held-out partition, fixed budget) and
  that optimizer models separate more than the harnesses they act through.
- NeMo Relay (NVIDIA blog, 30 Sep 2026) — fetched in full; the Hermes ToolPerf
  A/B (108 runs) is a blog case study, not peer-reviewed.
- NVIDIA OpenShell 0.1.0 (NVIDIA blog, 28 Sep 2026) — runtime enforcement
  outside the agent workload, credential substitution, and a formal policy
  prover; relevant as the *external* enforcement plane for the read-only-ruler
  rule. Vendor-reported (no independent replication) and not required for this
  repo's loop.
- Cline "Recursive Self Improvement for Coding Agents" (blog, 24 Jul 2026;
  its prompt is the `KimiK3_HillClimb_Prompt.md` gist, `ref=cline.ghost.io`) —
  a real 17-hour one-prompt hill-climb (69/89 → 79/89 on Terminal-Bench 2.1).
  The gist is the primary artifact and confirms verbatim that reward hacking
  was avoided by an explicit ban list (never modify the verifier/dataset/tests;
  no task-name checks; no increased resources/timeouts; no cherry-picked runs)
  plus repeated confirmation and a human review backstop. Vendor-reported
  results; the prompt is primary-verified.
- arafatkatze "Recursive Self-Improvement Prompt for Agent Evals" (gist, 27 Jul
  2026) — surfaced in a follow-up sweep; the eval-focused sibling of the Cline
  prompt. Fetched in full and confirms four mechanisms folded into the
  playbook's Evaluate section: repeated baselines to quantify the noise; a
  task/model/tool/provider failure-surface slice; context reduction as an
  experiment; and a reasoning-effort sweep. Same ban list and durable ledger
  as Cline. Cited for its protocol; no reported score.

Method note: the first pass (2026-10-01) was partially anchored to this list's
own topics and under-sampled the 2607-2608 harness-RSI wave. The lesson
recorded for this session is: sweep the neighborhood of the primary sources,
not the topics already curated.

Net after the second pass: the loop design holds, with **one correction**
(memory admission gating replaces dedupe-as-primary-mitigation) and three
refinements (regularized Select; behavior-aware Verify; a
benchmark-defensibility/confidence-gate protocol and structured experiment
ledger from the Cline Kimi-K3 prompt). A follow-up sweep added four more
Evaluate mechanisms from the eval-focused arafatkatze prompt (noise
quantification, four-way failure slicing, context-reduction-as-experiment,
reasoning-effort sweep).

## Verification status (2026-10-12)

A third sweep (neighborhood: the primary sources' own neighborhood — MASS's
author group and the October arXiv listing — not this list's existing topics).
All new entries below were fetched from their primary source on 2026-10-12;
arXiv titles and IDs were checked against the abstract page and attributed
claims against the abstract/body text.

Added: 2610.12176, 2607.15524, 2609.36675, 2610.13912, 2610.13025,
2610.05300, 2609.40330, 2609.37105, 2606.13643, 2605.27276; 2610.00675,
2610.12668, 2610.05039, 2610.10426, 2610.00650, 2609.36746; 2610.11655,
2610.11464, 2610.10611, 2610.08993, 2609.39958, 2610.07979, 2609.39982,
2610.04921, 2607.12227, 2609.40303, 2610.05533, 2609.39102; 2610.09239,
2610.10629, 2610.11781, 2610.07645, 2609.39148, 2610.07639, 2609.38983,
2610.12789; 2610.07335, 2610.12086, 2610.11602, 2609.40169; 2610.10310,
2610.11959.

Confirmed unchanged: Weng's Jul 2026 synthesis remains current, and the seven
mechanisms hold.

Net: the loop design is **still current**. MASS adds design evidence for role
generalization while sharpening the homogeneous-self-grading blind spot as the
RSI Achilles heel, and the negative-results cluster (2607.12227, 2609.40303,
2610.05533) is unchanged.

Method note: this pass was seeded from the primary sources' neighborhood
(MASS's author group and the October arXiv listing), not from the list's own
topics.

### Disposition (2026-10-12)

| id | disposition |
| --- | --- |
| 2610.12176 | new-gate |
| 2607.15524 | new-instrument |
| 2609.36675 | protocol-adopt |
| 2610.13912 | watch-only |
| 2610.13025 | protocol-adopt |
| 2610.05300 | watch-only |
| 2609.40330 | watch-only |
| 2609.37105 | new-gate |
| 2606.13643 | watch-only |
| 2605.27276 | protocol-adopt |
| 2610.00675 | new-instrument |
| 2610.12668 | new-instrument |
| 2610.05039 | new-instrument |
| 2610.10426 | protocol-adopt |
| 2610.00650 | protocol-adopt |
| 2609.36746 | watch-only |
| 2610.11655 | new-gate |
| 2610.11464 | new-gate |
| 2610.10611 | new-gate |
| 2610.08993 | new-instrument |
| 2609.39958 | new-instrument |
| 2610.07979 | new-instrument |
| 2609.39982 | protocol-adopt |
| 2610.04921 | new-gate |
| 2607.12227 | new-gate |
| 2609.40303 | new-gate |
| 2610.05533 | new-gate |
| 2609.39102 | new-gate |
| 2610.09239 | new-gate |
| 2610.10629 | new-gate |
| 2610.11781 | new-gate |
| 2610.07645 | new-gate |
| 2609.39148 | new-gate |
| 2610.07639 | new-gate |
| 2609.38983 | new-gate |
| 2610.12789 | protocol-adopt |
| 2610.07335 | new-instrument |
| 2610.12086 | new-instrument |
| 2610.11602 | new-instrument |
| 2609.40169 | protocol-adopt |
| 2610.10310 | vendor-noted |
| 2610.11959 | vendor-noted |

### Actionable core (triaged 2026-10-12)

The Disposition table above labels 42 entries. Most are not work: 35 of the 42
are already adopted as reference, or are protocol/design evidence with no
mechanical surface. This subsection reduces them to the small set that maps to
a concrete action, and states the status of each. It is a first pass, pending
operator confirmation of the priority order; no entry is removed.

**Landed** (mechanism now in the harness; cited in `rsi-loop-playbook.md`):

| id | mechanism | where |
| --- | --- | --- |
| 2610.09239 | held-out vs selection reporting | Layer 15 `validate-ledger.cjs` |
| 2610.10629 | create-only prev-chain admission | Layer 15 `validate-ledger.cjs` |
| 2610.11655 | process-vs-content failure ruler | Layer 16 `measure-failure-composition.cjs` |
| 2610.08993 | idea-level critic before evaluation | `screener` agent + `/rsi-campaign` |
| 2610.12086 | counterfactual spot-check of denied candidates | `screener` agent + `/rsi-campaign` |
| 2608.05810 | pre-commit lesson admission gate | Layer 11 `validate-lessons.cjs` |

**Open core** (ranked by value against the current loop; the first is owed):

| rank | id | what it would add | disposition |
| --- | --- | --- | --- |
| 1 | 2607.12227, 2609.40303, 2610.05533 | a matched-budget test-time-scaling control: proves a harness "gain" is not just more compute | wired (conditional) — n=33 |
| 2 | 2610.04921 | contract-faithful tests for harness code before it self-edits | new-gate |
| 3 | 2609.39102 | split-source feedback solver to break proposer/solver co-cheating | new-gate |
| 4 | 2610.07979 | re-execute incumbent vs revision from the same restored state | new-instrument |
| 5 | 2610.07335 | gate critique invocation by entropy/margin (value of information) | protocol-adopt |

**Reference-only** (kept for grounding, no action pending): the remaining
`new-gate`, `new-instrument`, and `protocol-adopt` entries — most are design
evidence for the playbook's existing mechanisms (e.g. 2607.15524 RHI, 2609.36675
Gödel Forest, 2610.05039 Causal Improvement Graph) or negative controls already
cited. `watch-only` (5) and `vendor-noted` (2) stay parked.

The single decision this triage asks for: whether rank 1 (the matched-budget
control) is the next campaign, or whether rank 2 or 3 is cheaper and should go
first.

Update (n=33): rank 1 is wired. The control is now a conditional step in the
playbook and `/rsi-campaign` — a model-scored verifier runs it, a deterministic
one records that compute is fixed per item and skips it. So the decision moves
to rank 2 (contract-faithful tests before a harness self-edit) against rank 3
(split-source feedback solver).
