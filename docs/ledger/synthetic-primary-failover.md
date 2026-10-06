<!-- Ledger fragment: opened 2026-10-02 on branch feat/synthetic-primary-origin as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### Synthetic as primary metered upstream with OpenRouter failover (W095 key 4 activated) (2026-10-02)

**Source:** operator direction (2026-10-02): pivot to Synthetic
(`https://api.synthetic.new`, OpenAI-compatible, `Bearer $SYNTHETIC_API_KEY`)
as the PRIMARY provider, failing back to OpenRouter when rate limited. Four
operator decisions were taken before any edit:

1. **Topology**: Synthetic is the primary upstream of the existing loopback
   metering proxy; OpenRouter is the automatic failover (routing-policy key 4).
2. **Trigger**: 429 + 5xx + connection-level failure, pre-first-byte.
3. **Fallback model**: always `openrouter/auto` (deterministic, always
   resolving; no per-alias map).
4. **Posture**: enabled by default.

**What landed.**

- **New pure policy module `src/integrations/synthetic-provider.ts`** — hosts,
  upstreams, key env/file names, the config composition (`resolveMeteredLane`),
  the failover decision (`isFailoverStatus`: 429 or 5xx), the fixed fallback
  body (`fallbackBody`: `model -> "openrouter/auto"`), and the structured
  logger. No IO, so the policy is unit-testable without a network.
  `SYNTHETIC_HOSTS` accepts only `api.synthetic.new`; Synthetic serves no
  `~...-latest` aliases.
- **The proxy seam `src/integrations/model-usage-proxy.ts`** — a new
  `syntheticFailover` option. On a failure-class status (429/5xx) or a
  connection-level rejection, the request is retried ONCE against the fallback
  origin, pre-first-byte, with the body re-pinned to `openrouter/auto` and the
  fallback key injected. The failed primary response is drained so its socket
  is released. Both upstreams rate-limited surfaces the fallback's 429 (no
  loop). A 400/401/404/409/422 is surfaced as-is (never failed over). The
  failover composes the SAME pre-first-byte limitation the routing policy
  already records: an SSE stream that fails mid-stream surfaces as an error.
- **Primary-hop path translation** (`syntheticUpstreamPath`) — the agent's
  metered provider uses baseURL `<proxy>/api/v1` (the OpenRouter shape), so the
  proxy receives `/api/v1/chat/completions`. OpenRouter serves that path, but
  Synthetic serves `/v1/chat/completions` (verified LIVE 2026-10-02:
  `/api/v1/chat/completions` returns `404 API route not found`;
  `/v1/chat/completions` and `/openai/v1/chat/completions` exist;
  `/v1/models` and `/openai/v1/models` both return the `syn:*` catalog). The
  primary hop rewrites `/api/v1/...` to `/v1/...`; the OpenRouter failover hop
  keeps the original path. Without this the Synthetic lane would 404 on every
  request — a 404 is NOT a failover trigger, so the failure would surface
  instead of recovering.
- **Primary-hop model mapping** — the hub composes `openrouter/auto` as the
  agent's default model (a picker-valid built-in catalog id, and the id the
  v2 ACP pin requires). On the Synthetic primary hop the proxy rewrites that
  id to `syn:large:text` (`SYNTHETIC_DEFAULT_MODEL`, the same default the
  reference plugin's `primaryModel` uses) so Synthetic receives a model it
  recognizes; the agent-visible/picker ref is untouched. Only the auto-router
  slug is mapped — an explicit operator `WORKFLOW_OPENCODE_MODEL` passes
  through. The fallback maps to `openrouter/auto`, which is OpenRouter's wire
  id verbatim (see the alignment section below).
- **A bounded failover journal** (`ModelUsageProxy.failovers()`, 64 entries,
  observation only) records `{ status, fromModel, toModel, at }`; status is
  `undefined` for a connection-level failover. A `console.error` sink
  (`logFailover`) supplies the runtime default.
- **Runtime wiring** — `acp-runtime.ts` (OpenCode ACP + Cline), the goose
  OpenRouter fork, and `opencode-server-runtime.ts` all resolve the lane
  through `resolveMeteredLane`. Synthetic key resolution order: `SYNTHETIC_API_KEY`
  env, then `synthetic.key` in the OpenCode auth store, then
  `~/.config/workflow/synthetic-api-key` (`readWorkflowKeyFile`).
- **Operator surface** — `GET /api/settings/agents` facts gain
  `syntheticKeyPresent` and `syntheticEnabled` (presence booleans only).
- **Env**: `SYNTHETIC_API_KEY`, `WORKFLOW_SYNTHETIC` (default on; `0`/`false`
  disables the pair). `WORKFLOW_ACP_UPSTREAM` still wins when set.

**Landing posture (the operator's "enable by default immediately", made safe).**
The pair is active by default whenever a Synthetic key is RESOLVABLE. With no
resolvable Synthetic key the proxy keeps today's single-upstream OpenRouter
behavior byte-for-byte, so a keyless checkout does not fail. An EXPLICIT
`WORKFLOW_ACP_UPSTREAM` is always honored and never silently overridden: if it
names Synthetic and a key exists the pair composes; otherwise the configured
upstream runs alone. The OpenRouter fallback requires the existing upstream
key; with neither key the lane is unavailable, and the pre-pivot
`loadUpstreamApiKey` missing-key error still stands where it stood.

**Honest limits (stated, not hidden).**

- The failover is best-effort, NOT a guarantee. It fires only before the first
  response byte; a mid-stream Synthetic failure surfaces as an error to the
  agent (the recorded SSE limitation, now the live key-4 behavior).
- The fallback model is fixed at `openrouter/auto` per the operator decision;
  a Synthetic model id is never translated to a specific OpenRouter model, so
  the fallback model quality is OpenRouter's Auto choice.
- OpenRouter is a runtime PREREQUISITE: every runtime loader resolves the
  OpenRouter key through `loadUpstreamApiKey`, which throws when absent. The
  `resolveMeteredLane` Synthetic-only branch (no OpenRouter key) is unit-tested
  but not reachable through the current callers; making it reachable is a
  follow-up (return `""` rather than throw when a Synthetic key exists).
- The budget downgrade (`WORKFLOW_BUDGET_DOWNGRADE_MODEL`) is NOT translated
  on the Synthetic lane; its default target is an OpenRouter slug, which
  Synthetic rejects without failover. An operator using downgrade on this lane
  must set a Synthetic target.
- No live probe was run through an agent: Synthetic's behavior inside the
  pinned OpenCode version and the metering shape of `syn:` model ids are
  UNVERIFIED. What IS live-verified (2026-10-02, unauthenticated `curl`): the
  `syn:*` catalog at `/v1/models` and `/openai/v1/models` lists
  `syn:large:text -> DeepSeek V4.1 Flash` (with reasoning efforts
  `none|low|high|xhigh|max`), and `/api/v1/chat/completions` 404s while
  `/v1/chat/completions` exists. The policy is proven by focused loopback tests
  (`test/synthetic-provider.test.ts`, 20/20), not by a live completion. The lane
  should be treated as unproven until a gated live probe records its verdict.
- Cline is probe-PENDING on stock 3.0.62 and unchanged by this record.

**Alignment with the proven `ultus-net/opencode-auto-router` plugin (2026-10-02).**
The operator's working OpenCode V2 plugin was read (repo cloned, source +
README) and the control-plane constants/paths were checked against it. The
plugin is the reference because it is configured correctly and working:

| Concern | Reference plugin | Workflow control plane | Verdict |
|---|---|---|---|
| Primary provider | Synthetic `syn:*` aliases | same | aligned |
| Default model | `primaryModel` default `syn:large:text` (via `syn:auto` remap) | `SYNTHETIC_DEFAULT_MODEL = syn:large:text` | aligned |
| Fallback model id | `openrouter/openrouter/auto` ref → wire `model: "openrouter/auto"` | `fallbackBody` sets `openrouter/auto` verbatim | **corrected** (was bare `auto`) |
| Synthetic catalog URL | `https://api.synthetic.new/openai/v1/models` | `SYNTHETIC_MODELS_URL` added; live-confirmed `/v1/models` too | aligned |
| Synthetic API path | OpenCode's built-in provider hits the right path | proxy translates `/api/v1` → `/v1` | **corrected** (was 404) |
| Failover trigger | `[429]` + message matches (`rate limit`, `quota`, `overloaded`) | 429 + 5xx + connection error | superset (operator chose 429+5xx) |
| Role routing | agent-level routes (vision/small/large) | one model per launch today; `SYNTHETIC_AGENT_ROUTES` documents the target map | documented, not yet wired (W095 key-1) |

The two corrections the reference forced: (1) the fallback wire id is
`openrouter/auto`, not the bare `auto` (both the plugin's captured request body
and this repo's own `isAutoRouterModel`/`DEFAULT_OPENCODE_MODEL` agree); (2) the
primary hop must translate `/api/v1` → `/v1` or every Synthetic request
404s — and a 404 is not a failover trigger, so the lane would have failed hard
rather than recovering. Both now have focused tests.

A review pass also fixed two operator-surface defects and one consistency
gap: `syntheticKeyPresent` now consults the OpenCode auth store's `synthetic.key`
(matching the runtime lane's resolution order, so a `/connect synthetic`
operator sees the truth); all four metered lanes share one
`resolveRuntimeMeteredLane` (OpenCode, Cline, goose, server) so the global
settings fact and the per-lane behavior cannot disagree; and
`test/e2e-settings.test.ts` deletes ambient `SYNTHETIC_API_KEY`/
`WORKFLOW_SYNTHETIC` so the facts pin cannot flake on the deploy host. Dead
`SyntheticFailoverProxyOptions` fields (`primary`/`primaryApiKey`) were removed;
the proxy uses its own `upstream`/`apiKey` for the primary hop.

**Evidence (branch `feat/synthetic-primary-origin`, base `origin/main@ecd0e656`).**

- `test/synthetic-provider.test.ts` 21/21 (pure policy + proxy integration:
  429, 503, connection failure, 400 no-failover, both-429 no-loop, the
  fallback-terminal invariant, the `/api/v1`→`/v1` path translation with the
  fallback keeping `/api/v1`, the primary-hop model mapping, the
  reference-alignment constant pin, the auth-store key parser, the
  messages-lane byte-identity scope, no-composition regression).
- Regression battery `test/{model-usage-proxy,open-model-proxy,affinity-pin,opencode-server-runtime,acp-runtime-agent,session-budget,model-replay-proxy,budget-downgrade-auto-lane,openrouter-auto-latest,upstream-key,security-assurance,e2e-settings,web-settings-endpoints,webapp-surface,open-model-keys,open-source-pool,web-agents,web-agents-endpoints}.test.ts`
  + synthetic-provider: **216/216**.
- `npm run lint` exit 0; `npm run typecheck` exit 0; `npm run build` exit 0.

**Supersession binding:** this record SUPERSEDES the "key 4 is NOT wired"
statements in `docs/MODEL_ROUTING_POLICY_2026-09-23.md` (§2 row 4, §4, §5, §8),
`docs/AFFINITY_ROUTING_SPEC_2026-09-24.md`, and
`docs/ledger/{p15-auto-downgrade,affinity-pin}.md`. Key 4 is now wired for the
Synthetic→OpenRouter pair only; the open-source-pool lane's own
`resolveOpenModelRoute` fallback remains unwired (zero production callers), and
that is still true.
