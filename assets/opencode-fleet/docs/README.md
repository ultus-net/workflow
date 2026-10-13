# Agents & Prompt Design

Working reference for designing prompts, agent harnesses, and
self-improvement loops, grounded in the current RSI literature.
Source taxonomy: [lobehub/awesome-rsi](https://github.com/lobehub/awesome-rsi).

## Files

| File | What it is |
|---|---|
| [prompt-design.md](prompt-design.md) | The craft of asking an LLM to design something for a specific repo. Includes the v1 → v2 evolution of the worked example. |
| [rsi-loop-playbook.md](rsi-loop-playbook.md) | The refined prompt template for designing a persistent, optionally recursive self-improvement loop, plus the failure modes it defends against. "Multi-iteration campaigns" defines the bounded-campaign form (diversity + stop brakes, subagent fan-out in batches of up to 3, one iteration = one branch = one PR). |
| [task-decomposition.md](task-decomposition.md) | Routing subtasks to cheaper models: what makes a subtask cheap-model-ready, the routing loop, cost discipline. |
| [reading-list.md](reading-list.md) | Annotated references — the papers and posts that shaped this guide. |
| [ledger.md](ledger.md) | Structured, create-only experiment ledger: one reproducible record per base-loop iteration (hypothesis, command, commit, score, keep/revert). Schema v2 adds `selection score` and `held-out score` (reported side by side, winner's curse 2610.09239) and a `prev-chain` sha256 (hash-chained admission, 2610.10629). `/rsi-loop` appends one; `/rsi-campaign` runs several iterations and appends the batch. Enforced by `install/lib/validate-ledger.cjs` (pre-commit Layer 15). |
| [lessons.md](lessons.md) | Append-only itemized lesson memory (ACE-style). The pre-commit lesson admission gate (`validate-lessons.cjs`, Layer 11) enforces an `L<nnn>` id, an `(evidence: ...)` citation, a single-bullet file, registration, and that the registry's bullet sequence is append-only against HEAD (no existing bullet rewritten, renumbered, reordered, or deleted); the evidence-supports-the-claim check stays an external review. One file per lesson under [lessons/](lessons/). |
| [policy-review.md](policy-review.md) | Audit of workflow-guard decisions vs. the RSI literature — findings F1–F6 and the tier model for the control-plane port. |
| [operator-actions.md](operator-actions.md) | The items outside the agent's boundary (live settings, process env, remote state) with the exact operator action and its evidence. |
| [findings/](findings/) | Focused negative/measurement results that are not full loop iterations. [config-caps-effectiveness.md](findings/config-caps-effectiveness.md): `watcher.ignore` is inert for agent sessions (flag-gated off) while `tool_output` is active and trims every spilled preview below the 2000/51200 default (n=7 converged both; n=9 tightened `max_lines` to 800; effect ≠ convergence). [watcher-enablement.md](findings/watcher-enablement.md): stages `OPENCODE_EXPERIMENTAL_FILEWATCHER=true` in `environment.d` (the backend inherits the session env) so the flag half of n=8 can go live. |
| `install/opencode/style/coding-style.md` | The fleet style floor: language-agnostic rules plus a precedence order (edited file → repo config → floor). `executor` follows it, `reviewer` enforces it; the target repo's own rules always win. Source at `install/opencode/style/`; the live `~/.config/opencode/style/` path is a symlink into it. |
| [Wiring — `install/opencode/`](../../install/opencode/config.jsonc) | The OpenCode fleet implementing this guide: `decompose`/`executor`/`executor-strong`/`reviewer`/`retrospective`/`screener` agents, slash commands, ordered permissions, shared style floor. Read-only harness rulers live in `install/lib/` and the live `~/.config/opencode/lib/` (a symlink into it) (`measure-failure-composition.cjs` labels failed trajectories process vs content, 2610.11655; `validate-ledger.cjs` gates the winner's-curse holdout, 2610.09239). Agents carry per-role `model:` tier pins; the upstream router adds the Synthetic-primary/OpenRouter failover layer. The golden tree is the single deploy source; the live `~/.config/opencode/` entries symlink into it (see `policy-review.md` Appendix B). |
| [RSI scaffolding templates](../../install/opencode/templates/rsi/) | Generic skeletons (`rsi-loop-playbook.md`, `ledger.md`, `lessons.md`) that `/rsi-loop` and `/rsi-campaign` instantiate into a repo's `docs/agents/` when absent. Source at `install/opencode/templates/rsi/`; the live `~/.config/opencode/templates/rsi/` is a symlink into it. |

## How to use

0. On a fresh machine, deploy the wiring once: the golden tree
   `install/opencode/` is the single source, and
   `bash install/bootstrap.sh --only 30` symlinks the live
   `~/.config/opencode/{agents,commands,lib,style,AGENTS.md,STANDARDS.md,templates,skills}` entries
   straight into it (agents `decompose`/`executor`/`executor-strong`/
   `reviewer`/`retrospective`/`screener`, commands `/decompose`, `/review-diff`, `/retro`,
   `/rsi-loop`, `/rsi-campaign`, the read-only harness rulers under `lib/`, the
   `style/` floor, and the `skills/` tree)
   and deploys the config + UI files. The agent cannot write the live config and
   agent trees directly (guard tamper policy over `~/.config/opencode/**`); the
   installer is the sanctioned applier. Each fleet
   agent carries a per-role `model:` tier pin in its
   frontmatter; the upstream router adds the Synthetic-primary/OpenRouter
   failover layer.
1. Read `prompt-design.md` for the general craft.
2. Copy the template from `rsi-loop-playbook.md`, fill the placeholders from
   the target repo's README/CI/backlog, and run it inside an agentic CLI at
   the repo root so it can read the code itself.
3. Route mechanical implementation subtasks to cheap models per
   `task-decomposition.md`.
4. Critique the produced design against the review checklist
   (`prompt-design.md`) and the failure-mode table (`rsi-loop-playbook.md`),
   then revise.
5. Ship only the *first experiment*; wire the rest of the loop after one
   iteration has proven the verifier signal.
6. Once the verifier signal holds, run several iterations in one session with
   `/rsi-campaign` (bounded: default 3, hard cap 5; diversity + no-gain stop
   brakes; subagent fan-out in batches of up to 3). Every mechanism it uses is
   cited from `reading-list.md`, and the meta loop stays gated by the
   capability check.

## Standing definitions (do not blur these)

From awesome-rsi's Scope & Terminology — every design must state which level
it is actually building:

- **Self-refinement** — improves the current output; nothing persists.
- **Persistent self-improvement** — changes (prompts, memory, skills,
  configs, code) that carry into the next round.
- **Recursive self-improvement (RSI)** — the improvement mechanism is itself
  improved by the loop.

## Maintenance

Re-check `reading-list.md` against awesome-rsi upstream quarterly — the
field moves fast and entries rot. Latest sweep: 2026-10-12 (seeded from the
primary sources' neighborhood — MASS's author group and the October arXiv
listing — not the curated topics; 42 entries added, one new gate and one new
instrument landed).
