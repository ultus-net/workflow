# W205 S5: MCP-tool dispatch (split authority/dispatch, topology Option B)

Date: 2026-10-16. Branch: `feat/w205-assistant-mcp-dispatch`. Base: `029dcc7a`.

## Goal

Close S4's one named deferral: an MCP tool call had no dispatcher, so a call
whose name was not the configured shell tool failed closed. S5 supplies that
dispatcher. It also settles how the seat is chosen: the option the operator
picked (2026-10-16) is **split authority/dispatch — the hub decides, the daemon
dispatches**.

## The decision, and its correction

S4's shape was a single hub hop that did everything, including dispatch
(`assistant-tool-host.ts` composed a `dispatcherFor` and ran it). That only
worked for the coding route's contained shell because the hub owns that seat
(it holds the run's application and the operator ask hold).

A framing correction worth recording: the daemon did **not** hold a live MCP
client to "dispatch against". It writes the MCP config
(`opencode-agent-config.ts:382-399`) and the sandboxed `opencode serve` launches
the servers. So neither process had an MCP client, and Option B means building
one — in the daemon, which already owns the mount config
(`cli/opencode-server.ts:320`) and the containment posture the servers were
probed under.

The seat split that follows is honest about which process can run which tool:

| Tool | Seat owner | Why |
| --- | --- | --- |
| the configured shell tool (`run_shell`) | **hub** | needs the run's application (withholding) + the operator ask hold |
| every MCP tool | **daemon** | the daemon owns the mount config; the hub holds no MCP client |

## What landed

**Edit (executor):** `src/integrations/assistant-tool-executor.ts` — the
authority ordering (classify → `application.authorize` → guard → ask-hold) is
extracted into the shared `authorize(call)` closure. `createAssistantToolExecutor`
now returns `{ execute, authorize }`: `execute` is authorize-then-dispatch (the
single-process path S2 shipped), and `authorize` is the authority half alone.
`AssistantToolAuthorization` is the new closed union (`allow` carries the
classified `toolClass`, or `deny` carries the observation).

**Edit (hub host):** `src/integrations/assistant-tool-host.ts` —
`dispatcherFor` now returns `AssistantToolDispatcher | undefined` and receives
the call's `toolName`. When the composition returns `undefined`, the host runs
`authorize` alone and answers an **allow** with a dispatch directive
(`{ dispatch: { call, capability, mutating } }`); a **deny** stays a terminal
observation. A dispatch is therefore only ever reached AFTER the hub authorized
the call — the daemon never sees an undecided call. `NEVER_DISPATCH` guards the
authority-only branch so a future composition mistake fails closed.

**Edit (hub composition):** `src/cli/hub.ts` — the `dispatcherFor` closure
returns the contained-shell dispatcher ONLY for `WORKFLOW_ASSISTANT_SHELL_TOOL`,
and `undefined` for every other tool. The shell seat is unchanged (still bound
to the run's own application + the broker hold).

**New (daemon):** `src/integrations/assistant-mcp-dispatcher.ts` —
`createAssistantMcpDispatcher({ tools, servers, connect? })`. Holds **no
authority content**: an undeclared tool name fails closed before any connection
is opened. A declared tool resolves its server launch, spawns a stdio `Client`
(`project-memory.ts:66-92` pattern), calls the tool, and closes the connection in
a `finally`. `flattenContent` names any non-text part so a binary/resource result
is honest rather than empty. Also exports `parseAssistantMcpToolServerMap` (the
operator tool→server declaration, fail-closed) and `resolveAssistantMcpServers`
(enabled stdio settings win; a built toolbox-catalog server fills a name the
operator did not declare).

**Edit (daemon executor):** `src/integrations/assistant-tool-hub-client.ts` —
`createHubAssistantToolExecutor` gains an optional `dispatch` port. It reads the
hub reply as a union: `{ result }` is terminal, `{ dispatch: {...} }` is
fulfilled locally. With no `dispatch` composed, a directive fails the call closed
(never a fabricated success).

**Edit (daemon composition):** `src/cli/opencode-server.ts` — reads
`WORKFLOW_ASSISTANT_MCP_TOOLS` (a JSON file of tool→server, parsed at start so a
malformed declaration fails the daemon), composes the MCP dispatcher when the map
is non-empty, and threads it into the forwarding executor.

## Per-call connection lifecycle

Connections are opened per call and closed in a `finally`. An assistant tool call
is not a hot path, and a leaked child process is a worse failure than a
reconnect. This matches the one-shot stdio clients the plane already uses
(`project-memory.ts`, `review-followups.ts`); a pooled client is a later
optimization if call volume ever justifies it.

## Acceptance

- `test/assistant-mcp-dispatch.test.ts`: 11/11.
  - the hub answers a non-owned tool with a dispatch directive AFTER authorizing,
    and the directive carries the classified capability + mutating flag;
  - the hub still denies (terminal observation) a delegated tool the route
    withholds (`CAPABILITY_WITHHELD`) — a denial is never a directive;
  - the hub dispatches its OWN seat (the shell tool) rather than delegating;
  - the forwarding executor fulfills a directive locally, carries the arguments
    through, and fails closed when no local dispatcher is composed;
  - the daemon MCP dispatcher: an undeclared tool fails closed with zero
    connections, a declared tool runs on its server and the connection is closed,
    a server tool error surfaces, malformed arguments fail closed, a tool whose
    server has no launch fails closed;
  - `parseAssistantMcpToolServerMap` fails closed on bad input; and
    `resolveAssistantMcpServers` keeps an operator server, drops a disabled one,
    and fills a built catalog server.
- `test/hub-assistant-tool-route.test.ts`, `test/assistant-withheld-enforcement.test.ts`,
  `test/assistant-tool-executor.test.ts`, `test/opencode-server-assistant-lane.test.ts`,
  `test/assistant-gateway-tool-wiring.test.ts`, `test/assistant-isolation.test.ts`:
  all green after the `dispatcherFor` signature change.
- `npx tsc --noEmit` 0, `npm run lint` 0, `npm run build` clean.
- `test/assistant-mcp-dispatch.test.ts` registered in sorted
  `test/ci-suites.txt`.

## Not in this slice

- A production `WORKFLOW_ASSISTANT_MCP_TOOLS` file: the deployed plane wires it
  when the tool surface is fixed (the M6 evidence tools, the M7 care tools).
- Pooled MCP connections (per-call spawn is deliberate for now).
- Care's tool-NAME policy (`file_write`, `shell`): the M7 domain.
- Durable timers stay dormant: `schedulerFactory` (`cli/hub.ts:674`) still does
  not pass `timers`/`resumeTimer`.
