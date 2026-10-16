# W205 S4: hub-hosted execution, run binding, withheld enforcement

Date: 2026-10-16. Branch: `feat/w205-hub-hosted-execution`. Base: `c559cae1`.

## Goal

Slice S4 of `docs/ASSISTANT_TOOL_AUTHORITY.md`. S3 wired the M1 gateway to the
S3 tool loop behind an injected executor. S4 composes the real execution path:
identity → route → per-identity run → the route's withheld capability set → the
S3 executor with the in-process guard and the operator broker's ask hold, with
the side effect dispatched through the hub's contained shell.

## Topology decision (operator, 2026-10-16): hub-hosted execution

The M1 gateway runs in the `opencode-server` daemon, but the operator
`PermissionBroker` (`hub.ts:169`) and the run registry (`run-registry.ts`) live
in the `hub` process. In the deployed plane both run in one container over
loopback (`docs/HOSTING_ASSESSMENT_2026-09-30.md:100,127`). Rather than stand a
second broker in the daemon, the daemon forwards each tool call to a new hub
loopback route and the hub composes the executor with its broker and registry.
Both the ask and the run then stay where they already live.

## What landed

**New (hub):** `src/integrations/assistant-tool-host.ts` — the hub-side
composition. `createAssistantToolHost`:

1. Resolves identity → route from the loaded `WORKFLOW_ASSISTANT_ROUTES` config
   (an unknown identity is a 403, fail closed).
2. Resolves or begins the per-identity run. A run active for the session id is
   resolved; otherwise `runs.begin` records `origin.kind === "assistant"` with
   the identity. A concurrent-begin race resolves the now-active run.
3. Applies the route's effective capability grant to the RUN's OWN application
   (`applyRouteCapabilities`): the full set minus the withheld set for `care`,
   the full set for `coding`/`tutor`. The registry constructs a fresh
   `WorkflowApplication` per `begin` (`run-registry.ts:559-565`), so
   `setCapability` here scopes to this run only, never the process (see the
   `setCapability` note below).
4. Composes the S3 executor (`createAssistantToolExecutor`) with that
   application, the S1 capability map, the in-process guard, the broker's
   `askHold(sessionId)`, and a dispatcher built by the composition root.
5. Runs ONE tool call and returns the observation
   (`{ status: 200, body: { result } }`).

**New (hub):** `src/integrations/assistant-tool-dispatcher.ts` —
`createContainedShellAssistantDispatcher`. Maps the coding route's configured
shell tool (`WORKFLOW_ASSISTANT_SHELL_TOOL`, default `run_shell`) to its
`command` argument and runs it through the hub's contained shell seat. Any other
tool name fails closed with a named absence: W205 decision (a) keeps the
sandboxed agent as the MCP server launcher, so the hub holds no MCP client to
dispatch through yet.

**Edit:** `src/integrations/hub-http.ts` — the `AssistantToolCallCapability`
interface and the operator-token `POST /assistant/tool-call` route. A malformed
body is a 400; an absent capability is a 404 (withheld, fail closed); the host's
own status rides through verbatim.

**Edit:** `src/integrations/workflow-hub.ts` — the `assistantToolCall` pre-built
capability and the `assistantToolCallFactory` lazy-handles option (the
`schedulerFactory` pattern), composed after the run registry exists.

**Edit:** `src/cli/hub.ts` — the composition root. Loads
`WORKFLOW_ASSISTANT_ROUTES` ONCE (shared by the W195 route summary and the S4
lane); reads `WORKFLOW_CARE_WITHHELD` once; parses
`WORKFLOW_ASSISTANT_TOOL_CAPABILITIES` (a JSON file, fail-closed via
`parseMcpToolCapabilityMap`, absent → `{}` so every tool classifies to the
strictest class); composes the factory with the run handles, the guard, the
broker, and a dispatcher whose shell seat is bound to the RUN's own application
(`shellExecutorFor(application, undefined, true, guard, undefined, hold)`).

**New (daemon):** `src/integrations/assistant-tool-hub-client.ts` —
`createHubAssistantToolExecutor`. POSTs each authorized call to the hub's
`/assistant/tool-call` route (endpoint resolved per call via
`readHubCredentials`), and parses the observation. Fails the call CLOSED with an
error observation when no hub is reachable or the hub refuses the call — never a
silent local allow, and never an unreadable 2xx passed as success.

**Edit:** `src/integrations/opencode-server-gateway.ts` +
`src/cli/opencode-server.ts` — the gateway's `assistantRoutes` option gains an
optional `executor`; the daemon composes the forwarding executor so a
`tools`-carrying request runs the S3 loop with each call executed hub-side.

## The `setCapability` question

`docs/ASSISTANT_TOOL_AUTHORITY.md` warns: do NOT use process-global
`setCapability`; it would withhold from every session. S4 honors the intent
without a new per-session capability API: withholding is applied to the RUN's own
application, and the registry mints a FRESH `WorkflowApplication` per `begin`
(`run-registry.ts:559-565`). The application instance is therefore per-run, so
`applyRouteCapabilities`'s `setCapability` calls are per-run by construction. A
coding session in the same process keeps its full grant; the process-global
capability set is never touched.

## Withheld vocabulary

Withheld entries are treated as `ToolCapability` names. A non-capability entry
(e.g. `file_write`, `shell`) withholds nothing at this layer: the care
tool-name policy is the M7 domain. `withheldCapabilities` filters the withheld
list to the six capability strings before deriving the grant.

## Acceptance

- `test/assistant-withheld-enforcement.test.ts`: 9/9.
  - a care identity requesting a `network`-class tool gets a
    `CAPABILITY_WITHHELD` observation and the dispatcher is never called;
  - a coding identity with the SAME tool succeeds, and its run's application
    retains `network`;
  - care and coding runs in one host stay isolated (no grant leak);
  - the run is begun with `origin.kind === "assistant"`;
  - an unknown identity is a 403 and begins nothing;
  - non-capability withheld entries are inert; `applyRouteCapabilities` derives
    the full grant minus the withheld set; the run id / task id are stable.
- `test/hub-assistant-tool-route.test.ts`: 11/11.
  - a composed capability answers with the host's observation; an unknown
    identity rides the host's 403; absent capability 404s; a malformed body
    400s; the verifier credential is refused;
  - a guard `ask` parks on the hub broker (observable on `/api/permission`), an
    operator allow proceeds to dispatch, and a reject fails the call closed;
  - the forwarding executor POSTs the exact wire shape to a fake hub, fails a
    call closed with no discoverable hub, and surfaces a non-2xx refusal.
- `test/webapp-runs.test.ts`, `test/activity-timeline.test.ts` (run-origin
  round-trip, `origin.kind === "assistant"`).
- `npx tsc --noEmit` 0, `npm run lint` 0, `npm run build` clean.
- `test/ci-suites-manifest.test.ts` 5/5 (both suites registered in sorted order).

## Not in this slice

- MCP-tool dispatch: the hub holds no MCP client (decision (a) keeps the
  sandboxed agent as the server launcher). A call whose name is not the
  configured shell tool fails closed with a named absence. The MCP dispatch seam
  is its own decision.
- A production `WORKFLOW_ASSISTANT_TOOL_CAPABILITIES` file: the deployed plane
  wires it when the tool surface is fixed. Absent, the map is empty and tools
  classify to the strictest class (fail closed).
- Care's tool-NAME policy (`file_write`, `shell`): the M7 domain.
- The M4 row's "coding route rents OpenCode headless per job under containment":
  the contained shell executor is sufficient for the file-write acceptance;
  renting a full headless session is its own cost + lifecycle decision.
