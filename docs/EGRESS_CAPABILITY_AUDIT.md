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

The proxy is **not** a path allowlist. `handle()` parses the request target as
`new URL(req.url, upstream)` and forwards any **origin-form** target whose
origin equals the upstream origin; absolute-form targets are rejected (P1
regression). So every function on the upstream origin is reachable with the
injected key — the grant is function-broad by construction, and the
destination alone tells you nothing about the blast radius.

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
  under the hub token.
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

## 7. Follow-ups (not done here)

- Wire proxy rejections and reaches into `egress-audit-mcp` automatically
  (today the ledger is fed by explicit `append_egress_reach` calls); W053's
  anomaly signals consume this ledger.
- Payload-level egress policy (size ceilings, content filtering) at the proxy
  remains planned; see the C3 residual.
- Any future network-layer egress control is out of scope for this item and
  would need its own work item and probe evidence.