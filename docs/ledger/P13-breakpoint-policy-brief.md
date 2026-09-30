<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — this is the record of the P13 decision-input brief, not a landed work item. Write-once: append dated supersession notes, never rewrite. Park P13 and issue #292 stay OPEN — the decision is queued for the operator; the brief informs it, it does not make it. -->

### P13 - The message-lane breakpoint policy DECISION brief (Complete - the brief itself; the decision queued, issue #292 open) (issue #292 - the breakpoint-policy decision input; docs-only, no code, no policy change) (2026-09-30)

**Source:** park P13 (docs/PARKED_AND_LIMITATIONS.md:42, operator-approved
2026-09-24; W109 gap 4, deferred deliberately and recorded as LOAD-BEARING) and
issue #292. P13 is one sub-decision inside the W109 marker pass: where the
prompt-cache breakpoints sit on the growing conversation. It is chained behind
P8 (whether the anthropic-compatible vendors accept Messages-schema
`cache_control` at all) and P9 (whether the messages lane is transformed such
that markers reach it). The brief restates the gap, presents the options the
record implies, states the dependency order, and recommends a target policy —
deciding nothing.

**What landed (the brief):** docs/P13_BREAKPOINT_POLICY_BRIEF.md —

1. The gap restated with dated file:line cites: the minimal slice marks only
   the static head — the system block and the last tool definition
   (src/integrations/model-profile.ts:228-248, the per-turn lane deliberately
   untouched at :219-223) — so the growing `messages` array, the dominant token
   mass, has no marked prefix end and is never cache-read (docs/PARKED_AND_LIMITATIONS.md:42;
   W109 gap 4, docs/ledger/W109-...comple.md:73-78). The dependency facts that
   bound any answer: the lane is ungoverned (P9), the vendors are unprobed (P8,
   limitation L8), and the trail can now measure any choice (W123 + P12 —
   `cacheReadTokens`/`cacheCreateTokens`,
   src/integrations/model-usage-proxy.ts:87-88, :514-515).
2. The options: **(A) static-head only** (status quo — two marked ends, budget
   unused, dominant mass uncached); **(B) per-turn boundary marks** (mark the
   previous turn's end each turn, so the whole growing prefix caches at
   one-turn reuse distance; the wire's few-breakpoint budget becomes a real
   placement policy and must tolerate the W070b synthetic path); **(C) a sliding
   window** (bounded tail prefix — budget-safe, smaller reuse); **(D) defer**
   behind P9 + P8 (the record's own dependency column). Per option, the six
   axes: what becomes cacheable, the wire-limit interaction, the P12 metering
   observability, the cache-create/write-premium cost, the replay-policy
   compatibility, and the verification plan (offline pins vs operator-gated
   live traffic).
3. The dependency order stated plainly: P8 probes → P9 governance → P13
   boundary policy. P8 gates everything (a rejecting endpoint makes markers
   moot); P9 gates whether P13 is live; P13's *policy* is designable and
   pinnable offline now, but its *payoff* needs live traffic (P8 + an
   effectiveness read) — the brief separates decid-able-now from gated.
4. A recommendation with trade-offs — record B as the intended target with C as
   the budget-safe variant, A as the floor and D as the correct timing, with
   the core trade-off named (B caches the dominant mass at a per-turn write
   premium plus a real budget/placement policy, unproven until live traffic;
   C bounds coverage and premium; A costs nothing and leaves the mass
   uncached) — and the DECISION EXPLICITLY LEFT TO THE OPERATOR (verbatim in
   the brief).
5. An executable implementation sketch (the pure boundary-selection function,
   the per-stage fail-open marker composition, the P9 lane reach, the offline
   pins, the P8 + effectiveness production gate) — so the decision is
   executable when its gates land.

**Evidence:** docs-only (no src/test changes; no executable surface changed; the
lint/typecheck claim is not applicable and is not made). Every substantive claim
carries a dated file:line cite to the park rows (docs/PARKED_AND_LIMITATIONS.md:37
P8 unprobed, :38 P9, :41 P12 landed, :42 P13, :61 L8), the ledger fragments
(W109 2026-09-23 gap 4 + gaps 1/3; W123 2026-09-24 and its 2026-09-27 P12
supersession), the P9 governance brief (docs/P9_MESSAGES_LANE_GOVERNANCE_BRIEF.md
2026-09-30), and the sources (src/integrations/model-profile.ts,
model-replay-policy.ts, model-usage-proxy.ts, open-model-proxy.ts). Issue #292
stays OPEN — the decision queued; the commit refs it.
