<!-- Ledger fragment: extracted from TASKS.md at line 2282 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W095 - Local model-routing policy at the metering proxy (Partial - the metering-proxy seam landed via W109's transformBody; the routing design note EXISTS and is frontier-verified through round 3 (2026-09-24); the per-role end-to-end check queued) (2026-09-22)

**Operator question:** "readdress the mixture-of-experts local router idea -
would it be a good idea to classify things before handing them to
OpenRouter?" - i.e. a local MoE-style classifier/router between the agent
runtimes and the OpenRouter upstream.

**Position (this ledger entry is the recorded shape, not a claim of landed
work):**
- **Yes to a local ROUTER; no to content-classification-as-MoE.** The
  routing decision that matters is ALREADY made upstream of the request by
  the thing that understands the work: the agent fleet's task decomposition
  (decompose -> executor -> reviewer roles; task-decomposition.md strong/
  weak routing with acceptance checks - the cheap-model-error-leakage
  mitigation). That IS the working mixture-of-experts: roles are the
  experts, and the classifier is structured and reviewable. A per-request
  content classifier would guess what the decomposition already knows, adds
  a model call (latency/cost/failure modes), and mis-classification sends
  edits to weak models - the exact leakage class the fleet discipline
  exists to prevent.
- **OpenRouter's Auto Router stays the default for general traffic** - it is
  a vendor router with more routing data; do not duplicate it. The hub
  already constrains it deterministically (the openrouter-auto-latest
  seam: alias resolution + allowed_models pool injection + cost-tier
  bands).
- **The local router's right shape: POLICY-driven routing at the
  metering-proxy seam, keyed to metadata the control plane already holds -
  never prompt content.** Concretely: (a) task-class routing
  (model-profile.ts already carries coding/general/batch classes and
  per-family reasoning-effort) - hub-composed agent configs can set
  per-role models today; (b) budget-driven downgrades (a session nearing
  its W045 caps routes remaining turns to the cheap pool - deterministic,
  auditable); (c) schedule-driven routing (batch/off-peak pools - the
  DeepSeek off-peak opportunity already in AI_LANDSCAPE_RESEARCH.md item
  176); (d) failover (OpenRouter outage -> local fallback pool). All
  rule-based, testable, logged - HOME-A/B per the migration-boundary rule
  (routing policy that gates cost/authority is control-plane owned).
- **Rejection recorded:** prompt-content classification as a gate is
  rejected for now - it duplicates the vendor router, blurs the metering
  proxy's pass-through posture, and its errors are quality-authority errors
  the acceptance-check discipline would have to catch after the fact.

**Acceptance criteria:**
- [x] A routing-policy design note (the four metadata keys, the pool
      matrix, the precedence: task-class -> budget -> schedule -> failover)
      before any code.
      (docs/MODEL_ROUTING_POLICY_2026-09-23.md — frontier-verified
      through round 3, 2026-09-24: the round-2 repairs confirmed against
      the tree (the zero-callers state re-grepped, the tier-label cite,
      the globality note, the repaired quantifier) and two new findings
      incorporated (the deviation counts stale post-W109 — the
      cache-marker pass is the seam's second consumer; the
      enumeration-boundary clarification). The criterion's tick stands
      on the note's §8 round-3 record.)
- [x] The metering-proxy seam shaped for policy routing (the
      autoLatest-style transform point) without changing the pass-through
      posture for unclassified traffic. LANDED in W109 (2026-09-23): the
      transformBody option is the named policy-routing transform point;
      `composeBodyTransforms` composes consumers in order with per-stage
      fail-open extended to throwing stages; the pass-through posture for
      unclassified traffic pinned. The budget-downgrade consumer itself is
      still queued (it attaches through this seam).
- [ ] The fleet's per-role models verified end-to-end (the de-facto MoE)
      before building anything new.
- [x] Frontier verification of the design note (same pattern as #78/#82).
      DONE (2026-09-24): the three-round Kimi K3 chain recorded in the
      note's §7-§8 (round 1 REVISE with the fleet-architecture + pool-
      substrate + downgrade-seam corrections; round 2 REVISE with the
      self-corrected failover-wiring claim + the partially-applied
      sentence caught; round 3 REVISE with the stale W109-era deviation
      counts corrected + the enumeration boundary stated — all
      tree-verified by the verifiers themselves). This criterion and
      criterion 1's "frontier-verified" are the same verification; the
      tick stands on the note's §8 record.
