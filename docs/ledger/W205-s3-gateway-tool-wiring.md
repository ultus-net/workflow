# W205 S3: the gateway tool-loop wiring

Date: 2026-10-16. Branch: `feat/w205-gateway-tool-wiring`. Base: `b0653b48`.

## Goal

Slice S3 of `docs/ASSISTANT_TOOL_AUTHORITY.md`. The M1 gateway
(`assistant-gateway.ts`) was byte-passthrough with no tools. This slice wires it
to the W202 loop for a request that carries `tools`, when an executor is
configured. A request with no tools, or an ingress with no executor, keeps the
M1 passthrough byte-identical.

## What landed

**Edit:** `src/integrations/assistant-gateway.ts`.

- `handleAssistantRequest`'s `deps` gains optional `executor` and
  `completionClient`.
- After the route system prompt is prepended, a request where
  `hasTools(transformed)` is true AND `deps.executor !== undefined` runs
  `runAssistantToolLoop` and answers with the final JSON body (HTTP 200). The
  loop hands the executor the identity and the route, so S2 classifies authority
  per route.
- The default `AssistantCompletionClient` (`defaultCompletionClient`) POSTs one
  buffered round-trip to the metered egress with the placeholder authorization
  and parses the JSON. A tool-carrying request is never streamed: the loop needs
  the full `choices[0].message`. The client is injectable so the test scripts
  round-trips without a live egress.
- A loop throw fails closed with 502 and an `api_error` body.
- `createAssistantGateway` threads the two optional fields through.
- `identity` is narrowed with `route` so the loop receives a `string` identity.

No executor configured → the passthrough forwards the request, tools and all,
exactly as M1 did.

## Acceptance

- `test/assistant-gateway-tool-wiring.test.ts`: 4/4.
  - tools + executor + scripted client → the loop runs (two round-trips), the
    final JSON is returned, the executor saw the identity and the bound route,
    the second request carries the route system prompt plus a tool observation,
    and the egress was never touched.
  - tools + NO executor → M1 passthrough; the egress sees the request with its
    `tools` array intact.
  - no tools + executor configured → M1 passthrough; the egress sees the injected
    route system prompt.
  - tools + executor + NO injected client → the default client drives two egress
    round-trips.
- `test/assistant-gateway.test.ts`: 8/8 (no M1 regression).
- `npx tsc --noEmit` 0, `npm run lint` 0, `npm run build` clean.
- `test/ci-suites-manifest.test.ts` 5/5 (registered in sorted order before
  `test/assistant-gateway.test.ts`).

## Not in this slice

Composing the executor. S4 builds the real dispatcher, binds a run, and drives
the care route's withheld set from config so the loop's denials are reachable
from a live request. Until S4 the executor is injected only in tests.
