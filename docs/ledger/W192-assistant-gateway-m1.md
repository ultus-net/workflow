<!-- Write-once ledger fragment. Append dated supersession notes; never rewrite. -->
### W192 (assistant gateway) — M1: the assistant gateway lane

**Source:** assistant-gateway M1 brief (branch `feat/assistant-gateway-m1`). The
milestone builds an OpenAI-compatible endpoint that binds an IDENTITY to a ROUTE
POLICY and injects a per-route system prompt, with NO tools. It reuses the
metered egress proxy for metering/egress/credential rather than re-implementing
them.

**Numbering note.** W185 (SHA-pin / tier-pin), W186 (kernel-purity gate), W188
(dependabot lane), and W191 (kernel-purity lexer) are all taken by other
workstreams. The assistant gateway takes the next free number, W192.

**Decision.**
- **Identity → route.** `src/integrations/assistant-gateway.ts` reads the
  `x-workflow-user` header (the identity: a LibreChat userId or a Discord
  snowflake) and resolves `config.identities[id]` → `config.routes[route]`. A
  missing or unbound identity fails closed with a 403 and still counts as
  handled — it never falls through to a dispatcher that might forward the
  request unmetered.
- **System-prompt injection.** The route's `systemPrompt` is PREPENDED as a
  `{ role: "system", content }` message. An existing system message is prepended
  to, never merged, so the injected prompt and the original messages both survive
  in order. Every other body field (model, stream, temperature, tools, ...) is
  preserved unchanged.
- **Metered egress.** The transformed body is forwarded to
  `${egressUrl}/chat/completions` — the existing metered loopback proxy
  (`createModelUsageProxy`, `src/integrations/model-usage-proxy.ts`) — with the
  placeholder credential the proxy expects. The proxy injects the real key and
  records token/cost usage, so metering, egress policy, and credential custody
  apply to this lane unchanged. The upstream status/headers/body are streamed
  back, so both buffered JSON and SSE pass through.
- **Config.** `loadAssistantGatewayConfig(path)` parses and validates a JSON file
  with a zod schema, failing closed (a thrown `Error`) on a missing file, bad
  JSON, an unknown route name, or an identity mapped to a route absent from
  `routes`. Only `coding`, `tutor`, and `care` are accepted, and all three must
  be present.

**Deliberate M1 scope.** Tools and the authority check are NOT wired. There is no
tool loop and `authorize()` (`src/application/workflow.ts`, returning the
`PolicyDecision` in `src/kernel/contracts.ts`) is not called — the seam is left
for the milestone that adds tools. `CAPABILITY_WITHHELD` is likewise untouched.

**Front-door attach point.** `handleAssistantRequest` is the pure dispatch the
front door calls: it returns true when it handled the request (an assistant
lane) and false otherwise, mirroring the authority-route pattern in
`opencode-server-gateway.ts` `handle()`. Wiring it into `handle()` is the M1
integration point and is not done in this fragment (that file is out of the
milestone's edit scope).

**Verification.**
- `node --import tsx --test test/assistant-gateway.test.ts` — 8 tests: the
  injected-system-prompt-first ordering and field preservation, prepend-not-merge
  on an existing system message, unknown/missing identity 403, malformed-JSON
  400, the non-`/chat/completions` false return, and the config validation
  fail-closed case.
- `npx tsc -p tsconfig.json --noEmit` and `npx eslint src test` — clean.
