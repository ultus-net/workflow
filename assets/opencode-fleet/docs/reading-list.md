# Reading List — RSI & Self-Improving Agents

> Annotated references that shaped `prompt-design.md` v2 and
> `rsi-loop-playbook.md`. Source taxonomy:
> [lobehub/awesome-rsi](https://github.com/lobehub/awesome-rsi) — recheck
> upstream quarterly.

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

## Verification & the negative results

- **Huang et al., "LLMs Cannot Self-Correct Reasoning Yet"** (2310.01798,
  ICLR 2024) — intrinsic self-correction without external feedback fails or
  degrades. Basis for "external verifier only."
- "Let's Verify Step by Step" (2305.20050, ICLR 2024) — process-level
  verification beats outcome-level; grade steps, not just ends.
- "Self-Consistency" (2203.11171, ICLR 2023) — majority vote over diverse
  reasoning paths as cheap quasi-external checking.

## Safety & drift

- "Your Agent May Misevolve" (2509.26354, ICLR 2026) — harmful drift across
  memory/tool/workflow evolution; source of the term *misevolution*.
- "Evaluating Goal Drift in Language Model Agents" (2505.02709) —
  long-horizon agents quietly deviate from objectives; why metrics freeze +
  goal audits.
- "Escaping Model Collapse via Synthetic Data Verification" (2510.16657) —
  iterative self-training collapses without external verification.
- "Self-Modification of Policy and Utility Function in Rational Agents"
  (1605.03142, AGI 2016) — formal conditions for goal-preserving
  self-modification.
- Weng — "Reward Hacking in LLMs" (2024) — the loop optimizes whatever you
  measure. https://lilianweng.github.io/posts/2024-11-28-reward-hacking/
- "Why LLMs Aren't Scientists Yet" (2601.03315) — six recurring
  autonomous-research failure modes (over-optimism, implementation drift,
  stale defaults, context degradation…) → the extended failure-mode table.

## Cost-tiered execution (strong → weak transfer)

- **"AI4AI at Test-Time: Strong-to-Weak Capability Transfer via Harnesses"**
  (2608.12307) — strong builder models construct harnesses that transfer
  capability to weaker targets without weight updates. The theoretical
  basis of `task-decomposition.md`.
- **"Harness updating vs harness benefit"** (2605.30621) — a 9B-class model
  can *write* harness edits as well as frontier models, but *benefiting*
  from harnesses requires capability; mid-tier models gain the most →
  route execution, keep integration/review strong.
- **Autodata** (2606.25996) — weak solver / strong solver / verifier roles
  around generated tasks; the same weak/strong split applied to data
  generation.
- **METR Task-Completion Time Horizon** (2503.14499, NeurIPS 2025) —
  capability as task-duration at a success probability; a useful lens for
  "how long a subtask can a cheap model hold?"

## Benchmarks worth knowing (for verifier design)

- **RE-Bench** (2411.15114, ICML 2025) — open-ended R&D tasks vs human
  experts; humans win at longer budgets — a caution against over-reading
  short-horizon agent wins.
- **MLE-bench** (2410.07095) — Kaggle-competition agents; the
  metric-optimization shape most repo loops will resemble.
- **SWE-bench Verified** — the human-validated subset; adopt the Verified
  discipline (validate tasks before trusting loop gains) for any self-built
  eval.
