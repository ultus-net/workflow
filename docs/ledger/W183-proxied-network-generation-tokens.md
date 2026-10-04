<!-- Write-once ledger fragment. Append dated supersession notes; never rewrite. -->
### W183 — mediated network posture B1 (`network: "proxied"`) + hub token generation binding

**Source:** issue #443 (W183, NVIDIA adoption Wave B1, the last in the wave).
The contained agent ran with `network=host` for model egress, so nothing at the
network layer fenced a hostile process (`docs/EGRESS_CAPABILITY_AUDIT.md` §5,
`THREAT_MODEL.md` residual #1). W183 adds a proxy-mediated network posture and
binds hub tokens to the hub-start generation.

**Decision.** PR #453 (`f737f3f3`) lands:
- **`network: "proxied"` posture.** `src/containment/proxied-bwrap.ts` (a
  `ProxiedBubblewrapContainment` backend) and `src/containment/bwrap-args.ts`
  run the contained process on a slirp4netns network whose only reachable egress
  is the parent forward proxy `src/integrations/egress-forward-proxy.ts`. An
  allowed origin is reached through the proxy; an unlisted host is denied
  deny-by-default at the proxy.
- **Generation-bound hub tokens.** `src/integrations/hub-tokens.ts` binds every
  token to the hub-start generation: `<generation>.<secret>` (16 hex generation
  + `.` + 64 hex secret). A token replayed from a previous hub start carries a
  different generation and is rejected. `verifier.json` carries the generation
  and the verifier token is generation-prefixed the same way
  (`docs/HUB_PROTOCOL.md`).
- **`egress-policy-file.ts`** — the file loader the hub composes as the policy
  baseline (activated by W184).

**Honest boundary.** The gated probe
`test/acp-contained-egress-probe.test.ts` (gate
`WORKFLOW_ACP_CONTAINED_EGRESS=1`) proves only the **proxy-aware narrowing**: a
contained process reaches an allowed origin *through the parent forward proxy*
and an unlisted host is denied `403` at the proxy. It sends proxy-directed
requests only, so it supports nothing about the **unfenced raw-socket path** —
slirp is not given `--disable-host-loopback`, so raw-socket egress from a
hostile process is not fenced and stays `THREAT_MODEL.md` residual #1. No
`enforced` claim is made. At land time the mechanism was **activation-pending**:
`launchContainedAcpAgent`/`Async` select `proxied` only when the backend
advertises `supportsProxiedNetwork` and a `proxiedEgressPolicy` is supplied, and
`src/integrations/acp-runtime.ts` did not yet thread `loadEgressPolicyFile()`
into the launch, so production kept `network: "host"`. **Superseded by W184**
(PR #457, merged 2026-10-02) — note appended 2026-10-04; see the W184 fragment.

**Verification.**
- `node --import tsx --test test/egress-forward-proxy.test.ts` — the forward
  proxy (allowed origin forwarded, unlisted host `403`).
- `node --import tsx --test test/acp-contained-egress-probe.test.ts` — the gated
  live probe (green 3/3 on a bwrap+slirp4netns host; register row
  `acp-contained-egress-probe` advisory).
- `node --import tsx --test test/hub-tokens.test.ts` — the generation binding
  (a previous-generation token is rejected).
- `test/egress-policy-file.test.ts`, `test/platform-containment.test.ts`,
  `test/acp-contained-agent.test.ts` — the policy file, the platform gates, and
  the launch wiring.
