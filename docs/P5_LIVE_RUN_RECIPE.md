# P5 live-run recipe: the per-role fleet end-to-end check (W095 c2)

**Status: UNRUN until a live operator run.** The design note
(`docs/MODEL_ROUTING_POLICY_2026-09-23.md`) is frontier-verified through
round 3; the W095 criterion-2 check ("the fleet's per-role models verified
end-to-end (the de-facto MoE) before building anything new") has **no live
verdict**. Nothing here earns a routing claim by existing. The per-role
capability stays `structural-only` / unmeasured until the operator runs the
sequence below and records the dated result (probe-gated, never date-gated).

**What this is:** the turnkey operator runbook for P5 / issue #284. It
collects, in one place, the env/credential gates, the exact per-role
commands, what to observe per role, the verdict-record templates, and the
watch items. It mirrors the shape of `docs/P8_LIVE_RUN_RECIPE.md`. The
routing position is `docs/MODEL_ROUTING_POLICY_2026-09-23.md` (W095's
criterion-1 note); the landed seam is W109 (`transformBody` +
`composeBodyTransforms`); the fleet assets are `assets/opencode-fleet/`.

**The question P5 asks:** does the **real fleet path** resolve each of the
four roles (`decompose`, `executor`, `reviewer`, `retrospective`) to its
intended model tier and complete a **real turn** through the hub's metered
proxy? Today the honest answer is: **there is no role→model map.** Per the
design note §1, no mechanism assigns a model per role. The composition
anchor today is the per-runtime **`autoLatest.aliases`** option
(`WORKFLOW_OPENROUTER_AUTO_ALIASES`), which constrains OpenRouter's Auto
Router pool; a role's session runs the composed default (`openrouter/auto`,
or the open-source pool's first entry when composed) unless the operator
picks a pool model in the session's model picker. So this recipe verifies
what the fleet path **actually does** — the composed default, the operator's
per-session selection, the metered turn — and records the gap honestly. It
does not manufacture an automatic per-role assignment that does not exist.

## 1. The env / credential gates

Run from the repo root. Nothing below runs without the operator's gate
tokens; an unset gate skips (or throws on the key load) rather than guessing.

**The upstream key** (resolves in this order — `test/cline-probe-helpers.ts`):

```bash
# Canonical (wins):
WORKFLOW_UPSTREAM_KEY=sk-...          # or ~/.config/workflow/upstream-key (0600)
# Legacy (accepted):
CLINE_API_KEY=sk-...                  # or ~/.config/workflow/cline-api-key (0600)
# Explicit file:
CLINE_API_KEY_FILE=/path/to/key
```

**The pool anchor** (the role→model stand-in — `src/integrations/openrouter-auto-latest.ts`):

```bash
# Override the per-runtime Auto Router alias pool (comma/space separated).
# Unset => DEFAULT_AUTO_LATEST_ALIASES. Only honored for OpenRouter upstreams.
WORKFLOW_OPENROUTER_AUTO_ALIASES="~anthropic/claude-sonnet-latest ~deepseek/deepseek-flash-latest ..."
WORKFLOW_OPENROUTER_AUTO_LATEST=off   # disable the seam entirely
WORKFLOW_OPENROUTER_AUTO_COST_TIER=low   # optional cost band
```

**The live gates:**

| Gate | Arms | Purpose |
|---|---|---|
| `WORKFLOW_ACP_REAL=1` | `test/acp-real-probe.test.ts` | a real read-only turn on the ambient ACP surface (transport legality) |
| `WORKFLOW_ACP_OPENCODE_METERED=1` | `test/acp-opencode-metered-probe.test.ts` | the turn crosses the hub metered proxy and records usage (metering proof) |

Optional overrides: `WORKFLOW_ACP_UPSTREAM` (default `https://openrouter.ai`),
`WORKFLOW_OPENCODE_MODEL` (explicit model override), `WORKFLOW_OPENCODE_BIN`.

## 2. The run

Two arms. Arm A (the fleet path) is what P5 measures; Arm B is the
transport/metering proof borrowed from the existing gated probes.

**Preflight — install the fleet and confirm it is current:**

```bash
workflow install fleet      # W086: writes the four role agents + commands
workflow doctor             # fleet drift + hub/probe verdict state
```

**Arm A — the per-role fleet turn (manual, the real path).** Launch the ACP
surface with the pool anchor set, then invoke each role's command in its own
session. Roles are OpenCode subagents; there is **no per-role model binding**,
so select the intended tier's pool model in the model picker for the role's
session (the de-facto MoE, operator-manual):

| Role | Tier (design note §2) | Command / invocation | Select in picker |
|---|---|---|---|
| `decompose` | strong | `/decompose <task>` | a strong pool alias |
| `executor` | cheap | delegated by `/rsi-loop` step 3 (or direct `executor` subagent with a spec) | a cheap pool alias |
| `reviewer` | strong | `/review-diff` | a strong pool alias |
| `retrospective` | cheap | `/retro <session notes>` | a cheap pool alias |

```bash
# One live surface, pool anchor composed, the operator's key exported (above):
WORKFLOW_OPENROUTER_AUTO_ALIASES="~anthropic/claude-sonnet-latest ~deepseek/deepseek-flash-latest" \
  workflow-tui --driver acp      # or: workflow  (browser operator UI)
```

**Arm B — the metered/transport proof (gated, existing probes):**

```bash
# Transport legality: a real read-only turn on the live ACP surface.
WORKFLOW_ACP_REAL=1 \
  node --import tsx --test test/acp-real-probe.test.ts

# Metering proof: the turn crosses the hub proxy; the agent env holds only a
# placeholder credential while the proxy injects the real upstream key.
WORKFLOW_ACP_OPENCODE_METERED=1 \
  WORKFLOW_ACP_UPSTREAM=https://openrouter.ai \
  node --import tsx --test test/acp-opencode-metered-probe.test.ts
```

There is **no dedicated per-role probe** in the tree. Arm B proves the lane
(legality + metering); Arm A supplies the per-role identity and the resolved
model. Stated plainly so a green Arm B is never read as a per-role verdict.

## 3. What to observe per role

Record, per role: **the role→model resolution** and **a real turn**.

**The role→model resolution (request-side).** Read which concrete model the
role's session carried:

- the session's ACP model/mode picker (`availableModels` / `configOptions`
  from `session.new`, `src/adapters/acp-subprocess.ts:135-150`) — the pool
  the hub composed;
- the hub-written OpenCode config's selected `model`
  (`meteredOpencodeConfig`, `src/integrations/opencode-agent-config.ts:91-160`)
  — the composed default (`openrouter/auto`, or the open-source pool's first
  entry when composed);
- the proxy's recorded request `model` (`model-usage-proxy.ts` metrics) — the
  model actually forwarded after the `allowed_models` pool injection.

Honest expected observation: with no role→model map, **every role resolves to
the same composed default** unless the operator picked a pool model in that
session. That sameness is the finding, not a failure.

**A real turn (response-side).** The turn must complete (`stopReason:
"end_turn"`, not `"probe_timeout"`) with non-empty output; the proxy must
record `requests > 0`, `usageEvents > 0`, `totalTokens > 0` for the session
(the `acp-opencode-metered-probe` assertion shape). A green Arm B only
requires the lane to work; it does **not** require the resolved model to match
the intended tier — that match is the live finding you record.

## 4. The verdict-record templates

Record in two layers, together (the register keeps docs and runtime claims
from drifting). **P5 is not a gated probe file**, so there is no
`docs/PROBE_VERDICTS.json` row here; the record lands as a dated note in the
W095 design note / P5 ledger fragment, in the dated prose style of
`docs/HOST_ADAPTERS.md`.

**a. The per-role rows** (paste into the dated write-up):

```markdown
| Role | Command | Resolved model (slug) | Turn (stopReason) | Metered (req/tokens) | Verdict |
|---|---|---|---|---|---|
| decompose | /decompose | <slug or "composed default: openrouter/auto"> | end_turn | N / M | <green/negative/blocked> |
| executor | /rsi-loop step 3 | ... | ... | ... | ... |
| reviewer | /review-diff | ... | ... | ... | ... |
| retrospective | /retro | ... | ... | ... | ... |
```

Result mapping (the operator decides; keep the item `unrun` if ambiguous):

| Observed | Row verdict | W095 c2 |
|---|---|---|
| real turn completes, metered, resolved model recorded | `green` | tick-eligible **for what was observed** (composed default / operator pick) |
| turn completes but resolved model absent/unrecorded | `negative` | stays open |
| turn times out / not metered / no credential | `blocked` | stays open |
| not run / ambiguous | `blocked` (unrun) | stays open |

**b. The dated write-up** (append to `docs/MODEL_ROUTING_POLICY_2026-09-23.md`
as a §9 note, or to the P5 ledger fragment — append-only, never rewrite).
One entry per run, HOST_ADAPTERS prose style:

```markdown
**<YYYY-MM-DD> (W095 c2 per-role fleet e2e - live on <surface>, <agent kind/version>):**
`workflow install fleet` deployed the four role agents; the live ACP surface ran
with `WORKFLOW_OPENROUTER_AUTO_ALIASES="<pool>"`. Per role: <decompose/executor/
reviewer/retrospective> ran `<command>` in its own session; the session resolved
to <slug / composed default>, the turn completed (`stopReason: end_turn`), and the
metered proxy recorded <N requests / M tokens>. Observed: <all roles on the
composed default / operator-selected pool models per role>. Verdict: <green for
what was observed / negative / blocked>. The role→model map does NOT exist, so
this witnesses the operator-manual fleet path, not an automatic per-role
assignment; W095 c2 <ticks for the observed path / stays open>.
```

After the first verdict, tick the W095 criterion-2 checkbox in `TASKS.md`
(with the dated evidence link) **only** if the run witnessed each role's turn
end-to-end; otherwise leave it open and narrow the note, never silently widen
a partial run.

## 5. Watch items (the W095 c2 criterion)

- **No role→model map exists — the criterion is narrower than it sounds.**
  W095 c2 says "the fleet's per-role models verified end-to-end." With no
  map (`docs/MODEL_ROUTING_POLICY_2026-09-23.md` §1), the run can only witness
  the composed default plus the operator's per-session pick. An automatic
  per-role assignment cannot be verified before it is built (key-1's map is
  the successor, P19, itself CONDITIONAL on W095 key-1). Record the
  distinction; do not tick c2 as if role routing were automatic.
- **Aliases drift; resolution is not deterministic across days.** `~...-latest`
  pointers resolve server-side (`alias_target.slug`); a renamed/retired alias
  or the OpenRouter "Prevent overrides" toggle ON can make the pool unhealthy
  and requests fail `404 No models match`. Record the concrete slugs resolved
  at run time, not just the alias.
- **`allowed_models` matches concrete catalog IDs only.** The autoLatest seam
  resolves the aliases to slugs and injects them; an empty/unhealthy pool
  collapses the request. Confirm the proxy injected the pool it was given.
- **The composed default is `openrouter/auto`** unless the open-source pool is
  composed (its first entry wins) or `WORKFLOW_OPENCODE_MODEL` overrides. Do
  not attribute the Auto Router's own choice to a role mapping.
- **Observability, not enforcement.** Even a green run makes no authority
  claim and does not enable any routing behavior. It records what the fleet
  path resolved to and that the turn was metered.

## 6. Boundaries

- Docs-only runbook. No live call is made by this document or its tests; the
  live verdict remains the operator's.
- P5 / issue #284 stays OPEN until the operator's dated verdict. The role→model
  map (W095 key-1) and the affinity implementation (P19) stay parked.
- Sanity: `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).
  State not applicable (docs-only; no code path).
