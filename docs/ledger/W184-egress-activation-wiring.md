<!-- Write-once ledger fragment. Append dated supersession notes; never rewrite. -->
### W184 — activate the egress seams in the server lane and the hub

**Source:** PR #457 (W184; the activation wiring the W178–W183 wave deferred
honestly). W178–W183 landed mechanisms that were tested at their seams but
**inert in production**: gate 2 had no production binding source, the W180 policy
tier had no production policy source, the W181/W182 sinks were not threaded into
the server lane, and the W183 `proxied` posture was activation-pending. W184
closes that gap. (W184 has no separate issue number; the wave's issues stop at
#443, and #457 is the PR.)

**Decision.** PR #457 (head `a6c6b195`, merged `2ce0f8ee`) wires the seams live:
- **W179 gate 2 gets a production binding source.** `src/integrations/egress-binding.ts`
  resolves each proxy lane's binding from the operator credential definitions'
  `allowedEndpoints`, narrowed to the proxy origin (a foreign-host/port binding
  is dropped — the single-origin proxy could only blanket-refuse, never scope).
  Every metering-proxy launcher (opencode/cline/goose) and the W129 server lane
  thread it into `createModelUsageProxy` (per the `a6c6b195` commit message);
  absent a binding, gate 2 is inactive and byte-identical. (This is the gate-2
  *binding* seam; it is distinct from W181's audit-feed seam, whose Cline/goose
  sites remain unwired.)
- **W180 → W182.** The policy denial also emits the shared `onEgressDenied`
  event, so its deny-by-default `no_matching_rule` family (the one approvable
  family) parks end-to-end and an approval merges a durable revision.
- **Hub.** Composes the W183 `WORKFLOW_EGRESS_POLICY_FILE` baseline (per turn,
  so a merged revision is consulted), reads the live composed `policyVersion`
  for the anti-stale epoch, and resolves the provider digest from the credential
  bindings + upstream.
- **W129 server lane.** Threads the gate-2 binding, the policy tier, and the
  W181/W182 sinks into its proxy (it previously bypassed every egress seam). The
  standalone server CLI composes the binding + policy but no hub store, so its
  denials are answered, not parked.
- **Drift repair.** Repairs pre-existing W183 drift in `test/hub-protocol.test.ts`,
  `test/hub-client.test.ts`, and `test/e2e-hub.test.ts` (generation-bound
  `<generation>.<secret>` tokens + the `generation` discovery field) and the
  `HUB_PROTOCOL.md` token/schema description.

**Honest boundary.** The activation is **live-where-configured**, not a blanket
enforced claim: absent a credential binding or a policy file the corresponding
seam stays inactive and byte-identical. `SECURITY_ASSURANCE`,
`EGRESS_CAPABILITY_AUDIT`, `THREAT_MODEL`, and `HUB_PROTOCOL` drop the
"activation-pending / no production launcher supplies it" scoping and state the
live-where-configured posture; no `enforced` claim is widened.

**Supersession note (appended 2026-10-04).** This fragment supersedes the
"activation-pending" clause in the W183 fragment: `src/integrations/acp-runtime.ts`
now threads `loadEgressPolicyFile()` and the binding, so production selects `proxied` where
the backend advertises `supportsProxiedNetwork` and a policy is supplied.

**Verification.**
- `node --import tsx --test test/egress-binding.test.ts` — the origin-narrowing
  source and the per-family narrowing (`perFamilyCredentialBinding`).
- `node --import tsx --test test/opencode-server-egress-wiring.test.ts` — the
  W129 server-lane wiring pin.
- Per-launcher metered probes (`test/acp-opencode-metered-probe.test.ts`,
  `test/acp-cline-metered-probe.test.ts`, `test/acp-goose-metered-probe.test.ts`)
  are env-gated live probes that exercise each launcher's `createModelUsageProxy`
  composition (they do not by themselves pin the gate-2 binding; that breadth is
  sourced from the `a6c6b195` commit message).
- `node --import tsx --test test/hub-protocol.test.ts test/hub-client.test.ts
  test/e2e-hub.test.ts` — the generation-bound token drift repair.
- `docs/NVIDIA_ADOPTION_PLAN.md` records PR #457 merged (`2ce0f8ee`); the P20
  decision note (`docs/ledger/p20-decision.md`) confirms the B1 posture.
