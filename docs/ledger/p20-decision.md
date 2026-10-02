<!-- Ledger fragment: opened 2026-10-02 as the P20 Wave C decision record (issue #444). Write-once — append dated supersession notes, never rewrite. -->

### P20 — Supervisor-class true-mediation decision (NVIDIA adoption Wave C) (Decision recorded — option 1: keep W183's honest `network: "proxied"` posture; no true-mediation claim) (2026-10-02)

**Decision: option 1 — keep W183's honest `network: "proxied"` posture; make no
true-mediation claim.** No W-numbered issue is filed. This closes the P20
re-address (issue #444) opened when the NVIDIA adoption plan was filed; the
entry stays on the parked list as a recorded decision, not open work.

## Context

P20 (`docs/PARKED_AND_LIMITATIONS.md`; plan `docs/NVIDIA_ADOPTION_PLAN.md`
"Wave C") held the decision between:

1. keep B1 (`network: "proxied"`) and accept the raw-socket residual (the plan
   default);
2. delegate to the OpenShell runtime as an external `ProcessContainment`
   backend via `@nvidia/openshell-sdk`; or
3. a minimal root-helper hybrid (owner-matched firewall rules in the sandbox
   netns).

W178–W183 landed, so the dependency ("W178–W183 landed first") was satisfied
and the item became re-addressable. W184 (PR #457, activation wiring) is
authored and under review; the underlying containment mechanism is landed but
production activation remains gated on that merge.

## Substrate facts confirmed while deciding

- **Option 2 is real but alpha.** OpenShell ships a native Connect/gRPC
  TypeScript SDK (`@nvidia/openshell-sdk`) and its gateway is the control
  plane (a mediated HTTP/2 channel with dual generation-bound JWTs over mTLS;
  K8s/libkrun compute drivers). Adopting it means a genuine external-runtime
  dependency pinned to an alpha project — real enforcement, exported
  containment correctness.
- **Option 3 is the smallest enforced footprint** but is platform-fragile and
  outside the Node/TS mandate.

## Decision and triggers

Option 1 stands. Re-open only on a concrete requirement, not speculatively:

- **→ option 3** when raw-socket / host-loopback egress must be fenced **and**
  the host is fixed Linux. Smallest change; reuse W178 `decideEgress`
  semantics rather than a second engine.
- **→ option 2** when Workflow must run a fleet / K8s / libkrun / GPU
  substrate. The enforcement rides a substrate cost then already being paid,
  and TLS MITM (P21) + DNS interception (P22) arrive in the same bundle.

## Consequences

- **P21 (#445) stays parked** — its dependency ("P20 resolved with option 2 or
  3, or a genuine need for L7 coverage beyond the model-proxy lanes") is not
  met.
- **P22 (#446) stays parked** — same dependency class.
- **P23 (#447) item (c)** (boundary-protocol framing) stays gated on option 2.
- B1's claim is unchanged: L7 egress for proxy-aware traffic is mediated and
  policy-gated; raw-socket egress (and host-loopback, since slirp is not given
  `--disable-host-loopback`) remains a stated `THREAT_MODEL.md` residual.

## Dated supersession note (2026-10-02)

W184 (PR #457) merged to `main` at 05:24:54Z (`2ce0f8ee`) after this fragment was
first pushed, so the "authored and under review / gated on that merge" status at
line 23 is superseded: the egress seams are now live in the server lane and hub.
This does not change the decision (option 1) — B1's `network: "proxied"` posture
and the raw-socket/host-loopback residual are unaffected by activation.
