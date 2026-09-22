# RSI Loop Playbook

> Prompt template for designing a persistent, optionally recursive
> self-improvement loop inside a specific software repo. v2 — refined
> against the awesome-rsi literature (`reading-list.md`).

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

## Seven mechanisms the template enforces

| # | Mechanism | Prevents | Source |
|---|---|---|---|
| 1 | Predict-then-implement; every edit is a falsifiable claim (expected fixes **and** at-risk regressions) | over-optimism, unattributable edits | AHE (2604.25850) |
| 2 | External verification only; self-critique is not evidence | mistaking "I reviewed it" for "it works" | Huang et al. (2310.01798) |
| 3 | Bounded editable surface; verifier/baselines/logs/model-config read-only | eval gaming, reward hacking | AHE (2604.25850); Weng 2026 |
| 4 | Append-mostly itemized memory with ids; periodic dedupe | context collapse, brevity bias | ACE (2510.04618) |
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
4. Evaluate: run the external verifier only (tests, benchmarks, harness
   runs). Intrinsic self-critique is not evidence. Compare against the
   stored baseline; run held-in checks (did the weakness resolve?) and
   held-out checks (did anything else break?).
5. Select: accept only if the prediction was verified with no held-out
   regression; otherwise log the attempt + failure evidence to the archive.
6. Remember: append itemized lessons to the lessons file — each with an id,
   evidence, and one bullet; NEVER rewrite the file wholesale; dedupe
   periodically.

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
attempts are archived; lessons are itemized and append-mostly; budget caps +
rollback + human gates for auth/migrations/eval. Route mechanical
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
| Diversity collapse | every iteration is a variant of the same change type | archive review + novelty check: reject candidates too similar to recent attempts |
| Capability mismatch (meta loop) | self-edits by a weaker improver degrade the loop | capability gate: meta loop enabled only after reliable base-loop runs |
| Runaway loop / runaway spend | unbounded iterations, escalating eval cost | budget caps, wall-clock stop, interruptibility, rollback |
| Cheap-model error leakage | mechanical subtask passes a weak check and merges wrong | executable acceptance check per subtask; escalation on failure; strong-model integration review |
| Misevolution | individually harmless memory/skill edits compound into harmful behavior | periodic audit of lessons/skills against the charter; human review cadence |

## The first experiment

Pick a pain point with a fast, objective verifier. One minimal change;
register the prediction; run the eval; accept or reject; log the lesson
either way. Run three manual iterations before automating anything — if the
verifier signal doesn't survive three rounds, automation will only make bad
signal cheaper.

## Anchoring to this dotfiles repo

Substrates already here:

- `.config/opencode/` — the agent fleet: `decompose`, `executor`,
  `reviewer`, `retrospective`, each with permission boundaries and `steps`
  caps. Agents carry roles, not model IDs — model routing is upstream — and
  subagents run in their own context via the `subagent` tool. The slash commands
  `/decompose`, `/review-diff`, `/retro`, and `/rsi-loop` make the loop
  invocable manually.
- `.config/goose/config.yaml` — goose provider/model wiring.
- `AGENTS.template.md` — the seed artifact an improving loop would evolve.

An RSI-lite loop for this repo (ladder levels 1–3: persistent
self-improvement, not yet recursive):

1. After real coding sessions, a retrospective subagent appends itemized
   lessons (id, evidence, bullet) to `docs/agents/lessons.md` — append-only,
   dedupe periodically.
2. Periodically, a proposal run turns stable lesson clusters into bounded
   edits to `AGENTS.template.md` or opencode agent instructions, each with a
   prediction ("new sessions should need fewer corrections on X").
3. Verify honestly: the updated files still parse, and a fresh-eyes agent
   completes a standard task with fewer interventions than baseline.
4. The meta loop (improving the retrospective prompt itself) stays gated
   until steps 1–3 have survived ~10 iterations.

Honest classification: persistent self-improvement at the prompt/context
level. It becomes recursive only when the loop that edits the retrospective
protocol is itself editable — do that last, deliberately.
