<!-- Write-once ledger fragment. Append dated supersession notes; never rewrite. -->
### W193 (assistant front door) — attach the M1 assistant lane to the single ingress

**Source:** assistant-front-door brief (branch `feat/assistant-front-door`). W192
landed the assistant gateway mechanism (`src/integrations/assistant-gateway.ts`,
`handleAssistantRequest`) but deliberately left it unattached — the front-door
wiring was out of that milestone's edit scope. This fragment closes that gap: the
deployed plane now serves the OpenAI-compatible assistant endpoint on the same
4096 ingress as OpenCode.

**Numbering note.** W185, W186, W188, W191, and W192 are taken by other
workstreams. The front-door attach takes the next free number, W193.

**Decision.**
- **Attach point.** `handleAssistantRequest` is called from
  `opencode-server-gateway.ts` `handle()` AFTER the client credential gate and
  the hub-route Host dispatch, BEFORE the authority route and the OpenCode route
  matrix. The ingress credential (`tuiPassword`) is therefore still required for
  the lane; the `x-workflow-user` identity is authorization ON TOP of the
  credential, never a replacement for it. The lane is served by the gateway and
  never forwarded upstream.
- **Opt-in.** The lane attaches only when `WORKFLOW_ASSISTANT_ROUTES` names a
  route-policy JSON (validated by `loadAssistantGatewayConfig`, fail closed).
  When absent the option is omitted and the ingress is byte-identical — the
  assistant lane does not exist.
- **Dedicated metered egress.** The assistant lane composes its OWN
  `createModelUsageProxy` pinned to the same OpenRouter upstream as the coding
  lane (`WORKFLOW_ACP_UPSTREAM`), NOT the runtime's Synthetic-lane proxy. It
  threads the same gate-2 credential binding and W180 payload policy as the other
  lanes, so metering/egress/credential custody apply unchanged. The proxy is
  composed immediately before the gateway (after the runtime exists) and is reaped
  on the gateway-composition failure path alongside `authority`/`runtime`/`guard`
  (W094), and on both shutdown paths.
- **Fail closed.** A named assistant lane with `upstreamApiKey === undefined`
  (i.e. `WORKFLOW_UPSTREAM_KEY_FROM` unset/blank) throws a named Error before any
  composition — a lane the metered proxy cannot key is misconfiguration.

**Verification.**
- `node --import tsx --test test/opencode-server-assistant-lane.test.ts` — 5
  tests: a bound identity is served by the fake egress with the tutor prompt
  injected first, an unbound identity is 403 with no egress call, no Basic auth
  is 401 (the credential gate precedes the lane), a non-assistant path still
  reaches the OpenCode upstream, and an absent `assistantRoutes` lets
  `POST /v1/chat/completions` fall through byte-identical.
- `npx tsc -p tsconfig.json --noEmit` and `npx eslint src test` — clean; the
  gateway and assistant-gateway suites pass unchanged (no regression).
