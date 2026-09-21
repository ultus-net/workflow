# Agents & Prompt Design

Working reference for designing prompts, agent harnesses, and
self-improvement loops, grounded in the current RSI literature.
Source taxonomy: [lobehub/awesome-rsi](https://github.com/lobehub/awesome-rsi).

## Files

| File | What it is |
|---|---|
| [prompt-design.md](prompt-design.md) | The craft of asking an LLM to design something for a specific repo. Includes the v1 → v2 evolution of the worked example. |
| [rsi-loop-playbook.md](rsi-loop-playbook.md) | The refined prompt template for designing a persistent, optionally recursive self-improvement loop, plus the failure modes it defends against. |
| [task-decomposition.md](task-decomposition.md) | Routing subtasks to cheaper models: what makes a subtask cheap-model-ready, the routing loop, cost discipline. |
| [reading-list.md](reading-list.md) | Annotated references — the papers and posts that shaped this guide. |
| [policy-review.md](policy-review.md) | Audit of workflow-guard decisions vs. the RSI literature — findings F1–F6 and the tier model for the control-plane port. |
| [Wiring — `.config/opencode/`](../../.config/opencode/opencode.jsonc) | The OpenCode fleet implementing this guide: `decompose`/`executor`/`reviewer`/`retrospective` agents, slash commands, ordered permissions. Agents carry roles; model routing stays upstream. Drafted, pending deployment (see `policy-review.md` Appendix B). |

## How to use

0. Deploy the wiring once (dotfiles `.config/opencode/` →
   `~/.config/opencode/`): agents `decompose`/`executor`/`reviewer`/
   `retrospective` and commands `/decompose`, `/review-diff`, `/retro`,
   `/rsi-loop`. No model pins — the upstream router assigns models to roles.
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
field moves fast and entries rot.
