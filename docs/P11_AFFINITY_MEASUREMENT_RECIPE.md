# P11 affinity-measurement recipe: the cache-hit comparison once the P19 pin lands

**Status: UNMEASURED / BLOCKED until a live operator run after P19 lands.**
The affinity spec (`docs/AFFINITY_ROUTING_SPEC_2026-09-24.md`) is
frontier-verified through round 3, and its honest caveat is explicit: the
cache-hit improvement is **structurally verified only** until a live-traffic
measurement (spec §5, §6; park row P11). This recipe exists; the affinity pin
(P19) does not, and the live per-pool verdicts do not. **No savings claim is
earned by this document**, and the park row stays `unmeasured`.

> **Dated note (2026-09-30, branch `feat/p11-measurement`, issue #290): P19
> LANDED (env opt-in `WORKFLOW_OPENROUTER_AUTO_AFFINITY`, PR #409) and the
> matched pair has now RUN live — one pool, one observation. Verdict
> `negative` / honest non-effect: the free-route already served one model per
> session and read the shared prefix on turn 2, while the pin to the first
> configured alias read none. The §3 method, §5 template, and §6 watch items
> stand; the pool stays `unmeasured`. Full record:
> `docs/ledger/P11-affinity-measurement.md`.**

**What this is:** the turnkey operator runbook for P11 / issue #290. It
collects, in one place, the prerequisites, the provider-side observability to
capture, the with/without-affinity comparison method, the honest caveat, the
per-pool verdict-record template, and the watch items. It mirrors the shape of
`docs/P8_LIVE_RUN_RECIPE.md` and `docs/P5_LIVE_RUN_RECIPE.md`. The measurement
pair is spec §8 item 5; the metering-trail argument is spec §6; the cost
tradeoff is spec §5. The landing record is
`docs/ledger/P11-affinity-measurement-recipe.md`.

**The question P11 asks:** once the affinity pin narrows a session's
`allowed_models` to ONE slug (the P19 mechanism, spec §8 items 1-2), does the
provider bill **cache reads** (`cache_read_input_tokens`) on the repeated
prefix that the un-pinned Auto Router free-route does not? The pin buys
provider-side prefix-cache hits that compound with the conversation (spec §5);
the job here is to **observe the cache fields on matched with/without runs and
record the delta**, not to assert one.

## 1. The prerequisites / gates

Run from the repo root. Nothing below runs until all of these hold:

| Prerequisite | State at 2026-09-30 | Why it gates P11 |
|---|---|---|
| P19 affinity pin landed | NOT started (`docs/PARKED_AND_LIMITATIONS.md:48`) | there is no pin to compare against until `affinityPin(role, tier, configuredAliases)` and the one-slug narrowing exist |
| P12 cached-token fields landed | LANDED 2026-09-27, PR #311 (`docs/PARKED_AND_LIMITATIONS.md:41`) | the cache fields must be first-class on the metrics model before they can be read; P12 is the measurement seam |
| A long-session pool opted in | operator decision (spec §5, default OFF) | affinity is intended for RSI-loop / scheduled multi-turn pools, not cheap short executor turns; the opt-in is the per-role map's flag (spec §8 item 3) |
| Live upstream credential | operator-held | the run crosses the hub metered proxy; the agent env holds only a placeholder |

The gate tokens and credential resolution are the ones the P5 recipe already
documents (`docs/P5_LIVE_RUN_RECIPE.md` §1):
`WORKFLOW_UPSTREAM_KEY` / `~/.config/workflow/upstream-key` (legacy
`CLINE_API_KEY`), the pool anchor `WORKFLOW_OPENROUTER_AUTO_ALIASES`, and the
live gate `WORKFLOW_ACP_OPENCODE_METERED=1` for the metered lane. P11 adds no
new gate token; the affinity pin is switched by the P19 opt-in surface once it
lands.

## 2. Provider-side observability to capture

The two provider fields are the anthropic wire names
`cache_creation_input_tokens` and `cache_read_input_tokens`. Workflow never
re-derives them from the wire; it meters them at the extraction seam and rides
them through the trail (W123's recorded normalization — the OpenAI lane stays
at its measured zero because cached reads ride `prompt_tokens` there).

Read, per run:

| Surface | Field | Cite |
|---|---|---|
| proxy metrics | `cacheReadTokens` / `cacheCreateTokens` | `src/integrations/model-usage-proxy.ts:96-97` |
| proxy extraction (anthropic messages lane) | `cache_creation_input_tokens` / `cache_read_input_tokens` | `src/integrations/model-usage-proxy.ts:642-654`, `:760-767` |
| per-run usage summary | `cacheReadTokens` / `cacheCreateTokens` | `src/integrations/run-registry.ts:65-66` |
| hub `/snapshot` usage block | `cacheReadTokens` / `cacheCreateTokens` | `src/cli/hub-snapshot.ts:37` |
| timeline usage row | cache segment (nonzero mass only) | `src/integrations/activity-timeline.ts:147-148` |

The first marked request can only show **creation** (the provider has not yet
seen the prefix); a **read** needs a second request carrying the same prefix.
So the smallest honest unit is **at least two turns** with a shared stable
prefix, not one request.

## 3. The with/without-affinity comparison method

The comparison is a **matched pair**: the same pool, the same model family,
the same multi-turn prompt shape, once with the pin OFF (the free-route
baseline) and once with the pin ON (the pinned session). Compare only the
cache fields, turn over turn.

```text
# Arm "without" - the baseline. Affinity OFF (the default). Two turns sharing
# a stable prefix; the un-pinned Auto Router free-routes each request.
<launch the opted pool session with the affinity opt-in OFF>
  turn 1: record cacheCreateTokens / cacheReadTokens
  turn 2: record cacheCreateTokens / cacheReadTokens   <- the read turn

# Arm "with" - the pinned session. Affinity ON once P19 lands (the opt-in flag
# on the role->model map); the allowed_models list is narrowed to ONE slug, so
# consecutive turns hit the SAME serving vendor.
<same pool, affinity opt-in ON>
  turn 1: record cacheCreateTokens / cacheReadTokens
  turn 2: record cacheCreateTokens / cacheReadTokens   <- the read turn
```

Read the **turn-2 read mass**: the pinned arm's `cacheReadTokens` against the
baseline arm's. A pinned arm with repeated nonzero `cacheReadTokens` where the
baseline shows none is the affinity effect; equal-or-zero on both is an honest
non-effect. Record the concrete resolved slug per arm (alias drift is real —
P5's watch item), the model id, and the endpoint.

**Minimum for an honest reading:** both arms run the same day against the same
upstream, with at least two turns each and a shared stable prefix; one
observation is not a rate. Do not compare a pinned turn against a baseline
turn with a different prefix.

## 4. The honest caveat

- **Structural verification only until the live run — no savings claim
  before.** The spec's verification argument (spec §6) proves only that the
  RECORDING mechanics are unaffected by affinity (which slug is requested
  changes; no second metering path; every request still records through the
  fixed four-field projection). It does NOT prove a cache hit, a token
  reduction, or a dollar saving. The savings stay `unmeasured` (spec §6, park
  row P11) until the matched-pair run above records them.
- **P12's field existence is met; the effect is not.** P12 landed the
  `cacheReadTokens` / `cacheCreateTokens` fields (2026-09-27, PR #311), so the
  blind spot that made the caveat load-bearing is now closed — the fields
  exist and the timeline renders them. What is still absent is the
  **measurement**: the fields can be read, but no with/without run has read
  them. State that distinction; do not let "P12 landed" read as "savings
  proven."
- **The trail's content is vendor-keyed even when recording is not.**
  Narrowing to one slug changes which lane/vendor shapes the numbers and cost
  (spec §6). A cache field is observability, never enforcement; a green
  measurement makes no authority claim.
- **Headroom is required for the comparison to mean anything.** Short
  sessions have almost no repeated prefix to save and lose under the pin
  (spec §5); a low-prefix run showing no delta is not evidence against
  affinity.

## 5. The verdict-record template (per-pool rows)

P11 is **not a gated probe file**, so there is no `docs/PROBE_VERDICTS.json`
row (the P5 recipe's case, not the P8 register case). The record lands as a
dated note in this recipe's ledger fragment or `docs/PARKED_AND_LIMITATIONS.md`,
in the dated prose style of `docs/HOST_ADAPTERS.md`. One row per pool measured:

```markdown
| Pool (role/tier) | Arm | Resolved slug | Turn | cacheCreate | cacheRead | Verdict |
|---|---|---|---|---|---|---|
| <RSI loop / strong> | without (free-route) | <slug or alias> | 1 / 2 | N / M | N / M | baseline |
| <RSI loop / strong> | with (pinned) | <pinned slug> | 1 / 2 | N / M | N / M | <green/negative/blocked> |
```

Result mapping (the operator decides; keep the pool `unmeasured` if
ambiguous):

| Observed | Pool verdict | Savings |
|---|---|---|
| both arms metered; pinned turn-2 `cacheReadTokens` > baseline | `green` | a measured read delta **for the observed prefix/pool** — still no fleet-wide claim |
| both arms metered; pinned read mass equal to baseline (zero or not) | `negative` | stays `unmeasured`; record the non-effect |
| run not metered / pin absent / credential missing / not run | `blocked` (`unmeasured`) | stays `unmeasured` |

A partial run (for example one pool) records only that pool; it never widens a
`green` to pools it did not measure. Update the P11 row's verification status
only when the observed delta is recorded, and append the dated note — never
rewrite the row's history.

## 6. Watch items

- **The W109 prefix-policy gap — the pin saves the static prefix only.**
  Affinity without the per-turn boundary policy saves the static head
  (system block + last tool definition); the growing conversation is the
  segment W109's breakpoint-policy gap leaves uncached (spec §5's honest
  asymmetry; P13 is the governor). A measured delta under the minimal slice is
  the **static-prefix** saving, not the full long-conversation saving. Do not
  extrapolate the delta to the growing mass until the per-turn boundary policy
  is governed (P13).
- **P19's pin semantics are operator-open.** The pin's inputs (per-role vs
  per-session) and the restart/alias-drift semantics are spec §9 decisions
  still open. Record which semantics the run used: a per-role pin concentrates
  a whole role on one vendor (load concentration, maximal cross-session
  reuse); a re-pin under alias drift can silently invalidate the cache state
  the pin protects.
- **The resolver can fail open to no injection.** An unhealthy/unresolvable
  alias pool makes the pin silently ABSENT and Auto Router free-routes (spec §8
  item 4). Confirm the injected `allowed_models` list actually narrowed to the
  single pinned slug before reading the delta; a free-routed "pinned" arm is
  not the treatment.
- **Alias pointers drift; resolution is not deterministic across days.** Read
  the concrete `alias_target.slug`, not just the alias (P5's watch item).
- **Observability, not enforcement.** Even a green measurement caps at
  `advisory`: it records what the cache fields did on matched runs and makes
  no authority claim; it does not enable, disable, or validate any routing
  behavior.

## 7. Boundaries

- Docs-only runbook. No live call is made by this document or its tests; the
  live per-pool verdicts remain the operator's.
- P11 / issue #290 stays OPEN and the row stays `unmeasured` until the
  operator's dated verdict. The affinity implementation (P19) stays parked;
  the measurement cannot run before it lands.
- The W109 per-turn boundary policy (P13) is a separate governor; P11 records
  the static-prefix delta honestly and does not claim the growing mass.
- Sanity: `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).
  State not applicable (docs-only; no code path).
