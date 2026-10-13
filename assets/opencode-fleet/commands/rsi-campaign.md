---
description: Run a bounded multi-iteration RSI campaign (3-5 iterations, batched subagent fan-out, diversity + stop brakes) grounded in docs/agents/reading-list.md
subagent: false
---

Run a bounded RSI campaign for: $ARGUMENTS

Step 0 — ensure scaffolding (do this first, before Setup). The campaign reads
and appends to three repo-local artifacts; a missing one means no grounding and
nowhere to write. For each path below, if it does not exist, create it by
copying the matching template from `~/.config/opencode/templates/rsi/`:

- `docs/agents/rsi-loop-playbook.md` ← `rsi-loop-playbook.md`
- `docs/agents/ledger.md` ← `ledger.md`
- `docs/agents/lessons.md` ← `lessons.md` (and create the `docs/agents/lessons/`
  directory)

If a required file is missing and cannot be created, stop and report — do not
run a crippled campaign that writes nowhere.

Then read, in order: `docs/agents/rsi-loop-playbook.md` (including "Multi-iteration
campaigns"), the tail of `docs/agents/ledger.md`, and the corpus in
`docs/agents/reading-list.md`. Cite the sources below by name + id in the
ledger record; a mechanism with no citation must not be added silently.

A campaign is a parent that runs the base loop (the `/rsi-loop` protocol)
**repeatedly in one session**: N iterations, explicit stop brakes, and
subagent fan-out. One iteration = one branch = one PR. The base `/rsi-loop`
stays a single shot; the campaign is its batched form.

**What a campaign is not.** It is batched persistent self-improvement, not
recursion. Improving the loop itself (the meta loop) stays gated by the
capability check: STOP (2310.02304) found recursion helps only with capable
base models, HSI (2608.08466) bounds it by the backbone's own capability, and
AIDE²'s ignition test (2609.26457) could not show the self-improved agent
driving the outer loop better than the human agent. A campaign drives the base
loop; it does not edit it.

## Setup

- Parse N from `$ARGUMENTS` (default 3; hard cap 5).
- Run `node ~/.config/opencode/lib/measure-failure-composition.cjs` (read-only). Drop any
  candidate whose target failures are content-class — the harness cannot fix
  them (2610.11655).
- Build the candidate set **before** iterating — the playbook's "selection set
  for diversity," from AIDE² (2609.26457): pressure must favor general
  mechanisms over task-specific tricks, so assemble 3-5 one-line hypotheses
  from (a) the ledger tail's `next hypothesis` list, (b) the open P2/P3
  follow-ups (the review follow-up list, `guard_review_followups` under the
  current enforcement integration, opencode-workflow-guard; read the ledger and
  PRs directly if it is retired), (c) fresh failure slices. Tag each
  with a *change-type* (gate / instrument / cadence / config / docs / routing /
  security). Prefer distinct tags; a same-type pair is the diversity brake.
- Screen the candidate set with the `screener` subagent on the cheap tier
  before appraisal — idea-level screening ranks the hypotheses and hands back a
  shortlist plus a deny list before any evaluation budget is spent (2610.08993,
  2610.12086).
- Appraise the candidate against the two bounds — feedback fidelity and
  backbone capability (HSI, 2608.08466): if the candidate has no informative
  signal, or asks the frozen model to exceed its ceiling, drop it and say so.
- Confirm the branch is not `main`/`master` and the tree is clean.

## Per iteration

1. **Pick** the highest-value unblocked candidate whose change-type is **not**
   the previous iteration's tag (diversity brake). A candidate whose expected
   gain a matched-budget test-time-scaling control would reproduce is **not**
   picked: under matched budgets harness evolution does not consistently beat
   simple test-time scaling (2607.12227), and SOTA harnesses show no advantage
   over a minimal-harness single session (2609.40303). If only the same type
   remains, stop early and say so. Advance the incumbent only on a
   minimum effect size or repeated paired confirmation — the Cline Kimi-K3
   prompt's advancement rule (reading-list.md, "Safety & drift") and
   arafatkatze's "repeated baselines to quantify the noise" mechanism. Keep
   every candidate and its rejection in the ledger: an **archive, not a
   lineage**, so a confident-looking public-signal win cannot be lost or
   resurrected ungraded (Darwin Gödel Machine, 2505.22954; AIDE², 2609.26457,
   where ~25% of rejected rewrites beat the incumbent on the agent-visible
   signal and were rejected only on the private grade).
2. **Propose** (strong, yourself): read the actual files and cite them; write
   the falsifiable prediction (expected fixes, at-risk regressions,
   accept/reject rule, non-goals). The self-declared prediction per edit is the
   AHE pattern (2604.25850). Append the preregistration to
   `docs/agents/ledger.md` *before* editing — the durable, create-only ledger
   from the Cline and arafatkatze primary prompts. The preregistration uses
   **schema v2**: report `selection score (n items)` (the items the loop
   selects against) and `held-out score (n items, never used for selection)` (a
   disjoint set the loop never sees while selecting), and carry a
   `prev-chain: sha256:<hex>` linking to the prior record block. The two
   side-by-side scores defeat the winner's curse — greedy keep-if-better on a
   small selection set inflates reported gains 13-20 points over held-out
   (2610.09239). The chain makes every edit a reviewable, tamper-evident
   admission: a hash-chained gate admitted 144/7449 candidates with no held-out
   regressions where the ungated loop admitted 309 harmful changes (2610.10629).
   Compute the chain hash from the prior record block — the exact bytes the
   gate hashes, i.e. the prior `### n=<k-1>` block. The node form reuses the
   gate's own `sha256`/`parseRecords`:

   ```sh
   node -e "const v=require(process.env.HOME+'/.config/opencode/lib/validate-ledger.cjs');const r=v.parseRecords(require('fs').readFileSync('docs/agents/ledger.md','utf8'));console.log(v.sha256(r.find(x=>x.n===<k-1>).raw))"
   ```

   Equivalently, extract that block with `git show HEAD:docs/agents/ledger.md`
   and pipe it through `sha256sum`.
3. **Implement**, farming out in **batches of up to 3 subagents**:
   - Judgment-heavy edits: yourself (state why strong-only). HarnessOpt-Bench
     (2608.06301) and "Harness Updating Is Not Harness Benefit" (2605.30621)
     both put selection/integration on the strong model; execution may route
     cheaper.
   - Mechanical subtasks: `executor` (cheap tier) with a full spec (inputs,
     constraints, acceptance command). Strong-to-weak transfer justifies this
     (2608.12307). Escalate to `executor-strong` only on an observable trigger
     (two failed acceptance runs, a repeated error loop, sustained
     exploration) — the NeMo Switchyard escalation router (NVIDIA blog, Aug
     2026): start cheap, promote on sustained difficulty. Re-dispatch the same
     spec with the failed attempt and its acceptance output.
   - Independent investigations (find files, map a code path, reproduce a
     failure): `explore`.
   - Reuse a long-running helper across iterations by creating ONE
     `explore`/`general` session and passing its `sessionID` back, rather than
     respawning it each time. (AIDE²'s bounded role-specific context, 2609.26457,
     is the target shape: per-call context roughly constant.)
   - When 3+ subtasks touch overlapping files, isolate them in separate git
     worktrees (the current enforcement integration provides
     `guard_worktree_create` and `guard_worktree_cleanup`; use plain `git
     worktree` if it is retired). Workspace-confined edits are the AHE rule
     (2604.25850). The fleet source is the golden tree `install/opencode/**`;
     edit there. Never edit the live `~/.config/opencode/**` directly
     (tamper-protected); the live entries symlink into the golden tree, so an
     edit under `install/opencode/` is the live change. The config file deploys
     through
     `bash install/bootstrap.sh`.
4. **Evaluate**: external verifier only — intrinsic self-correction without
   external feedback fails or degrades (Huang et al., 2310.01798). Run the
   acceptance command and capture its output. Score behind the
   **attributable-evidence gate** on behavior-relevant tasks, not the whole
   suite every time (HarnessLens, 2608.27311). Grade every candidate under the
   same per-task budget so a gain is a better algorithm, not more compute
   (AIDE², 2609.26457). Stage A/B first (synthetic / preregistered frozen
   subset); the full suite only when needed; A-E confidence gates per the
   playbook (Cline Kimi-K3 prompt). Then, before crediting any harness edit:
   - **Report selection and held-out scores side by side.** Selection and
     evaluation on the same item set inflates the winner; the held-out items
     are never reused for selection (2610.09239).
   - **Run a matched-budget test-time-scaling control when the verifier is
     model-scored.** If simple test-time scaling under the same budget
     reproduces the "gain," the harness edit earns no credit (2607.12227,
     2609.40303). A deterministic verifier fixes compute per item, so record
     that and skip this control.
   - **Run an answer-rescue / eval-defect audit when the verifier is
     model-scored.** Gains often come from rescuing unreadable answers, a weak
     baseline, or an eval defect rather than the harness (2610.05533).
   - **Re-run incumbent vs revision from the same restored state** to isolate
     the edit's own effect (HMED, 2610.07979).
   - **Re-grade unchanged anchor artifacts each run** to catch judge drift —
     repeated grading shifts scores on unchanged outputs (2609.39958).
5. **Select**: keep/revert against the prediction. Apply the **regularization**
   from RRSI (2609.24972): anneal the edit budget (bundle fewer edits as
   iterations progress), and screen proposals that are benchmark-specific,
   too small, too expensive, or stale. Fetch the review rubric (the current
   enforcement integration provides `guard_review_rubric` and `record_review`;
   use the rubric in the reviewer prompt if it is retired), spawn a `reviewer`
   subagent with the diff and evidence, and record its verdict bound to the
   tip. Resolve any follow-up the change closes. Only a model-scored verifier
   runs the matched-budget control, and a gain that control reproduces counts
   as **no-gain** for the brake. The held-out
   gate is `~/.config/opencode/lib/validate-ledger.cjs` (pre-commit Layer 15): it enforces
   the v2 score lines, the disjointness declaration, and the `prev-chain`
   (2610.09239, 2610.10629).
6. **Remember**: admission is gated **before** the artifact enters context, not
   deduped later — memory/skill accumulation is non-monotonic and
   cross-round contamination is structurally irreversible (When Self-Evolution
   Backfires, 2608.05810; Verifier-as-Gatekeeper). Write one lesson file (it
   must pass the admission gate) and append the ledger record (result, score,
   gains/losses, next hypothesis) with the citations used. Itemized, id'd
   bullets are the ACE pattern (2510.04618) against context collapse and
   brevity bias. Then the SkillPoison check: extraction must preserve the
   lesson's applicability conditions, and a stripped condition fails admission
   even when the experience was verified successful (SkillPoison, 2610.07645).
   Draw lessons only from the current harness — foreign-scaffold traces are
   out-of-distribution (CoTrace, 2610.10426). Treat skills as versioned
   falsifiable contracts with a replay gate (Skill-V, 2610.11781).
7. **Close**: commit, push, open the PR with the diff, the evidence, and the
   review summary. Record the change-type and gain/no-gain for the brake.
   Audit the campaign against goal drift: metrics freeze + goal audits
   (2505.02709).

## Stop brakes

Stop the campaign when ANY holds:

- **2 consecutive no-gain iterations** (prediction falsified or effect below
  the minimum effect size).
- **2 consecutive iterations of the same change-type** (diversity collapse).
  AIDE²'s bandit policy forks periodically to fight stagnation without
  discarding the best solution (2609.26457).
- **N iterations done**, or the hard cap (5) reached.
- A **blocking operator decision** surfaces (e.g. a cap-value choice): stop
  and hand it over; do not guess.

## Report

End with a table: iteration · branch · PR · change-type · prediction · result
(gain/no-gain) · stop reason. Then state what remains (operator items +
next-hypothesis) and whether the campaign should continue. Every kept/reverted
row cites the reading-list.md mechanism it tests.

## Research grounding (reading-list.md)

| Campaign element | Source |
|---|---|
| Campaign batches iterations; meta loop stays gated | STOP (2310.02304); HSI (2608.08466); AIDE² ignition test (2609.26457) |
| Pre-built selection set, diversity pressure | AIDE² (2609.26457) |
| Candidate appraisal: feedback-fidelity / backbone-capability bounds | HSI (2608.08466) |
| Archive of candidates, not a lineage | Darwin Gödel Machine (2505.22954) |
| One causal axis per iteration; one iteration = one PR | Cline Kimi-K3 prompt |
| Minimum-effect / repeated-confirmation advancement | Cline Kimi-K3 prompt; arafatkatze prompt |
| Self-declared prediction per edit; workspace-confined edits | AHE (2604.25850) |
| Create-only durable ledger | Cline (create-only); arafatkatze |
| Route execution cheap, keep Select/Evaluate strong | Strong-to-weak transfer (2608.12307); Harness Updating Is Not Harness Benefit (2605.30621); HarnessOpt-Bench (2608.06301) |
| Escalate on sustained difficulty, not up front | NeMo Switchyard escalation router (NVIDIA blog, Aug 2026) |
| External verifier only | Huang et al. (2310.01798); Verify Step by Step (2305.20050) |
| Behavior-relevant tasks behind an attributable-evidence gate | HarnessLens (2608.27311) |
| Fixed per-task budget; public/private signal split | AIDE² (2609.26457) |
| Annealed edit budget; critic + pruner | RRSI (2609.24972) |
| Admission gate before context, not dedupe after | When Self-Evolution Backfires (2608.05810) |
| Itemized id'd bullets against context collapse | ACE (2510.04618) |
| Lessons across trials; failures are data | Reflexion (2303.11366); ExpeL (2308.10144) |
| Metrics freeze + goal audits | Goal Drift (2505.02709); Your Agent May Misevolve (2509.26354) |
| Winner's-curse holdout: report selection and held-out scores; hold-out never reused | 2610.09239 |
| Hash-chained admission gate; every edit a reviewable diff | 2610.10629 |
| Failure composition picks the lever (process vs content) | 2610.11655 |
| Role generalization; optimizer is the bottleneck; shared blind spot | 2610.12176; RHI predecessor loop (2607.15524) |
| Idea-level screening before evaluation | 2610.08993; 2610.12086 |
| Matched-budget test-time-scaling control; minimal-harness baseline | 2607.12227; 2609.40303 |
| Answer-rescue / eval-defect audit | 2610.05533 |
| Same-state incumbent-vs-revision re-run | HMED (2610.07979) |
| Re-grade unchanged anchors to catch judge drift | 2609.39958 |
| Skill scope-condition preservation | SkillPoison (2610.07645); Skill-V (2610.11781) |
| The ruler stays read-only | Reward Hacking in Self-Improving Code Agents (ikrQWGgxYg): 73.8% KernelBench / 46.8% ALE-Bench proxy-only "wins" |

## Hard rules (unchanged from the base loop)

- Never edit tests, the verifier, baselines, run logs, or model config to pass —
  the explicit ban list in the Cline and arafatkatze prompts, and the point of
  the ICLR 2026 reward-hacking result (`ikrQWGgxYg`).
- Never edit the live `~/.config/opencode/**` directly; the fleet source is the
  golden tree `install/opencode/**`, and live changes go through the sanctioned
  installer (no FORCE unless the operator says so).
- A negative result is a valid result: failures are data (ExpeL, 2308.10144);
  log it, stop early, never manufacture a gain.
- One causal axis per iteration; anneal the edit budget (prefer a single-file
  diff by iteration 3+).
- Never auto-approve a self-edit in the loop (2610.07639: auto-approve 29.2%→95.6%
  attack success; 2609.38983 approval laundering).

