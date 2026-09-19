# Open-model enforcement — pattern inventory and dispositions

**Dated:** 2026-09-19. **Work item:** W070b (proposed) — companion to
`docs/superpowers/plans/2026-09-19-open-source-model-pivot.md`. **Plugin
audited:** `opencode-workflow-guard@1.12.1`, the retired GPT-era daily-driver
guard; source read from the OpenCode package cache
(`~/.cache/opencode/packages/opencode-workflow-guard@1.12.1/node_modules/opencode-workflow-guard/`),
still loaded via `~/.config/opencode/opencode.jsonc`. **Honest-claims note:** nothing below is described
as preventing, guaranteeing, or enforcing anything new. Deny-with-redirect and
tool-expected-turn steering are behavioral nudges for the open-model pool;
kernel evidence gates remain the only authority on whether tool usage happened
where it counts.

## Why this inventory exists

The retired plugin leaned on GPT models' strong instruction-following: it told
the model what to do in prose and trusted compliance. The open-source pivot
(DeepSeek, GLM, Kimi) degrades that assumption in three concrete ways (plan §2):
thinking-mode flags, assistant-message replay, and loose JSON schemas. Every
prompt-reliant pattern is inventoried here with a disposition so no GPT-era
assumption survives unexamined.

## Disposition key

| Disposition | Meaning |
|---|---|
| `converted-1` | Replay contract moved to the per-model replay policy (`src/integrations/model-replay-policy.ts`). |
| `converted-3` | Schema looseness moved to the DeepSeek strict-schema translator (`src/integrations/deepseek-strict-schema.ts`). |
| `converted-4a` | Denial prose replaced by short imperative deny-with-redirect naming the expected tool class (`mcp-toolbox/apps/workflow-guard-mcp/src/redirect.ts`). |
| `converted-4b` | Synthetic continuation prompt replaced/complemented by bounded tool-expected-turn steering (`src/application/tool-expected-turn.ts`). |
| `kept-advisory` | Prompt text kept, honestly advisory; it must never be presented as enforcement. |
| `dropped` | Removed with no replacement (no behavior depended on it). |

## Per-pattern inventory

| # | Plugin pattern (source) | GPT-era reliance | Disposition | Notes |
|---|---|---|---|---|
| 1 | `tool.definition` appends lifecycle/subagent prose to `todowrite`, edit tools, and `task` (`src/workflow-guard.ts` `tool.definition`, lines ~664-689) | Model reads appended description and obeys the branch/read/task preconditions | `converted-3` + `kept-advisory` | DeepSeek strict schemas make the tool contract machine-checkable where it matters; the prose remains advisory for hosts without strict mode. |
| 2 | `experimental.chat.system.transform` injects the `## Workflow Guard & Operational Tools` system block (`src/workflow-guard.ts`, lines ~691-705) | Whole guidance block relied on system-role compliance | `kept-advisory` | Mirrors `src/integrations/prompt-guidance.ts` (G5), which is explicitly advisory and slims under W070b slice 4d. |
| 3 | `session.idle` → `continueUnfinishedSession` synthetic prompt with a task summary (`src/policies/continuation.ts`) | Model continues unfinished todos when nagged | `converted-4b` + `kept-advisory` | The bounded re-prompt cap (≤2) is now deterministic; the task-summary text stays advisory. |
| 4 | `guard_status` prose preconditions + `recommendedActions` (`mcp-toolbox/apps/workflow-guard-mcp/src/server.ts`) | Model reads the recommended lifecycle actions | `converted-4a` + `kept-advisory` | Denials now name the expected tool class mechanically; status keeps its advisory lifecycle prose. |
| 5 | `CIRCUIT_BREAKER_GUIDANCE` ("Stop attempting alternative workarounds…") (`src/policy.ts`) | Prose nag on repeated failure | `converted-4a` | The deterministic redirect names the expected tool class; the circuit-breaker text still appends on repeat failures for the operator-visible reason. |
| 6 | `tool.execute.before` deterministic policy enforcement (`src/workflow-guard.ts`, line ~434) | None — already deterministic | `kept` | Ported to `workflow-guard-mcp`; unchanged. Denial text tightened in slice 4a. |
| 7 | `permission.ask` hook (`src/workflow-guard.ts`, line ~622) | None — deterministic | `kept` | Ported to the ACP permission resolver; unchanged. |
| 8 | Repeated-equivalent-failure observation log after 3 identical errors (`src/workflow-guard.ts` event handler) | Model reads the log and changes approach | `kept-advisory` | Observability only; never gating. |
| 9 | Claims-vs-evidence completion audit (`src/policies/completion.ts`) | None — observability, not gating | `kept-advisory` | Already honestly advisory; kept as-is. |
| 10 | Planning-source discovery (`guard_next_tasks` over TODO/ROADMAP/PLAN) (`src/policies/planning.ts`, `src/lib/custom-tools.ts`) | Model reads discovered planning files | `kept-advisory` | Read-only discovery; no enforcement claim. |
| 11 | Project-memory recall at session start / flush at compaction (`src/integrations/project-memory.ts`) | Model uses recalled context | `kept-advisory` | Continuity is advisory; kernel state is canonical. |
| 12 | Recovery checkpoints on `chat.message` (`src/workflow-guard.ts`, line ~707) | None — bookkeeping | `kept` | Deterministic checkpoint bookkeeping; unchanged. |
| 13 | File-claims / stale-write / tamper policies (`src/policies/*.ts`) | None — deterministic | `kept` | Deterministic policies ported unchanged. |

## What changed in W070b

- **Slice 1 (replay):** `src/integrations/model-replay-policy.ts` encodes the
  per-family assistant-message replay contract; `createModelUsageProxy` applies
  it at the wire boundary (K3 stripped replay → rejected; DeepSeek synthesized
  tool-call turn via Chat Completion → diverted to the Anthropic path). This
  fixes the harness side of pattern 1/2/3; it does not make the model obey.
- **Slice 3 (strict schema):** `src/integrations/deepseek-strict-schema.ts`
  strictifies toolbox schemas for DeepSeek `/beta` and fails loudly when a
  schema cannot be represented. That failure is the signal to fix the schema.
- **Slice 4a (deny-with-redirect):** denial reasons now append a short
  imperative redirect naming the expected tool class
  (`mcp-toolbox/apps/workflow-guard-mcp/src/redirect.ts`).
- **Slice 4b (tool-expected-turn):** `src/application/tool-expected-turn.ts`
  counts no-tool turns on mutation-scoped in-progress tasks and issues at most
  two corrective re-prompts before escalating. Counters are exposed through
  `WorkflowCodingSession.toolExpectedTurnStats()` and a `status` event for
  monitor visibility. Harness steering, not a security control.
- **Slice 4c:** kernel evidence gates were **not touched** — they remain the
  strongest tool-usage enforcement that already exists.

## Composition seam and open dependency

- **Strict-schema seam:** `src/integrations/deepseek-strict-schema.ts` supplies
  the pure translator (`strictifyToolDefinitions`) and the `/beta` base-URL
  constant. Selecting that endpoint and applying the translator at request time
  belongs to the per-vendor proxy composition (W070a's `createModelUsageProxy`
  `transformBody` option and endpoint resolution); the gated golden probe
  exercises the end-to-end strict path through `/beta` today. Both branches edit
  `model-usage-proxy.ts` — W070b adds the replay check, W070a adds
  `transformBody` — so the merge must preserve both; W070b adds no further proxy
  surface.
- **`ModelProfile` dependency (open):** W070a owns the canonical `ModelProfile`
  type (`src/integrations/model-profile.ts` in its worktree). W070b consumes it
  through the thin consumer stub `src/integrations/open-model-profile.ts`, marked
  `TODO(dependency-w070a)`. On merge: delete the stub, import W070a's type in
  `deepseek-strict-schema.ts`, and re-point `deepseek-strict-schema.test.ts` from
  `profileFromModelId` to W070a's `modelProfile`. Family names differ (W070b's
  replay classifier emits `kimi-k3` and an `unknown` fallback; W070a's
  `ModelFamily` is `deepseek | glm | kimi` with no unknown). The replay policy
  classifies from the wire model id directly, so only the test helper and
  `shouldUseStrictSchemas` need reconciling.

## Post-merge reconciliation (2026-09-19, integration worker)

W070a was merged into this branch (`4157612`). Resolutions, for the record:

- **Shared proxy (`src/integrations/model-usage-proxy.ts`):** both hooks
  survive. Wire order is parse → `enforceReplayPolicy` (reject /
  route-anthropic) → Auto Router alias injection → `transformBody` (W070a
  `ModelProfile` shaping). W070b's replay check runs before shaping, so a
  rejected replay is never shaped or forwarded.
- **`ModelProfile` reconciliation (the open dependency above, now closed):** the
  `open-model-profile.ts` stub was **deleted**. W070b's replay policy now owns
  its own `ModelFamily` / `classifyModelFamily` locally (`kimi-k3` vendor name
  plus the `unknown` fallback), because it classifies from the wire id and must
  not apply a vendor contract a model did not advertise.
  `deepseek-strict-schema.ts` imports W070a's canonical `ModelProfile` from
  `src/integrations/model-profile.ts`; `shouldUseStrictSchemas` keys on the
  canonical family (`deepseek`). The `/beta` base-URL constant now lives beside
  the translator as `DEEPSEEK_STRICT_BASE_URL` (the duplicate
  `DEEPSEEK_ANTHROPIC_BASE_URL` was dropped; the canonical
  `VENDOR_DEFAULTS.deepseek.anthropicEndpoint` is the single source).
- **Strict-translator production wiring stays OPEN by design:** the metering
  proxy's upstream is fixed per provider and DeepSeek's pool entry uses the
  non-`/beta` base (`https://api.deepseek.com`), so selecting the strict
  endpoint and applying `strictifyToolDefinitions` is a per-vendor composition
  decision (a dedicated `/beta` proxy for DeepSeek, W062 territory), not a
  one-line `transformBody` change. The gated golden probe
  (`test/open-model-golden-probe.test.ts`) already exercises the end-to-end
  strict path through `/beta`.

## Golden-probe corpus (slice 6 / W062 input)

`test/fixtures/open-model-golden-probes.ts` defines one golden check set per
vendor: DeepSeek strict adherence, K3 replay integrity, GLM flag correctness.
`test/open-model-golden-probe.test.ts` verifies the corpus definitions against
the deterministic policy modules unconditionally, and runs live probes only
behind `WORKFLOW_OPEN_MODEL_PROBES=1` plus the per-vendor API-key env.

**Recorded gate state (2026-09-19):** no vendor API keys were present in the
implementation environment, so the live leg was **not run** — the honest state
is `probe-gated, unrun`. Running it (or a later W062 run) records one verdict
per vendor; an unrun or unprobed vendor stays `advisory`.
