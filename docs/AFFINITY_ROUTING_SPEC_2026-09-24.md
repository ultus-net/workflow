# Affinity routing spec — the W095 key-1 modifier (W098 c3)

**Status:** position recorded 2026-09-24; implements the "specced as a
W095 key-1 modifier" half of W098 criterion 3. CONDITIONAL: the spec
presumes W095 key-1's role→model map — which does NOT exist yet (see
§3, the prerequisite). Verification: the rounds are recorded in §10.
Companion reading: `docs/MODEL_ROUTING_POLICY_2026-09-23.md` (the four
routing keys and the no-mid-stream rule), the W098 position, W109 (the
cache-marker opt-in and its dark lane).

## 1. The problem this spec closes

OpenRouter's Auto Router optimizes PER REQUEST: each request may land on
a different vendor in the resolved pool. Provider-side prompt caches key
on the longest shared token prefix **at a specific provider AND model** —
a bounce loses the cache state, so every turn of a long session re-pays
the full prefix at whatever vendor/model the router picked that turn. On
the W098 position's own terms this is the failure mode: "Auto Router may
bounce providers per request, losing cache state."

W098's recorded answer: **model affinity as a routing key modifier** —
pin consecutive turns of a session to the same vendor/model so the
provider-side caches actually hit. This spec makes that answer concrete
against the seams that exist today — and names what does not exist yet.

## 2. Terminology (defined on first use, per the routing doc's round-1 lesson)

- **Pool** — in this spec, the Auto Router resolved pool: the concrete
  slug list `openrouter-auto-latest.ts` resolves from the configured
  `~...-latest` aliases and injects into Auto Router's `allowed_models`.
  (The `open-source-pool.ts` substrate for no-key families is a
  different surface — see §3, where it needs no work.)
- **Pin granularity:** the per-request bounce survives FAMILY-level
  narrowing. The default pool carries MULTIPLE aliases per family
  (anthropic ×4, openai ×5, google ×2, deepseek ×3, z-ai ×2 —
  `openrouter-auto-latest.ts:34-53`), and provider caches key per
  provider+model: narrowing to a family still lets Auto Router bounce
  among that family's models per request. **The pin therefore narrows to
  ONE SLUG** — the first resolved slug in configured-alias order —
  not "the family's models".

## 3. The modifier's shape (the one rule, corrected)

> **Key-1 affinity: when the role's pool resolution produces a concrete
> slug list, the session's requests narrow to ONE slug of that list —
> the first slug in CONFIGURED alias order — kept for the session's
> lifetime (re-pins only at turn boundaries).**

- **The pin is per-(role, tier, settings), NOT per-session.** Every
  session of the same role resolves to the same slug. This is the
  honest base: it is deterministic and restart-stable, and cross-turn
  cache reuse follows for every session of the role. The load
  concentration consequence is recorded in §9; the per-session pin
  variant is an operator question (§9) and would need session identity
  as a pin input (the composition path does not carry one today).
- **Conditional on W095 key-1.** The composition-time seam this
  modifier needs — a role→model map in the hub-written agent config —
  does not exist yet: `opencode-agent-config.ts` composes ONE model per
  launch today, and the routing design note records the map in future
  tense ("gains a role→model map"). What exists TODAY at this seam is
  the per-runtime `autoLatest.aliases` option — the configured alias
  order is the pin's only existing input. The affinity implementation
  lands WITH or AFTER key-1's mechanism; until then this spec is the
  recorded design.
- **Never mid-stream.** The routing policy's rule ("a mid-stream model
  switch never happens") holds; the narrowing is a composition-time
  choice exactly like the role assignment it modifies.
- The implementation home: `openrouter-auto-latest.ts`'s pool resolution
  — the resolved list is filtered to ONE slug before the
  `allowed_models` injection. (The open-source-pool lane needs NO work:
  it is already maximally pinned — one family per proxy, one composed
  model per launch. The topology-daemon surface wires no autoLatest
  option into its proxy, so this spec's surface coverage is the
  OpenRouter-lane proxies; recorded as a coverage note.)

## 4. Precedence, and the honest dependency on unbuilt keys

The design note's precedence is role → budget → schedule → failover.
Affinity is a **narrowing WITHIN key 1**; it binds BEFORE the other keys
act and yields to them:

- **Budget (key 2)** downgrades into the cheap tier — a downgrade leaves
  the pinned slug's tier, so affinity re-pins at the new tier (a turn-
  boundary event, logged). Key 2's consumer itself is queued (P15).
- **Failover (key 4)** is the yield-to case — and the dependency must
  be stated: **key 4 is NOT wired** (zero callers; no-key families are
  skipped, not rerouted — the routing doc's round-2 correction). Today
  the yield-to target does not exist; moreover, narrowing
  `allowed_models` to one slug REMOVES OpenRouter's own cross-vendor
  reroute for that session. **The outage cost is therefore
  session-persistence: a pinned vendor's outage lasts until the turn
  boundary — and with no wired failover, potentially the whole
  session.** That is the sharpest cost of the pin and it belongs in the
  tradeoff ledger, not a footnote.
- **Schedule (key 3)** composes with affinity (an off-peak pool's own
  pin).

A mid-stream model switch never happens; every re-pin lands at a turn
boundary.

## 5. The cost tradeoff (recorded, honestly two-sided — including the outage persistence)

- **Given up:** Auto Router's per-request optimization (live pricing,
  latency, vendor-health routing inside the pool) AND, via the one-slug
  narrowing, OpenRouter's own cross-vendor reroute for the session. A
  pinned vendor's degradation persists for the session — today there is
  NO wired failover backstop to rescue it (key 4 unwired), only the
  turn-boundary re-pin.
- **Bought:** provider-side prefix-cache hits that compound with the
  conversation. Long sessions with large repeated prefixes win; short
  sessions lose (almost no repeated prefix to save).
- **Therefore affinity is opt-in per pool/role, default OFF**, with the
  intended opt-in surfaces being the long-session pools (RSI loop
  sessions, scheduled multi-turn runs) — NOT the short cheap-pool
  executor turns. The settings axis is the per-role model map's landing
  (key-1 prerequisite), not a new mechanism.
- **Honest asymmetry (the W109 composition):** the growing conversation
  is ALSO the segment W109's breakpoint-policy gap leaves uncached (the
  minimal slice marks the static head only) — affinity without the
  per-turn boundary policy saves the static prefix only. The two items
  compose; the savings estimate must not claim the growing mass until
  that gap is governed (P13).

## 6. The metering trail: recording unaffected, content varies (the corrected verification argument)

**Mechanics — verified unaffected:** affinity changes which slug is
requested; it composes at the autoLatest `allowed_models` injection
(the pre-existing deviation on the OpenRouter lane — NOT the W109
`transformBody` seam, which landed on the vendor-proxy lane and is a
different stage), adds no second metering path, and every request still
records usage through the fixed four-field projection (the
model-usage-proxy metering trail — the W044-surfaced G1 metrics).
Transforms run pre-forward; SSE passes through untouched; no mid-stream
switch exists — the recording mechanics are unaffected by construction.

**Content — honestly caveated:** the trail's CONTENT is lane/vendor-keyed
even though recording is not. The anthropic messages lane reaches
`recordUsage` with OpenAI-shaped extraction and can pollute the trail
with zero-token events (the W109 gap-1 lesson: the trail is polluted,
not absent); direct vendor lanes carry no `cost` field. Narrowing the
pool to one slug changes WHICH lane/vendor shapes the trail carries for
the session. On the OpenRouter lane the FIELD shape stays OpenRouter's
regardless of which underlying vendor serves — what varies is the
serving vendor and the trail's numbers/cost. "Verified unaffected" therefore scopes to the RECORDING
mechanics; the trail's per-vendor content variance is the W109 pollution
class, and P12's cached-token fields land on the governed lane only.
The savings remain `unmeasured` (park file L1/P11) until P12 + P9.

## 7. What affinity does NOT do

- No mid-stream switch (the design note's rule holds verbatim).
- No override of budget/failover keys (it yields and re-pins) — and no
  reliance on key 4 until it is wired.
- No change to the metering pass-through posture, the credential
  custody model, or the containment composition.
- No new provider API surface (it reuses `allowed_models` narrowing and
  the composed `model` field — both exist today).

## 8. Implementation sketch (a future iteration, not this one)

1. The sticky resolution: a pure function `affinityPin(role, tier,
   configuredAliases) -> slug` — deterministic, testable, logged at pin
   and re-pin events. Inputs are (role, tier, settings) — NOT session
   identity; see §9's open question before changing that.
2. The narrowing: the resolved-pool list is filtered to the pinned slug
   before the `allowed_models` injection (the OpenRouter lane).
3. The settings axis: a per-role/per-pool opt-in flag on the role→model
   map when key-1's map lands (default off).
4. Pins: the determinism pin (same configured aliases → same slug); the
   DEGRADED-RESOLVER pin (unresolvable aliases reorder the list — the
   pin follows configured order, not resolved order, so a partial
   catalog outage changes which slug is pinned rather than silently
   reordering; and the resolver's fail-open to `[]` means no injection
   happens at all — the pin is then silently ABSENT and Auto Router
   free-routes: pinned, logged as a degradation event); the re-pin pins
   (budget downgrade → new pin); the narrowing pin (the injected list
   contains exactly one slug); the unchanged-metering pin.
5. The measurement pair (P11): P12's cached-token fields must land
   before any cache-savings claim; the affinity effect is unmeasured
   until then.

## 9. Open questions for the operator

- **The pin's inputs — per-role or per-session?** As specced: per-(role,
  tier, settings) — deterministic and restart-stable, but every same-
  role session pins the SAME vendor (load concentration on one vendor
  across the whole fleet-role; also maximal cross-session cache reuse).
  The W098 wording says "consecutive turns of a session", which reads
  per-session — but session identity does not exist at the composition
  seam today. Adding session identity as a pin input costs the restart-
  determinism property (a restart re-pins; the provider cache state
  survives on the provider side anyway — the pin's value is turn-to-turn
  within a live session, not across restarts). DECISION NEEDED: per-role
  (deterministic, concentrated) vs per-session (W098's literal wording,
  needs a session-scoped pin input).
- **Default-off confirmed?** The spec defaults affinity OFF everywhere
  and opt-in per pool; the intended opt-ins are the long-session pools
  (RSI loop, scheduled multi-turn runs). A settings default, not a code
  change, if the operator wants them opted in at landing.
- **The restart/re-pin semantics under alias drift:** the configured
  aliases resolve to different concrete slugs over time (OpenRouter
  repoints `~...-latest`); a hub restart re-resolves and the pinned slug
  may change — silently invalidating the cache state the pin exists to
  protect. Options: pin the SLUG (drift-prone across restarts) vs pin
  the ALIAS (drift-proof but re-resolves to a possibly different slug).
  The spec defaults to pinning the resolved slug with the drift
  recorded; an alias-level pin is the alternative.
- Whether the pinned choice should prefer the family whose vendor
  reports the largest cache discount — deferred behind P12's metering
  fields (you cannot optimize what you cannot see).

## 10. Verification record

- **Round 1 (2026-09-24) — Kimi K3 via the `general` subagent
  (`openrouter/moonshotai/kimi-k3`), fresh context, read-only,
  adversarial (the #82/W109 pattern): REVISE** — 3×P1 + 4×P2 + 1×P3,
  all verified against the tree and ALL incorporated: (P1-1) family-
  granularity narrowing does NOT stop the per-request bounce — the pool
  carries multiple aliases per family, so the pin narrows to ONE SLUG
  (§2's terminology section is the fix); (P1-2) the role→model map the
  spec cited as an existing seam does NOT exist — `opencode-agent-config`
  composes one model per launch, the settings key models per agent-id,
  and the routing note itself uses future tense — the spec is now
  explicitly CONDITIONAL on key-1's landing, with the per-runtime
  `autoLatest.aliases` option named as the only composition-time anchor
  that exists today; (P1-3) the W109 seam equation corrected — W109
  landed the transformBody seam on the vendor-proxy lane; the
  `allowed_models` injection is the pre-existing autoLatest deviation on
  the OpenRouter lane (§6 now cites it as its own precedent); (P2-4)
  the determinism claim failed under resolver degradation (unresolvable
  aliases drop out; the resolver fails open to `[]` = no injection at
  all) — the pin now follows CONFIGURED alias order and the fail-open
  interaction is recorded (the §9 restart/alias-drift question added);
  (P2-5) the pin's inputs
  contradicted themselves (session identity vs (role, pool, settings)) —
  resolved to per-(role, tier, settings) with the load-concentration
  cost recorded and the per-session variant escalated to §9's decision
  list; (P2-6) the failover yield leans on key 4 which is NOT wired —
  the outage-persistence cost (a pinned vendor degrades for the whole
  session; the narrowing also removes OpenRouter's own reroute) is now
  recorded in the tradeoff; (P2-7) the metering claim scoped to the
  RECORDING mechanics with the lane/vendor content variance added (the
  W109 pollution lesson applied to this doc); (P3) map-territory nits —
  the open-source-pool lane already maximally pinned (no work needed
  there), the topology-daemon surface wires no autoLatest option, and
  "pool" is defined on first use.
- **Round 2 (2026-09-24) — the same Kimi K3 session, continuation
  (confirm + tree-verify): REVISE at the pointer layer** — all eight
  round-1 fixes verified landed and tree-accurate (the one-slug counts
  match the alias array; the key-1 conditionality verified against
  opencode-agent-config's one-model-per-launch composition and the
  future-tense routing note; the W109/vendor-proxy lane split verified
  against model-usage-proxy + open-model-proxy; the resolver's
  drop/fail-open behavior verified; key 4's unwired state verified).
  The rewrite's OWN pointer layer then failed: six stale section
  cross-references from the Terminology-insert renumbering, one wrong
  work-item cite (the metering trail mis-attributed to W047 — G5/G7
  error surfacing — instead of the W044-surfaced G1 metrics), and a
  §2/§3 wording wobble on the slug-selection rule. All fixed in this
  round's edits; round 3 confirms.
- **Round 3 (2026-09-24) — the same session, continuation (confirm):
  ACCEPT.** All eight round-1 fixes verified landed; all ten §-references
  checked and every one resolves to the right section; the slug rule
  agrees exactly across §2/§3/§8 item 4; the family counts match the
  alias array (x-ai/moonshotai ×1 correctly omitted from the multi-alias
  enumeration); the round records judged faithful (the round-2 record
  matches the round-2 verifier's own session); no new errors in the
  fixed lines. One cosmetic P3 (a two-space continuation-line indent at
  the trail cite) fixed with this record's edit.
- **Fresh-eyes round (2026-09-24): REQUEST_CHANGES → all findings
  applied** — the §10 layout this record sat in was scrambled (a
  duplicate Round-3 bullet, dangling "[recorded below.]" placeholders,
  the round-3 content before the round-2 record it references);
  W098's header clause still said "c3 affinity unblocked and queued"
  against the ticked criterion; the park file's P11/P12 dependency
  pointers still targeted the just-superseded P1; §6's lane-shape
  wording overreached (on the OpenRouter lane the FIELD shape stays
  OpenRouter's — what varies is the serving vendor and the numbers/cost);
  and a round-3 cite said "§8.1" where §8 has no subsections (the
  configured-order rule is §8 item 4). All fixed; the re-verification is
  the fresh-eyes round's own follow-up record below.
- **Fresh-eyes follow-up:** [recorded below.]

## 11. The writing-convention note

Per the W084/W100 fixture convention: this document deliberately spells
no force-push/refspec shapes and carries no guard-vocabulary command
forms; the policy-routing claims cite the seams (openrouter-auto-latest
alias resolution, model-profile classes, the W109 transformBody seam)
rather than embedding request shapes.