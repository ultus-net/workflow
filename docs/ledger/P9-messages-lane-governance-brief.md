<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — this is the record of the P9 decision-input brief, not a landed work item. Write-once: append dated supersession notes, never rewrite. Park P9 and issue #288 stay OPEN — the decision is queued for the operator; the brief informs it, it does not make it. -->

### P9 - The messages-lane transform+metering governance DECISION brief (issue #288 - the transform-governance half's decision input; docs-only, no code, no policy change) (2026-09-30)

**Source:** park P9 (docs/PARKED_AND_LIMITATIONS.md:38, operator-approved 2026-09-24;
part 1 landed 2026-09-24 via W123) and issue #288: with W123's extraction landed, the
transform-governance half needed its decision input written down — the gap restated,
the options as the record implies, their per-axis consequences, an executable sketch
per option — so the operator can decide whether the lane's pass-through stance holds
or changes.

**What landed (the brief):** docs/P9_MESSAGES_LANE_GOVERNANCE_BRIEF.md —

1. The gap restated with dated file:line cites: the `/chat/completions` gate
   (src/integrations/model-usage-proxy.ts:302) leaves the messages lane
   raw-forwarded (no parse, no replay enforcement, no transformBody, no
   usage.include injection; :303-366); what landed since — W123 (2026-09-24, the
   extraction keyed on the anthropic wire type, the cache normalization into the
   prompt side, the ONE-event-per-message SSE accumulator, the cost + transform +
   replay-compatibility boundaries recorded) and P12 (2026-09-27, PR #311, the
   cache fields first-class) — the trail is now trustworthy; the record's stated
   prerequisites for governing the lane have landed, so the binding constraints
   that remain are PROBE constraints (P8), not record constraints.
2. The options: **(A) hold the pass-through stance** — what it leaves
   unobservable/uncached (no cache savings on the lane, the W118 WARN-tier
   downgrade inert on messages-lane sessions with the W119-aggregated abort tier
   still effective, the W070a wire invariants unenforced, no model labels —
   W111's gap), plus its parse-only observability variant **A′**; **(B) shape the
   lane** — the record-required-first items stated: the replay policy's
   Messages-schema compatibility record is LANDED (enforceReplayPolicy stays
   chat-completions-scoped; the lane stays replay-ungated — B and the replay
   axis are separable), and B's production gate is the unrun GLM/Kimi + deepseek
   anthropic-wire shape probes (W109 round-1 P1 follow-up), plus an explicit
   malformed-body posture decision; **(C) markers-only (cache_control opt-in)** —
   its dependency on P8's UNRUN vendor probes stated plainly (a rejecting
   endpoint turns the opt-in into per-request 400s; the opt-in stays dark until
   probed, probe-gated never date-gated), and its P13-bounded ceiling (static
   head only; the growing conversation stays uncached); **(D) the
   Messages-schema replay integrity check** — the successor decision W123
   explicitly queues (a fail-closed reject tier whose primary compatibility risk
   is the W070b sanctioned synthetic-tool-call path the replay policy itself
   routes to this lane).
3. Per-option analysis across metering (the W123 extraction is the floor: real
   tokens, one event per message, P12 cache fields, costUsd 0 on the lane — no
   option changes the cost boundary), security/blast radius (transforming
   provider-bound payloads: the composition's fail-open protects availability,
   not correctness; C is the smallest mutation; D's blast radius is false
   rejections), compatibility (the replay policy, the W118 semantics + W109
   ordering, the host adapters' Messages bodies; responses untouched in every
   option), verification (what pins offline vs what needs LIVE operator-gated
   probes: B's shape probes, C's P8 probes + effectiveness read, D's host-body
   audit + host-adapter probes), and cost.
4. A recommendation with trade-offs — HOLD the stance and re-open it on the P8
   probe gate (probes first, then C-before-B if probes accept, D on its own
   axis), with the core trade-off named: the hold was once forced by missing
   records and is now justified only by probe gaps, so it is a choice whose
   standing costs (no cache savings, inert WARN tier, unenforced invariants, no
   model labels) every lane session keeps paying — and the DECISION EXPLICITLY
   LEFT TO THE OPERATOR (verbatim in the brief).
5. Implementation sketches per option: the lane discriminator alongside
   isCompletions; the messages-scoped composition honoring the W109
   downgrade-before-shaping ordering; NO usage.include port (the messages wire
   always reports usage — test/model-usage-proxy.test.ts:551-552); the
   malformed-body posture decision; the pure detector module + host-body audit
   for D.

**Evidence:** docs-only (no src/test changes; lint + typecheck exit 0 unpiped as
sanity). Every substantive claim carries a dated file:line cite to the park rows
(docs/PARKED_AND_LIMITATIONS.md:37 P8 unprobed, :38 P9, :41 P12 landed,
:42 P13), the ledger fragments (W123 2026-09-24 + its 2026-09-27 supersession;
W109 2026-09-23 with gaps 1/3/4 and the P12 supersession note; W111's no-model-labels
gap), the sources (src/integrations/model-usage-proxy.ts, model-replay-policy.ts,
model-profile.ts, open-model-proxy.ts), and the pass-through pin
(test/model-usage-proxy.test.ts:551-558). Issue #288 stays OPEN — the decision
queued; the commit refs it.
