# W205 spec: assistant tool authority (M4, after the two decisions)

Date: 2026-10-16. Branch: `feat/w205-assistant-tool-authority`. Base: `16ff0b95`.

## Goal

M4 (`augur/docs/integration-plan.md`) wires the assistant gateway to the tool
loop W202 built (`src/integrations/assistant-tool-loop.ts`). The loop is
complete and tested but has no caller and no real executor. This wave supplies
the executor: classify each MCP tool, run the canonical authority ordering
(`authorize()` then `guard_check`), park a guard `ask` on the operator broker,
and bind a run.

W202 left two operator decisions open. Both are **RESOLVED (2026-10-16)**:

**(a) Launch model = keep the current split.** The plane writes MCP config and
the sandboxed agent launches the servers (`opencode-agent-config.ts:382-399`).
`guard_check` stays in-process (`mcp-toolbox-guard.ts:76-121`,
`createWorkflowGuardMcpProvider`), never over stdio after C2. The M4 row's
"hub-launched stdio toolbox" wording was the error. The executor port therefore
targets the **in-process guard provider**; M4 adds no server lifecycle to the
plane.

**(b) Capability classification = declared per-tool map.** Each MCP server
declares a capability per tool. The executor looks the tool up and passes the
declared capability as `action.capability` to `authorize()`. A tool absent from
the map **fails closed to the most restrictive class** (`process` + `mutating`,
mirroring `src/adapters/opencode.ts:40` and `acp.ts:49`). This makes
`setCapability` (`workflow.ts:168-174`) reachable, so the care route's withheld
set (today a display-only label, `src/cli/hub.ts:414-427`) becomes enforcement.

## Seam map (recon, at base `16ff0b95`)

| Concern | Reusable seam | Note |
| --- | --- | --- |
| The loop | `src/integrations/assistant-tool-loop.ts` | `AssistantToolExecutor` is the injected port this wave fills |
| Canonical ordering | `src/integrations/opencode-server-authority.ts:318-395` | kernel-first (`application.authorize`) then guard; guard `ask` parks on the broker in `ask-me`, fails closed in `auto-resolve` |
| Host capability mapper | `src/integrations/opencode-server-authority.ts:912-921` (`opencodePermissionCapability`) | maps host tool names; the MCP map is a NEW sibling |
| Guard (in-process) | `src/integrations/mcp-toolbox-guard.ts:298-349` (`guardInputFromToolCall`), `:196` (`createDefaultToolboxGuardProvider`) | `guard_check` in-process |
| Ask parking | `src/ui/permission-broker.ts:409-450` (`parkAsk`/`answerAsk`), `:458` (`askHold`) | the one operator ask transport |
| Run binding | `src/integrations/run-registry.ts:543` (`begin`), `:636` (`finish`), `:114-137` (`RunOrigin`) | `RunOrigin` is a closed union; needs an `assistant` variant |
| Withheld set | `src/application/workflow.ts:218` (`authorize`), `:243-252` (`CAPABILITY_WITHHELD`), `:168-174` (`setCapability`) | `setCapability` is process-global today |
| Gateway composition | `src/cli/opencode-server.ts:244,462-517`; `src/integrations/opencode-server-gateway.ts:280` | the gateway carries `config` + `egressUrl` today; the executor rides alongside |
| Proposal shape | `src/application/host.ts:22-35` (`ProposedToolAction`) | `capability`, `mutating`, `subjects`, `input` |
| MCP tool catalog | `mcp-toolbox/apps/learning-mcp/src/server.ts` (`learning_checkpoint`, `record_learning_evidence`, `decision_checkpoint`, `resolve_decision_checkpoint`, `learner_profile`) | the declared map's first entries |

## Slices

Each slice is its own PR off `16ff0b95` (or the prior slice's merge), in order.
Every slice: `npx tsc --noEmit` 0, `npm run lint` 0, `npm run build` clean, new
suite registered in sorted `test/ci-suites.txt`, ledger under `docs/ledger/`.

### S1 (W205): the MCP capability map

**New:** `src/integrations/mcp-tool-capability.ts`.

- `McpToolCapabilityMap` — a `Readonly<Record<string, { capability: ToolCapability; mutating: boolean }>>`
  keyed by tool name, loaded from config (fail closed on a malformed entry).
- `classifyMcpTool(name, map)` → the declared class, or the **strictest default**
  (`process` + `mutating`) when the name is absent. Never returns `undefined`:
  the loop must always have a capability to hand `authorize()`.
- A helper that seeds a map entry from an MCP tool's own `annotations` block:
  the servers ALREADY declare `readOnlyHint`/`idempotentHint` per tool
  (`mcp-toolbox/apps/learning-mcp/src/server.ts:114,149,169,185,201`), so a
  `readOnlyHint: true` tool maps to `read` + non-mutating and everything else to
  `mutation` + mutating. The operator config map overrides the annotation when
  both are present (a declaration the operator composed wins over one the server
  shipped).
- A `label` passthrough so a denied call names the source (`care route withholds
  capability network for tool deep_research`).

Tests (`test/mcp-tool-capability.test.ts`): declared hit returns the declared
class; absent name returns `process`/`mutating`; a malformed map fails closed;
`learner_profile` (annotated `readOnlyHint: true`) classifies `read`; an operator
override beats the annotation; the learning-mcp tool names classify per the
deployed map.

### S2 (W205): the executor port — authorize + guard + ask parking

**New:** `src/integrations/assistant-tool-executor.ts`.

`createAssistantToolExecutor({ application, guard, hold, sessionId, taskId, workspace, capabilities })`
returns an `AssistantToolExecutor`:

1. `classifyMcpTool(call.name, capabilities)` → `{ capability, mutating }`.
2. Build a `ProposedToolAction` (`sessionId`, `taskId`, `tool: call.name`,
   `capability`, `mutating`, `subjects` from the resolved guard input,
   `input: JSON.parse(call.arguments)` — a malformed JSON body fails the call
   closed, never throws past the loop).
3. `application.authorize(proposal)` — a denial returns `{ content: reason,
   isError: true }` (the loop surfaces it as an observation).
4. Guard input. `guardInputFromToolCall(name, input, workspace)` maps host tool
   names only and returns `undefined` for an arbitrary MCP tool
   (`mcp-toolbox-guard.ts:298-349`). For an MCP tool, build the guard input
   directly as `{ action: "mcp", toolName: name, ...(workspace === undefined ?
   {} : { workspaceRoot: workspace }) }` — the guard already has an `mcp` action
   path keyed on `toolName` (`guard-policy/policy.ts:205-207`,
   `guard-policy/mcp-policy.ts`), so no guard change is needed. Then
   `guard.guardCheck(input)`. A guard `ask` parks on `hold.park(...)`;
   `reject`/timeout → error observation, `once` → proceed. `deny` → error
   observation. A guard throw fails closed.
5. On allow, **dispatch**: hand the call to an injected
   `AssistantToolDispatcher` port (`dispatch(call, context, toolClass)` →
   `AssistantToolResult`). S2 ships no real dispatcher: the port is injected so
   S2's tests run against a fake and S2 does not depend on a live server. S4
   composes the real dispatcher (an MCP client for the tool's server on the
   coding/tutor routes; the contained shell executor for a coding route's shell
   tool). This keeps S2's job purely the authority ordering: classify,
   `authorize`, guard, ask-park, then delegate.

Tests (`test/assistant-tool-executor.test.ts`): an allowed read-class tool
delegates to the dispatcher and returns its result; a withheld capability (care
route, `network` withheld) returns a `CAPABILITY_WITHHELD` observation and the
dispatcher is never called; a guard `ask` with `reject` returns an error
observation and never dispatches; `once` proceeds; a guard `deny` returns an
error observation; a guard throw fails closed; malformed `arguments` fails
closed; the strictest default governs an unknown tool (its proposal carries
`capability: "process"`, `mutating: true`).

### S3 (W205): wire the gateway to the loop

**Edit:** `src/integrations/assistant-gateway.ts`.

- `handleAssistantRequest`'s `deps` gains an optional
  `executor?: AssistantToolExecutor` and `completionClient?:
  AssistantCompletionClient`. When a request carries tools AND an executor is
  configured, the gateway buffers and runs `runAssistantToolLoop` and answers
  with the final JSON body; otherwise the M1 passthrough is byte-identical.
- `createAssistantGateway` and the front-door call site
  (`opencode-server-gateway.ts:280`) thread the optional executor through.
- The default `AssistantCompletionClient` (used when none is injected) POSTs the
  body to `deps.egressUrl` + `/chat/completions` with the placeholder
  authorization and parses the JSON response. A tool-carrying request is never
  streamed: the loop needs the full `choices[0].message`. The client is
  injectable so the test can script round-trips without a live egress.

A request with `tools` where NO executor is configured keeps the M1 passthrough
(the executor is opt-in, so an unconfigured ingress is byte-identical).

Tests (`test/assistant-gateway-tool-wiring.test.ts`): a no-tools request stays
byte-passthrough (assert the egress saw the injected system prompt and untouched
body); a tools request with an injected executor + scripted completion client
runs the loop and returns the final JSON; a tools request with NO executor stays
passthrough; a streaming no-tools request is untouched.

### S4 (W205): hub-hosted execution, run binding, withheld enforcement

**Topology decision (operator, 2026-10-16): hub-hosted execution.** The M1
gateway runs in the `opencode-server` daemon process, but the operator
`PermissionBroker` (`hub.ts:169`) and the run registry (`run-registry.ts`) live
in the `hub` process. In the deployed plane both run in one container over
loopback (`docs/HOSTING_ASSESSMENT_2026-09-30.md:100,127`). Rather than stand a
second broker in the daemon, the daemon forwards each authorized tool-call round
to a new hub loopback route and the hub composes the executor with its broker and
registry. Both the ask and the run then stay where they already live.

**New (hub):** a Workflow-owned route on the hub daemon, e.g.
`POST /assistant/tool-call`, token-authorized like the other hub routes
(`hub-http.ts:395-406`). It:
1. Resolves the identity → route from the loaded `WORKFLOW_ASSISTANT_ROUTES`
   config (the hub already loads it: `hub.ts:409-427`).
2. Composes a **fresh `WorkflowApplication` per identity/session** whose
   `allowedCapabilities` is the full set minus the withheld set when the route is
   `care` (the per-session pattern at `hub.ts:290`, `:312-318`). Do NOT use
   process-global `setCapability`: it would withhold from every session.
3. Composes `createAssistantToolExecutor` with that application, the in-process
   guard, `permissionBroker.askHold(sessionKey)`, and a run
   (`run-registry.begin`, `origin.kind === "assistant"`).
4. Runs ONE tool call and returns the observation JSON. Per-call (not the whole
   loop) keeps the daemon↔hub hop stateless and the ask lifecycle simple.

**Edit (daemon):** `src/cli/opencode-server.ts` composes a dispatcher
(`assistant-tool-hub-client.ts`) that POSTs each call to the hub route and parses
the observation. The executor reads hub discovery per call, so it is composed
whenever the assistant lane exists and each call fails CLOSED with an error
observation when no hub is reachable — never a silent local allow and never a
passthrough that would let the model believe a tool ran.

**Edit:** `run-registry.ts:114-137` — `RunOrigin` gains
`{ kind: "assistant"; identity: string }`.

Tests:
- `test/assistant-withheld-enforcement.test.ts`: a `care` identity requesting a
  withheld capability (`network`) gets a `CAPABILITY_WITHHELD` observation and no
  dispatch; a `coding` identity with the same tool succeeds; the withheld set is
  per-session (a coding session in the same process is unaffected).
- `test/hub-assistant-tool-route.test.ts`: the hub route parks a guard `ask` on
  the broker (observable on `/api/permission`), an `answer` resolves it, and a
  `reject` fails the call closed. The run lands with `origin.kind ===
  "assistant"`.
- Run-origin round-trip: `origin.kind === "assistant"` renders in the runs view.

## Acceptance (the M4 row)

A LibreChat coding prompt that requires a file write yields a `guard_check` ask
parked on the operator broker, approves, mutates under a worktree, and the run
task `run:<runId>` exists with `origin.kind === "assistant"`. Negative: a
care-route login asking for the same tool gets `CAPABILITY_WITHHELD`.

## Not in this wave

- The M4 row's "coding route rents OpenCode headless per job under containment":
  the coding route today dispatches through the contained shell executor (S2),
  which is sufficient for the file-write acceptance. Renting a full OpenCode
  headless session per coding job is its own decision (cost + lifecycle).
- `setCapability` per-session scoping: S4 uses the existing fresh-application
  pattern instead, so the process-global `setCapability` is untouched. Record
  that in the S4 ledger.
