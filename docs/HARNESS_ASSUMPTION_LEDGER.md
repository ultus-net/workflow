# Harness Assumption Ledger (W057)

**Created:** 2026-09-19. **Status:** living record, append-only. **Owner:** operator
(release gate); component owners named per row.

Every harness scaffolding component encodes an assumption about what the model
cannot do reliably on its own (Anthropic, "Harness design for long-running
application development", 2026-03-24 — `docs/AI_LANDSCAPE_RESEARCH.md` §3.2).
Those assumptions expire as models improve. This ledger makes the assumptions
explicit, names their current evidence, and fixes the operator-invoked
procedure for testing whether a component can be stripped at a pinned-agent
version bump.

Honesty rules for this ledger:

- **Scaffolding only, never enforcement.** The audit here removes *model-facing
  scaffolding* — prompt text, advisory injections, reviewer-persona presence,
  style/gating ergonomics. It never removes or weakens enforcement: kernel
  state transitions, `WorkflowApplication` authorization, capability
  withholding, the guard policy corpus, containment, and the review *gate* are
  not harness assumptions and are not audit candidates.
- **No claim changes.** Nothing here upgrades or downgrades any surface's
  `advisory`/`enforced` status. Removing a scaffolding component cannot change
  an enforcement claim; probes and `docs/HOST_ADAPTERS.md` remain the source of
  truth.
- **Operator-invoked, never automatic.** The audit is *available* at every
  pinned-agent version bump and is run *only* when the operator requests it. A
  version bump without the audit is still allowed; the required probe re-runs
  are unchanged.
- **Numbers, not impressions.** A keep/strip decision is recorded with the cost
  and quality deltas that produced it, the model/version, and the date.

## Ledger of current harness scaffolding

| Component | Where | Assumed model weakness | Current evidence | Owner |
| --- | --- | --- | --- | --- |
| Per-turn advisory guidance injection | `src/integrations/prompt-guidance.ts` (`buildAdvisoryGuidance`, `advisoryGuidanceFromEnv`), prepended by the scheduler (`src/integrations/hub-scheduler.ts` at `configured prompt guidance is prepended to every scheduled prompt`) | The model does not reliably infer operator style/operating preferences from the task and needs them restated each turn | Composition and silence-when-unset pinned by `test/g5-observability.test.ts` (`buildAdvisoryGuidance composes optional advisory blocks and stays silent when empty`); no measured quality or cost effect | Hub/control-plane integrator |
| Project-memory recall injection | `src/integrations/project-memory.ts` (`formatMemoryRecall`), injected into the Cline system prompt and flushed post-run (`src/integrations/cline-runtime.ts`) | Durability across compaction/sessions is lost without a bounded recall block; the model cannot recall prior decisions unaided | Bounded, provenance-tagged block pinned by `test/project-memory.test.ts` (`formatMemoryRecall renders a bounded, provenance-tagged prompt block`); 2,000-char cap; no measured quality effect | Integrations / compaction bridge |
| Response/build-style prompt addendum | `src/integrations/response-style.ts` (`stylePromptAddendum`), appended to the system prompt | Default model output is verbose and over-builds; a style instruction changes it | Addenda pinned by `test/response-style.test.ts` (`caveman speech style demands terse, stripped speech but keeps summaries`, `normal styles produce no addendum and no token cost`); cost measured by the `npm run style:eval` harness (`docs/FEATURES.md`: "Style-savings measurement"); no recorded run of record yet | Integrations / session style |
| Guard denial verbosity (model-facing reason text) | Guard verdict `reason`/`policy` surfaced to the model and journals (`src/integrations/mcp-toolbox-guard.ts`, `guard_check` description in `mcp-toolbox/apps/workflow-guard-mcp/src/server.ts`; denial records in `src/integrations/cline-session.ts`) | A bare denial invites retries or misreads the boundary; the model needs the failed policy named | Deny-reason propagation pinned by `test/acp-workflow-resolver.test.ts` (`ACP resolver consults the guard after kernel authorization and denies on guard policy`); guard corpus `npm run toolbox:verify`; no measured retry-rate effect | Guard / security owner |
| Sprint/eligibility gating | Kernel readiness derivation (`src/kernel/task-graph.ts`) plus active-task correlation gating mutations (`src/application/workflow.ts`, `src/application/task-commands.ts`, `src/cli/driver-registry.ts`) | The model selects ineligible work, self-unlocks dependencies, or mutates while blocked unless the harness derives eligibility itself | Readiness derivation pinned by `test/task-graph.test.ts` (`readiness is derived from dependency verification`); blocked-work denial pinned by `test/application.test.ts` (`blocked canonical task cannot mutate while its eligible dependency can`); gating is enforcement (not an audit candidate) — only the *prompt/UX scaffolding* around it is | Kernel/application owner |
| Evaluator presence (separate skeptical reviewer) | Review control plane (`src/review/`, `src/integrations/hub-reviewer.ts`); review-gated runs in `src/integrations/run-registry.ts` | Models confidently praise their own work; self-evaluation is unreliable, so a separately prompted evaluator is needed | Cross-run/anti-rubber-stamp rules pinned by `test/hub-review.test.ts` (`a review from the same run is rejected (anti-rubber-stamp)`); the review *gate* is enforcement — only the evaluator persona/prompt scaffolding is auditable | Review control-plane owner |
| Prompt-mode pedagogy scaffolding | `src/pedagogy/primm.ts` (`primmScaffold`, `fillInTheGap`) | The model defaults to handing over answers instead of guiding a learner through predict/run/investigate/modify/make | Deterministic stage order/content pinned by `test/pedagogy-primm.test.ts` (`primmScaffold returns one prompt per PRIMM stage in order`); no measured learning or cost effect | Pedagogy owner |

Component list is dated to this revision; add rows in dated supersession
entries rather than editing history. "Where" citations use the repository at
the ledger date.

## Model-bump audit procedure (operator-invoked)

**When:** available at every pinned-agent version bump, and on explicit
operator request at any time. **Run only on request — never automatically, and
never as a silent part of a bump.** A bump still requires its probe re-runs
(`docs/HOST_ADAPTERS.md`); this audit is an additional, optional lever.

**Preconditions**

1. Operator invokes the audit and names the pinned agent version and model.
2. Pick a fixed, representative task set (the same tasks for baseline and
   variants) and a frozen evaluation prompt.
3. Confirm the candidate component is scaffolding, not enforcement (see the
   honesty rules above). If removing it could change an enforcement claim,
   stop — that change goes through the probe gates.

**Per component (one at a time, never more)**

1. **Baseline.** With the full harness, record cost (input/output tokens and
   dollars from the metering proxy or `npm run style:eval`) and quality
   (acceptance-criteria pass/fail, test/review evidence) on the fixed set.
   Note the model, pinned version, date, and sample size.
2. **Strip one.** Disable exactly one component using an existing switch (env,
   config, or a local code toggle — never a multi-component change).
3. **Measure.** Re-run the identical set. Record the same cost and quality
   metrics and the delta. State the sample size: `npm run style:eval` is N=1
   per style and a smoke indicator, not a benchmark (model variance is high).
4. **Decide.**
   - **keep** — the assumption still holds; restore the component.
   - **strip** — the assumption has expired; remove the component from the
     default harness in a normal reviewed change.
   - **keep-but-narrow** — retain only for a task/risk class where it still
     pays; record the class.
5. **Record.** Append a dated entry to the "Audit log" below with: component,
   model/version, task set, baseline vs stripped numbers, quality delta, and
   the keep/strip/narrow decision. Raw outputs go under the
   `docs/superpowers/` evidence convention.
6. **Restore the baseline** before touching another component.

**Cost/quality measurement surfaces available today**

- `npm run style:eval` — per-style output-token deltas on a fixed prompt
  (`src/cli/style-eval.ts`; `docs/FEATURES.md` marks it Complete). Smoke-grade.
- The metering proxy's per-run usage records (`src/integrations/model-usage-proxy.ts`)
  for token/cost accounting on real tasks.
- Review verdicts and test evidence for the quality axis — shape-checked, not
  truth-checked; treat the reviewer's verdict as one signal.

### Worked example (illustrative)

> **Illustrative only.** No audit run exists in the repository yet, so the
> numbers below are placeholders showing the record *shape*. They were not
> produced by a real run and must not be cited as evidence. Replace them with
> the raw `npm run style:eval` output on the first operator-run audit.

Component: response/build-style prompt addendum. Model: (pinned version at
audit time). Task set: the `style:eval` fixed prompt, N=1 per style.

```text
npm run style:eval -- "Implement the smallest possible fix for the typo in README and summarize the change."
```

| Variant (stripped component) | Output tokens (placeholder) | Output Δ vs baseline (placeholder) | Quality (placeholder) |
| --- | --- | --- | --- |
| baseline (full harness) | 0000 | — | criteria pass |
| style addendum removed | 0000 | 0% | criteria pass |

Decision (placeholder): **keep** — the illustrative delta is within N=1
variance, so the addendum stays until a larger-N run shows a real cost win with
no quality loss. Real decisions must carry the actual numbers plus the model
version and date in the audit log.

## Audit log (append-only)

No operator-run audits recorded as of 2026-09-19. Add dated entries below; do
not edit prior entries.

<!-- Format:
### YYYY-MM-DD — <component> @ <agent> <version>
- Task set: ...
- Baseline: cost ..., quality ...
- Stripped: cost ..., quality ...
- Decision: keep | strip | keep-but-narrow (<rationale + numbers>)
- Raw evidence: docs/superpowers/...
-->

## Version-bump wiring

`docs/HOST_ADAPTERS.md` probe rules reference this ledger: the audit is
available on every pinned-version bump but is operator-invoked, never
automatic, and never a substitute for the probe re-runs.
