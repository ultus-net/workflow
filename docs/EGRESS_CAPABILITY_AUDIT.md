# Egress Capability Audit (W052)

**Date:** 2026-09-19. **Status:** audit + capability-grant reframe. No
`advisory`/`enforced` status changes are made here. This document is evidence
of what the code does today, not a claim that egress is fully contained.

**Provenance:** W052 in
`docs/superpowers/plans/2026-09-19-ai-landscape-followups.md`, derived from
`docs/AI_LANDSCAPE_RESEARCH.md` §3.1 (Cowork approved-domain exfiltration;
"the allowlist may be better conceptualized as a capability grant"; the
MiTM-proxy-with-session-token fix), §4.2, §5.1, §6.2.

## 1. The capability-grant model

An allowlisted destination is not "this domain is safe". It is a **grant of
every function reachable on that domain under the credential the boundary
holds**. The Cowork incident made this concrete: `api.anthropic.com` was
allowlisted, so a malicious workspace file uploaded files through the
attacker's own API key. The failure was not that the domain was wrong; it was
that the grant was modeled at domain granularity while the reachable attack
surface is function (and token) granularity.

Two enforcement gaps follow from that reframing:

1. **Function surface:** a proxy that forwards an unfiltered path grants the
   whole HTTP surface the upstream credential can reach, not just the
   endpoint the agent was meant to call.
2. **Token provenance:** if an agent-supplied credential is accepted, the
   request can be routed under *the attacker's* key rather than the
   hub-provisioned one.

## 2. The boundary as it exists today

Agent model egress is composed through loopback metering proxies
(`src/integrations/model-usage-proxy.ts`, `createOpenModelMeteringPool` in
`src/integrations/open-model-proxy.ts`). Each proxy:

- binds loopback only;
- receives the real upstream key from custody (`loadUpstreamApiKey`,
  `loadOpenModelKeys`) and never exposes it to the agent;
- hands the agent the placeholder credential `workflow-metered`
  (`src/integrations/egress-credential.ts`) via hub-owned config
  (`meteredOpencodeConfig`, `meteredProviderSettings`, goose's
  `OPENROUTER_HOST`);
- rewrites the inbound `authorization` header to the real key before
  forwarding.

The proxy is **not** a path allowlist by default. `handle()` parses the
request target as `new URL(req.url, upstream)` and forwards any **origin-form**
target whose origin equals the upstream origin; absolute-form targets are
rejected (P1 regression). So every function on the upstream origin is reachable
with the injected key — the grant is function-broad by construction, and the
destination alone tells you nothing about the blast radius. **W180 (2026-10-02)
narrows this for proxy-passed traffic only when the proxy is composed with an
`egressPolicy`** (§3b); absent that composition the grant is unchanged.

## 3. Token binding (W052 slice 2)

`checkEgressCredential` (`src/integrations/egress-credential.ts`) is the pure
decision each proxy applies before forwarding:

- **absent credential** → allowed; the proxy supplies the real key;
- **the hub-provisioned placeholder** (`Bearer` or bare) → allowed, labeled
  `session-placeholder`;
- **anything else** in `authorization`, `x-api-key`, `api-key`, or
  `x-goog-api-key` → **rejected `403`** with `policy: "egress-credential"`,
  and the request never reaches the upstream.

This rejects an attacker-supplied key smuggled through agent-controlled
content at the boundary where it is enforceable. It is verified by loopback
tests (`test/egress-credential.test.ts`, plus the proxy-boundary cases in
`test/model-usage-proxy.test.ts`); no live vendor keys were required because
the check is on the proxy's own request surface.

### 3a. Second credential gate — endpoint scoping (W179, 2026-10-02)

`checkEgressCredential` is gate 1 (token provenance). W179 adds gate 2,
`checkCredentialEndpoint` (`src/integrations/egress-credential.ts`): given a
request target `(host, port, path)` and a credential's optional
`allowedEndpoints` binding (`CredentialDefinition`,
`src/integrations/credentials.ts`), it decides whether the binding covers the
destination. The metering proxy applies it at the point where the real key is
injected (`model-usage-proxy.ts`): when a binding is present and the request
falls outside every endpoint, the proxy refuses to inject and answers a `403`
with policy family `credential_endpoint_mismatch`. **Both gates must pass;
each alone grants nothing** — a valid placeholder toward an out-of-binding
destination is still refused, and a foreign credential toward an in-binding
destination is still refused by gate 1.

The refusal body and the value-free rejection event
(`onCredentialEndpointRejected`) carry neither the secret, the placeholder, nor
the query string — only the policy family and the destination facts (host,
port, pathname). Coverage is host-exact (case-insensitive), port-exact when
specified (absent on either side matches any port), and path-prefix matched on
a segment boundary; the query string never participates. An ABSENT binding
preserves today's behavior exactly (gate 2 inactive); an empty binding matches
nothing (fail closed).

**Narrowing, stated precisely:** for proxy-passed traffic whose credential
carries an endpoint binding, the function-broad grant of §2 is narrowed to the
bound destination set. This is **not** an erase of the residual: a credential
without a binding keeps the function-broad grant, and the §5 bypass (an agent
that reaches a host directly, outside any proxy) is unaffected. The
placeholder-value residual in §6.2 is also narrowed for endpoint-bound
credentials — presenting the constant is no longer sufficient to obtain
injection, because the destination must additionally fall inside the binding.
It is still not an identity proof: gate 2 scopes *where* a credential may be
used, it does not prove *who* presented the placeholder, and an unbound
credential keeps the old grant.

This is verified by loopback tests in `test/egress-credential.test.ts`
(the pure decision) and `test/model-usage-proxy.test.ts` (the proxy boundary,
including a log-hygiene pin).

### 3b. Path/function allowlist reject tier (W180, 2026-10-02)

W179 scoped *which destination* a credential may reach; W180 adds the function
granularity: an optional `ProxyPayloadPolicy.egressPolicy`
(`src/integrations/model-usage-proxy.ts`) consults W178's shared, pure
`decideEgress` (`src/integrations/egress-policy.ts`) for the request's
(host, port, method, path). A request whose function falls outside the allowed
set for its upstream is refused with the named policy family `egress_policy`
and a value-free event (host, port, method, pathname, reason — never the
secret, the placeholder, or the query string), and never reaches the upstream.

**The tier is dark by default.** With no `egressPolicy` supplied the gate is
skipped entirely and today's behavior is byte-identical; the tier is a
composition seam, not a new default. When a policy IS supplied the tier is
**fail closed** on the no-rule case: W178's `decideEgress` deliberately reports
`no_matching_rule` as allowed-but-reported (the honest core contract,
unchanged), and the proxy tier promotes exactly that case to DENY — a supplied
policy that names no rule for the destination must not silently re-open the
function-broad grant. Per-endpoint posture is honored: an `enforce`-mode
endpoint refuses out-of-scope functions (`denied_by_enforce_rule`), while an
`audit`-mode endpoint observes-and-forwards them (`audit_only`, W178's
documented posture). The core decision is not modified; the tier is the
deny-by-default posture the proxy applies on top of it (`applyEgressPolicyTier`).
Load-time policy validation (`validateEgressPolicy`) remains the caller's
startup gate.

**Ordering and payload extension point (W180 A4).** The gate order is: gate 1
`checkEgressCredential` → the origin-form guard → the W180 policy gate → the
lane parse and body-transform seam → gate 2 `checkCredentialEndpoint` → header
injection → forward. The after-policy-before-injection ordering is pinned by
test
(`test/model-usage-proxy.test.ts`), not a comment: a body transform can never
observe the resolved upstream key, and a policy-refused request never reaches
the transform seam. The same policy seam carries the C3 payload size-ceiling
extension point (`maxRequestBodyBytes`): a body over the configured limit is
refused with the named `payload_too_large` error before any transform or
injection, with a value-free event carrying byte counts only. Default dark.

**Narrowing, stated precisely:** for proxy-passed traffic whose proxy is
composed with an `egressPolicy`, the function-broad grant of §2 is narrowed to
the policy's allowed function set. This is **not** an erase of the residual:
absent a policy the function-broad grant is unchanged; a policy with no
matching rule denies (fail closed) rather than falling through; and the §5
bypass (an agent that reaches a host directly, outside any proxy) is entirely
unaffected. W184 composes a production policy source: the hub loads the W183
`WORKFLOW_EGRESS_POLICY_FILE` per turn (so a merged approval is consulted) and
the standalone server CLI loads it once; absent a file the tier stays dark.
The mechanism remains **scoped to where a policy is actually supplied** — that
is the operator's configuration, not a claim about an unconfigured host.

Verified by `test/model-usage-proxy.test.ts` (the proxy boundary: in-policy
forward, out-of-policy refusal with the named label, default dark,
deny-by-default `no_matching_rule`, log hygiene, the ordering invariant, and
the size ceiling) and by `test/open-model-proxy.test.ts` (the W070a per-family
proxies inherit the tier by composition, not reimplementation). The tier's
pure composition over `decideEgress` is additionally covered by the W178
decision tests in `test/egress-policy.test.ts`.

**Production activation status (honest).** The gate-2 mechanism and its pure
decision are landed and tested. W184 wires a production binding source: the
single-origin proxy lanes (opencode/cline/goose + the W129 server lane) resolve
the upstream origin's binding from the operator credential definitions'
`allowedEndpoints` (`src/integrations/egress-binding.ts`) and thread it into
`createModelUsageProxy`; the standalone server CLI does the same. The W070a
open-source-pool family proxies are wired through the SAME `allowedEndpoints`
source, narrowed per family against each vendor's OWN origin
(`perFamilyCredentialBinding`): a definition binding the vendor host/port scopes
that family, and a family whose origin no definition binds stays dark
(byte-identical). Deriving the family binding from the OpenRouter origin would
not match a vendor host and could only 403 all family traffic, so the origin is
the vendor's, not `WORKFLOW_ACP_UPSTREAM`. The binding is
narrowed to the proxy origin — an endpoint naming a different host/port is
dropped, because the single-origin proxy could only blanket-refuse, never scope,
such a request. With no definition binding the origin the gate stays **inactive
and byte-identical**. The keys the proxy injects are still loaded from
`src/integrations/upstream-key.ts` (`WORKFLOW_UPSTREAM_KEY` /
`~/.config/workflow/upstream-key`) on the single-origin lanes and
`src/integrations/open-model-keys.ts` on the family lanes, custody paths
separate from `CredentialDefinition.allowedEndpoints`; the binding scopes *where
that key may go*, it does not make the key an identity proof. The residual-risk
narrowing above is therefore **live wherever an operator declares an endpoint
binding AND the family's key is present** (a family with no key composes no
proxy and falls back to OpenRouter), and absent (unchanged) otherwise — it is
not a blanket enforced claim. It is verified by `test/egress-binding.test.ts`
(the origin-narrowing source and the per-family narrowing),
`test/open-model-proxy.test.ts` (the family boundary), and the W184 server-lane
wiring pin in `test/opencode-server-egress-wiring.test.ts`.

## 4. Destination and function inventory

Every external destination referenced by agent-facing code, and the functions
reachable through it. "Observed in code" means a path the code actually
constructs; "also reachable" means the proxy does not filter paths, so the
upstream's other origin-form functions are reachable with the injected key.

| Destination | Composed by | Functions observed in code | Also reachable (path not filtered) | Credential held by boundary |
| --- | --- | --- | --- | --- |
| `https://openrouter.ai` (via metering proxy) | OpenCode + goose + Cline runtimes (`WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai"`); `openrouter/auto` alias pool | `POST /api/v1/chat/completions` (agent chat; usage accounting forced); `GET /api/v1/models` (alias resolver and model catalog) | Other origin-form OpenRouter API paths the standard API key can reach (e.g. completions, embeddings, generation); key-management functions require a management key, which the proxy does **not** inject | Standard upstream API key (`loadUpstreamApiKey`) |
| `https://api.deepseek.com` (via per-vendor proxy) | W070a open-model pool (`deepseek-flash`), only when a DeepSeek key is present | `POST /chat/completions` (OpenAI wire; agent appends the path) | Any origin-form path on the origin | DeepSeek vendor key (`loadOpenModelKeys`) |
| `https://api.z.ai/api/paas/v4` (via per-vendor proxy) | W070a open-model pool (`glm-5.3`, `glm-5.3-flash`) | `POST /chat/completions` (OpenAI wire) | Any origin-form path on the origin | Z.ai vendor key |
| `https://api.moonshot.ai/v1` (via per-vendor proxy) | W070a open-model pool (`kimi-k3`) | `POST /chat/completions` (OpenAI wire) | Any origin-form path on the origin | Moonshot vendor key |
| `https://openrouter.ai/api/v1` (hub web usage route, **not** agent egress) | `src/integrations/openrouter-analytics.ts`, server-side for the operator Usage page | `GET /analytics/meta`, `POST /analytics/query`, `GET /credits` | — | Dashboard-created **management** key; never injected into an agent, and not the standard key the proxy holds |

**No file-upload or webhook endpoints are used anywhere in code.** No
code constructs an upload, multipart, or webhook call to any of these
destinations. That is the honest current state; it is not a statement that the
upstreams lack those functions — they are part of the broad grant described in
§2.

The `anthropicEndpoint` values in `model-profile.ts` (`/anthropic` bases for
DeepSeek, Z.ai, Moonshot) are declared vendor facts. The pool default wire is
OpenAI chat for all three families, so those Anthropic endpoints are
documented but not exercised by default; where W070b's replay policy diverts a
synthesized tool-call turn (`route-anthropic`), the proxy answers `409` at
this boundary rather than forwarding.

## 5. Bypass note — honest scope

The token-bound check is enforceable **only** for traffic that routes through
a proxy. The contained agent runs with `network=host` for model egress (it
must reach its provider), so:

- **Blocking happens only at the enforced boundary.** An agent that connects
  directly to a host — any host, not only the allowlisted ones — bypasses the
  proxy entirely; nothing in this repository blocks that at the network layer.
- **Detection happens only where a proxy is interposed.** A foreign
  credential is detectable/rejectable at the proxy; on a direct path it is at
  best observable through OS/network tooling outside Workflow.
- **Payloads are not inspected.** `createModelUsageProxy` observes request
  volume and meters usage; it does not read or filter request/response
  content. Token binding prevents key substitution, not content exfiltration
  under the hub token. W180's size ceiling (§3b) is an optional byte bound, not
  content inspection, and is dark unless composed.
- **`network=host` is a containment property, not an egress policy.** See the
  C3 residual in `THREAT_MODEL.md`; the per-run budget caps bound channel
  capacity only.

## 6. Residual risks and unverified claims

1. The enforcement claim is scoped to the proxy boundary; the direct-egress
   bypass in §5 remains open and is recorded in `THREAT_MODEL.md`.
2. `checkEgressCredential` matches the placeholder **value**; it does not
   cryptographically prove the placeholder was hub-provisioned. Any process
   that can present that constant passes. This is a value discipline, not an
   identity proof.
3. Live, end-to-end verification against real vendor endpoints was **not**
   run for this item: the env-gated probe `test/open-model-probe.test.ts`
   (`WORKFLOW_OPEN_MODEL_LIVE=1` plus a vendor key) exercises the same proxy
   placeholder discipline (it sends `authorization: Bearer workflow-metered`),
   but no vendor key was available in this environment, so the live verdict
   remains unrun. The token-binding behavior is covered by loopback tests.
4. Function-class classification by `egress-audit-mcp` is a heuristic over
   reported reaches; it is advisory evidence and never enforcement (see the
   product README's trust boundaries).

## 7. Follow-ups (partially landed; remaining work stated)

- **W181 (A5, 2026-10-02): proxy reaches and rejections auto-feed
  `egress-audit-mcp`.** The metering proxy now emits a typed `EgressObservation`
  on every forwarded request (`reach`) and at the credential boundary
  (`reject`), carrying the bare destination hostname, a path-derived function
  class, and the token class. `src/integrations/egress-audit-client.ts` maps
  each shape onto the ledger's `AppendReachInput` / `AppendRejectInput` and
  appends it over MCP (the `project-memory.ts` client pattern; `src/` does not
  import across the `mcp-toolbox/` package boundary). Rejections land in a
  separate `rejects` store (a rejection reached no destination, so it carries no
  anomaly flags) with the refusing `policy` tag. The OpenCode runtime composes
  the feed behind `WORKFLOW_EGRESS_AUDIT_FEED=1` and only when the vendored
  ledger build is present; the ledger stays advisory/read-only evidence and
  never blocks. HONEST WIRING BOUNDARY: (1) the feed is **opt-in** — OFF by
  default, so a production run needs the operator to set the env flag; (2) the
  Cline and goose runtime sites are not wired (the W181 issue scopes the OpenCode
  lane); (3) the feed observes what the proxy already decided — it is evidence,
  not a gate. No secret, placeholder value, path, or query string is persisted:
  the seam carries a bare hostname, a bounded function-class label, a closed
  token class, and a bounded policy tag only.
- **W180 (A3/A4, 2026-10-02): payload-level egress policy extension point and
  the size-ceiling stage.** `payloadPolicy` (`ProxyPayloadPolicy`) is the C3
  extension point, dark by default; the proxy rejects an oversize request body
  with the named `payload_too_large` error. Content classification/filtering
  itself is still not built. See §3b.
- Any future network-layer egress control is out of scope for this item and
  would need its own work item and probe evidence.