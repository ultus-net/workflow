<!-- Ledger fragment: the P3 authority-vocabulary DESIGN BRIEF. Issue #282 stays OPEN — the design decision is queued; this file records the brief, not a landing. Append dated supersession notes, never rewrite. -->

### P3 — The kernel authority-vocabulary and authorized-attach design brief (2026-09-30)

**Source:** parked item P3 (docs/PARKED_AND_LIMITATIONS.md:32, issue
#282) — "W114 follow-on — the authorized-attach machinery: surface the
producing flow per missing artifact, route around claim-shaped endpoints;
plus the kernel-side operator/claim authority class (a kernel design with
gate semantics of its own — its own iteration)"; dependency: "the kernel
authority-vocabulary design decision (operator input recommended)." Fed by
the W114 removal record and LESS-0035; limitation L6
(docs/PARKED_AND_LIMITATIONS.md:59) records the claim-shaped endpoint as
removed and this replacement as parked.

**What landed (the brief):**
- `docs/P3_AUTHORITY_VOCABULARY_BRIEF.md` — the decision INPUT (the
  decision stays the operator's; no code change authorized).
- Restates the problem: missing artifacts cannot name their producing
  flow; claim-shaped endpoints were removed and must stay removed; the
  kernel has only an observation-authority union
  (`environment|host|mcp|reviewer`, src/kernel/contracts.ts:17) and no
  explicit operator/claim authority class.
- Proposes the vocabulary as two disjoint axes — **observed/adjudicated
  evidence** (existing `EvidenceAuthority`, opens evidence gates),
  **operator decision** (new `DecisionAuthority = "operator"`, opens
  decision gates only), **derived fact** (kernel-computed, no stored
  authority), and **claim** (no class — not representable as a gate
  input) — with per-class gate semantics and fail-closed directions.
- Proposes the authorized-attach shape: an inert, authority-recorded
  **producing-flow pointer** on the refusal diagnosis
  (contracts.ts:148–157 / task-graph.ts:458–466), naming an existing
  authorized producer (hub test runner, run-registry reviewer verdicts,
  MCP normalizer, operator-decision path) and never accepted from a
  client.
- Maps the classes to THREAT_MODEL.md trust zones (:11–18) and states the
  operator-decision class **inherits residual #9** (the unauthenticated
  loopback; SECURITY_ASSURANCE.md:271–272, P10's landed precedent).
- Records three options (A: separate decision axis + inert pointer,
  recommended; B: widen `EvidenceAuthority` with `operator`, rejected by
  the W114/LESS-0035 record; C: authorized-attach only, defer the kernel
  axis) with trade-offs, and **six open operator questions** (actor
  binding, one-shot/expiry, gate scope, claim recordability, pointer
  placement, naming).

**Deliberately NOT done:** no kernel code change; no new or reintroduced
route; no operator-level policy decision; the removed
`POST /api/evidence` stays removed (L6 `landed+verified`).

**Evidence:** the brief cites its sources inline (P3 row :32; L6 :59; the
W114 ledger fragment; LESS-0035 docs/agents/lessons.md:266–273; the kernel
contracts; the review fingerprint discipline src/review/provenance.ts;
THREAT_MODEL.md:11–18; residual #26/P10 docs/SECURITY_ASSURANCE.md:271–272;
the permission-broker/W112 grant shapes; the evidence producers). Docs-only:
lint and typecheck are **not applicable** to this change (no executable
surface touched). Issue #282 stays OPEN — the design decision is queued.
