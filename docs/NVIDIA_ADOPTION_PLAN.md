# NVIDIA OpenShell/NemoClaw → Workflow adoption plan

**Status:** operator-directed 2026-10-02 — the recommendation was accepted.
Waves A+B are filed as issues **W178–W183** (GitHub #438–#443, on the project
board); deferred items are parked as **P20–P24** (GitHub #444–#448, parked queue,
registry rows in `docs/PARKED_AND_LIMITATIONS.md`): Wave C stays at the
keep-honest-posture default and its remaining options live in P20. Drafted
2026-10-02 from the desk research in `docs/AI_LANDSCAPE_RESEARCH.md` §3.6
(sources cited there). Nothing in this document changes any surface's
`advisory`/`enforced` status, and no item may be claimed `enforced` without its
probe + SECURITY_ASSURANCE row landing first.

**Standing constraints:**

- **Build-first (operator preference, 2026-09-19, AI_LANDSCAPE_RESEARCH §5.2):**
  patterns are absorbed and reimplemented in-house; third-party code is
  reference-only. No vendoring without a tier-policy exception and W-numbered
  planning. Both NVIDIA projects are Apache-2.0, so reference-reading is
  unrestricted; any code copy would still trigger the exception path.
- **TypeScript only (operator direction, 2026-10-02):** every adopted piece is a
  TypeScript implementation inside this repo. OpenShell's enforcement is Rust —
  we adopt its *semantics*, not its binary, in this plan.
- **Kernel purity:** `src/kernel/` gets nothing from this plan (no LLM/IO/UI/SDK
  imports). All adoption lands in `src/containment/`, `src/integrations/`,
  `src/adapters/`, `mcp-toolbox/`.
- **Honest claims:** each wave names exactly what it may claim and what stays a
  written residual.

## Verdict carried forward

The NVIDIA stack is a better version of Workflow's **substrate** — execution
boundary, credential custody, deny-by-default egress — and no version of
Workflow's **control plane** (no task graph, no legal transitions, no evidence
epochs, no review gating). Adoption means composing their substrate patterns
under Workflow's authority layer, replacing the three named residuals below —
not importing a runtime.

| Workflow residual being retired | NVIDIA reference | This plan |
| --- | --- | --- |
| Direct egress bypasses every proxy; `network=host` for agents (`THREAT_MODEL.md` residual #1, W052 §1) | OpenShell mediated channel + deny-all fence | Wave B (mediated network mode) |
| Placeholder token is a value discipline, not an identity proof (W052 §2) | Two-gate credential binding at (host, port, path) | Wave A item A2 |
| Function-broad grant: any origin-form path on an approved upstream forwards (`docs/EGRESS_CAPABILITY_AUDIT.md` §4) | L4-then-L7 per-request gating, method/path rules | Wave A items A1/A3 |
| Payload policy not built (C3, `THREAT_MODEL.md:57-77`) | L7 request inspection points + middleware-before-injection order | Wave A item A4 (extension point only) |

## Compatibility map (their concept → our home)

| NVIDIA concept (source) | Workflow home | Fit |
| --- | --- | --- |
| Placeholder → real credential at egress, behind two independent gates (OpenShell providers/overview) | `src/integrations/egress-credential.ts` + `model-usage-proxy.ts` `scrubRequestHeader` injection | Direct; the second gate is the missing half |
| Deny-by-default egress, L4 then L7, audit vs enforce per endpoint, additive-allow/deny-precedence, load-time conflict rejection (policies/network-rules) | New `src/integrations/egress-policy.ts` decision module + proxy reject tier | Direct; pure decision module mirrors `egress-credential.ts` style ("no IO, no clock, no SDK imports"; the proxy and tests share one decision) |
| Four-finding proposal-risk taxonomy (policies/advisor) — `link_local_reach`, `l7_bypass_credentialed`, `credential_reach_expansion`, `capability_expansion` | Same `egress-policy.ts`, as pure set logic | Direct; no SMT needed |
| SSRF denylist + DNS-resolve-all + purpose-annotated entries (NemoClaw `ssrf.ts`, `private-networks.yaml`) | `src/integrations/egress-policy.ts` data + resolver | Direct; NAT64/6to4/Teredo/mapped-IPv6 entries copied as *data* |
| Operator approval merges durable revision, resets on recreate; baseline file untouched (network-policy docs) | `operator-ask-hold.ts` + hub persistence | Direct; epochs already give no-stale-approval |
| Denied response teaches the agent; distinguish policy-denial vs DNS/timeout/TLS (NemoClaw `runtime-context.ts`) | ACP runtime session context + agent fleet config | Direct; presentation layer, not kernel |
| Mediated channel / supervisor as sole egress (architecture) | `src/containment/` third network mode | Partial — see Wave B honesty note |
| Two-gate credential custody; refresh gateway-side; secrets via env never argv | `src/integrations/credentials.ts` `CredentialDefinition` + `secret-store.ts` | Direct; extend with endpoint scoping |
| Snapshot sanitization; 0600 env-reference exports (NemoClaw state-and-backups) | Hub snapshot/export + session registry writes | Direct; small module |
| Generation-bound dual tokens, die-with-sandbox (architecture auth) | Hub `discovery.json`/`verifier.json` rotation | Partial; closes the same-UID token residual only partially — see Wave B note |
| Z3 boundary prover, K8s/libkrun drivers, Rego, managed-inference hardware recipes, llm-router submodule | — | **Not adopted** (see § "Explicitly not adopted") |
| DNS interception with placeholder answers | — | **Not adopted** in TS scope (needs kernel-level control) |
| `nemoclaw-acp` ACP surface | `src/adapters/` research note | Follow-up read, not adoption |

## Wave A — pure TypeScript, no containment changes (proxy + policy + custody)

All Wave A items work against `createModelUsageProxy` and its W070a siblings.
None claim network-layer enforcement; they shrink the *proxy* attack surface and
make its decisions policy-shaped.

**A1. Egress policy decision module** — new `src/integrations/egress-policy.ts`
(+ `docs/` policy schema page, data file for SSRF ranges). Contents:

- Rule model: `{ host, port?, methods?, paths?, mode: "audit" | "enforce" }`
  with **unordered rules, additive-allow union, deny-precedence**, and
  **load-time rejection** of conflicting endpoint definitions (OpenShell
  network-rules semantics).
- SSRF stage reimplemented from the NemoClaw trio as in-house code:
  scheme allowlist (http/https), no userinfo, deny on *any* resolved address in
  the denylist (loopback, link-local, private, NAT64 `64:ff9b::/96`, 6to4
  `2002::/16`, Teredo, IPv4-mapped, reserved names `localhost`/`local`/
  `internal`/`metadata`), each denylist entry carrying a `purpose` annotation
  with a parity test. Loopback exemption only for loopback-only tests.
- The shared-decision discipline: one pure function `decideEgress(request,
  policy)` used by both the proxy and the tests; no IO, no clock, no SDK imports
  (same shape as `src/integrations/egress-credential.ts:16-17`).
- Four-finding risk report (`link_local_reach`, `l7_bypass_credentialed`,
  `credential_reach_expansion`, `capability_expansion`) as a pure function over
  two policies — the agent-approval pre-check, replacing OpenShell's SMT prover
  with honest set logic for its own L4+REST-limited scope.
- Claim boundary: advisory endorsement ("audit" mode) is observability; "enforce"
  mode only claims *proxy-passing* traffic is gated. Direct sockets remain the
  THREAT_MODEL residual until Wave B.

**A2. Second credential gate** — extend `CredentialDefinition`
(`src/integrations/credentials.ts`) with optional `allowedEndpoints:
{ host, port?, pathPrefix? }[]`; the proxy's existing header-injection point
(`scrubRequestHeaders`, `model-usage-proxy.ts`) refuses injection when the
request's (host, port, path) falls outside any binding and returns a
`credential_endpoint_mismatch`-class 403 that logs **neither secret, nor
placeholder, nor query string** (OpenShell logging discipline). Keeps
`checkEgressCredential` as gate 1; this is gate 2. Both must pass.

**A3. Path/function allowlist reject tier in the proxy** — insertion point is
the existing gate order in `handle()` (`model-usage-proxy.ts`, credential check
→ lane parse): add a policy tier consulting A1 that rejects paths outside the
allowed function set for each upstream. Closes the function-broad grant
(`docs/EGRESS_CAPABILITY_AUDIT.md` §2/§4 table) for proxy-passed traffic.

**A4. Payload-policy extension point, middleware-before-injection order** —
OpenShell's middleware chain runs *after* policy check and *before* credential
injection, so extensions can never see a resolved secret; default fail-closed.
Our existing `transformBody: BodyTransform` + `composeBodyTransforms()` seam
(`model-usage-proxy.ts:51-93`) is ordered the same way; A4 formalizes that
ordering invariant in a test and adds the size-ceiling stage (C3 payload policy
properly stays out of this wave's claims).

**A5. Egress ledger auto-feed** — proxy rejections and reaches auto-append to
`egress-audit-mcp` (the AUDIT §7 follow-up: today the ledger is fed only by
explicit calls). Advisory evidence posture unchanged.

**A6. Runtime-context projection** — adapt the NemoClaw `runtime-context.ts`
pattern as fleet/agent-config projection text teaching agents: egress is
deny-by-default through the proxy, *attempt* restricted endpoints rather than
refuse preemptively (a denial surfaces an operator decision via A7), and
distinguish policy-denial from DNS/timeout/TLS failure classes. Presentation
layer only.

**A7. Operator approval on deny (hub-scoped)** — wire `operator-ask-hold.ts`'s
park/answer dialect into the proxy deny path *through the hub*: denied egress
parks a pending rule (visible via hub routes), an approval merges a durable
revision persisted by the hub, revisions reset when the backing session is
recreated, and the baseline config file is never rewritten ("live policy is
the only state"). Epoch semantics give the no-stale-approval property for free.

## Wave B — mediated network mode (containment depth)

This wave touches `src/containment/` and the one agent-launch call. It carries
a **hard honesty constraint**, because nothing in TypeScript can build
OpenShell's seccomp-notify + kernel-fence mediation alone.

**Mechanics available to us.** bwrap `--unshare-net` takes all networking away
(including loopback-to-host); a dedicated netns reachable only through a host
proxy needs CAP_NET_ADMIN or a user-mode stack (slirp4netns), and even then raw
sockets bypass an env-forced proxy. Claiming "mediated" for HTTP(S) while raw
sockets remain open would be a dishonest `enforced` label — so this wave splits
into two precisely-labeled postures:

- **B1. `network: "proxied"`** (`ContainedProcessRequest.network` widened):
  private netns via bwrap, a small parent-side forward proxy bound in-netns
  (host-side CONNECT + origin-form support added to the A1 policy engine,
  exposed over the netns), proxy env vars forced inside the sandbox, and the A1
  policy engine as the gate. **Claim (honest):** *L7 egress for proxy-aware
  traffic is mediated and policy-gated; raw-socket egress from a hostile process
  is not fenced and remains a THREAT_MODEL residual.* This buys real value for
  our agent fleet (which speaks HTTP(S)) without a forbidden claim.
- **B2. `network: "mediated"`** stays a stub that fails closed with
  `UNSUPPORTED_UNTIL_SUPERVISOR` unless a true mediator exists — reserved for
  the Wave C decision; never returned as `enforced`.
- Backend slots into `selectContainment` (`src/containment/platform.ts`) as a
  third `ProcessContainment`; capability derivation in
  `WorkflowContainedProcess.execute` (`workflow-process.ts:29-31`) maps the new
  mode to the `network` capability; `ContainedProcessResult.network` reflects
  the mode.
- **Launch flip**: `launchContainedAcpAgent`
  (`src/adapters/acp-contained-agent.ts:60-70`) is the single call site that
  hardcodes `network: "host"`; it switches to B1 only when the backend reports
  B1 support, else fails closed to the current posture. This one call site is
  where every ACP agent (OpenCode/goose/Cline) picks up egress mediation.
- **Token rotation for hub credentials** (the dual-JWT/generation idea,
  adapted): `verifier.json`/`discovery.json` rotate on hub start and their
  values are generation-bound (old token rejected after restart). This closes
  *replay across restarts* but — stated plainly — **does not** close the
  same-UID-file-read residual (THREAT_MODEL W073 item 1); only OS-level
  containment of `~/.workflow/hub/` does, recorded here as still-residual.

## Wave C — decision deferred (supervisor-class mediation)

True deny-all mediation (HTTP/2 multiplexed channel, DNS interception,
seccomp-notify, fail-closed freeze, TLS MITM with per-sandbox ephemeral CA +
`NODE_EXTRA_CA_CERTS` seeding) is OpenShell's core and is **not a pure-TypeScript
build**. The deferred decision, recorded for the operator:

1. **Keep B1's honest posture** and accept the raw-socket residual (current
   plan default), or
2. **Delegate**: drive the actual OpenShell runtime as an external
   `ProcessContainment` backend via its TS gateway SDK (`@nvidia/openshell-sdk`
   over Connect/gRPC). This is a binary runtime dependency — outside the
   build-first vendoring rule but a genuine supply-chain operational dependency,
   and NVIDIA-pinned semantics. This option gets real enforcement but exports
   our containment correctness to an external alpha project, or
3. **Root-helper hybrid**: a minimal setuid/OS-level helper (firewall-owner
   matching in the sandbox netns) with the TS control plane on top. Smallest
   enforced footprint; platform-fragile and outside Node/TS guarantees.

Option (1) is the plan default; (2) and (3) require an explicit operator
decision before any issue is filed. **Recorded decision (operator,
2026-10-02):** the default stands; this section is parked as P20 (issue #444)
for future re-address once W178–W183 have landed.

## Explicitly not adopted

With reasons, so the scope line is auditable:

- **Z3 SMT prover / `openshell-prover`**: its own `unsupported`/`inconclusive`
  outcomes limit it to the L4+REST subset; our A1 four-finding set logic covers
  exactly that subset without an SMT dependency.
- **Rust supervisor/sandbox crates, Sandbox Protocol byte framing, seccomp
  user-notify**: kernel/Rust scope, outside the TS mandate (Wave C defers).
- **Rego/OPA evaluation**: rule algebra (A1) subsumes what we need.
- **K8s agent-sandbox controller, libkrun MicroVM/GPU passthrough, MXC Windows
  driver, managed-inference hardware recipes**: deployment substrate for a
  fleet Workflow does not run.
- **NemoClaw blueprint runner, agent manifests, OpenClaw plugin SDK coupling,
  Hermes patch files**: orchestration for agents Workflow does not host; the
  *patterns* (digest-pinned artifacts, durable-identity destroy, resumable
  onboarding FSM with secrets-never-recorded) are already echoed by our
  persisted-state discipline.
- **llm-router model router**: overlaps the auto-router + scheduler; only the
  encoder-scored routing idea is noteworthy, parked unless cost-routing work
  revives it.
- **TLS MITM / per-sandbox ephemeral CA**: integrity and trust-store tradeoffs
  not justified until Wave C; `tls: skip` semantics lesson recorded.

## Issues (filed 2026-10-02, on the "Workflow control plane" board)

| Item | Issue | Scope (summary) |
| --- | --- | --- |
| W178 | [#438](https://github.com/ultus-net/workflow/issues/438) | Egress policy engine + SSRF core — `egress-policy.ts` decision module (rules algebra, load-time conflict rejection, SSRF denylist with purpose-parity test, four-finding risk report); shared by proxy and tests; no IO/clock/SDK |
| W179 | [#439](https://github.com/ultus-net/workflow/issues/439) | Two-gate credential custody — endpoint scoping on `CredentialDefinition`; injection refusal outside binding; 403 without secret/placeholder/query logging; both gates tested |
| W180 | [#440](https://github.com/ultus-net/workflow/issues/440) | Proxy path/function allowlist + payload extension point — reject tier in `handle()`; middleware-before-injection ordering test; size-ceiling stage; audit doc narrows the function-broad claim |
| W181 | [#441](https://github.com/ultus-net/workflow/issues/441) | Egress ledger auto-feed + runtime-context teaching — proxy auto-appends to `egress-audit-mcp`; posture-gated teaching text in the fleet config |
| W182 | [#442](https://github.com/ultus-net/workflow/issues/442) | Operator approval on egress deny — ask-hold wiring through the hub; durable revisions, reset-on-recreate, no-stale-approval |
| W183 | [#443](https://github.com/ultus-net/workflow/issues/443) | Mediated network posture B1 (`network: "proxied"`) + hub token generation binding — backend, launch flip, gated probe, THREAT_MODEL residual #1 narrowed precisely (raw-socket residual stays) |

Dependency order: **W178 first** (W180, W182, W183 consume `decideEgress`);
W179 and W181 are independent; W183 last (it composes the policy engine, the
proxy, and containment).

Every row: focused tests only (never `npm test` by default), `npm run lint` +
`npm run typecheck` green, SECURITY_ASSURANCE rows for any new claim, and an
anti-rubber-stamp review before merge.

## Parked (2026-10-02; registry `docs/PARKED_AND_LIMITATIONS.md`)

| Item | Issue | Deferred contents |
| --- | --- | --- |
| P20 | [#444](https://github.com/ultus-net/workflow/issues/444) | Wave C supervisor-class decision — keep-honest-posture default accepted; options (OpenShell delegation via `@nvidia/openshell-sdk`, root-helper hybrid) recorded for re-address |
| P21 | [#445](https://github.com/ultus-net/workflow/issues/445) | TLS MITM with per-sandbox ephemeral CA + trust-store env seeding — pending P20 |
| P22 | [#446](https://github.com/ultus-net/workflow/issues/446) | DNS interception with placeholder answers + the DNS-pinning/SNI TOCTOU lesson — kernel-level, out of TS scope alone |
| P23 | [#447](https://github.com/ultus-net/workflow/issues/447) | Follow-up reads: `nemoclaw-acp`, gateway config JWT knobs, boundary-protocol framing, agent provenance |
| P24 | [#448](https://github.com/ultus-net/workflow/issues/448) | Encoder-scored cheap-model routing idea — revive only if cost-routing work does |

## Verification discipline carried into adoption

- Enforcement wording per item is stated in its acceptance row; `docs/FEATURES.md`
  and `THREAT_MODEL.md` are updated only when the matching test/probe evidence
  exists.
- Wave B's launch flip ships with a gated probe (mirroring `acp-*-probe` style
  env gates) that asserts a contained agent cannot reach an unlisted host via
  the proxy path and that an agent-version bump re-requires the probe —
  consistent with `docs/HOST_ADAPTERS.md` per-version verdicts.

## Follow-up reads (not adoption work)

Parked as **P23** (issue #447) on 2026-10-02:

- `nemoclaw-acp` (NemoClaw's ACP surface) — inspect for ACP edge cases our
  adapters should handle.
- OpenShell gateway configuration page (`how-it-works/gateways/configuration`)
  for JWT TTL/renewal knobs if the rotation item (in W183) needs finer
  semantics.
- `crates/openshell-sandbox-backend` boundary protocol framing — only if
  Wave C option 2 becomes real (P20 decision).
