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
4. `guardInputFromToolCall(call.name, input, workspace)` → `guard.guardCheck`.
   A guard `ask` parks on `hold.park(...)`; `reject`/timeout → error observation,
   `once` → proceed. `deny` → error observation. A guard throw fails closed.
5. On allow, **dispatch**: for a `read`-class MCP tool, call the tool via the
   injected `McpToolClient` (the stdio pattern from `project-memory.ts:66-120`);
   for a `process`/`mutation` tool, route through the contained shell executor.

The dispatch client is a second injected port, so S2's tests run against a fake
and S2 does not depend on a live server.

Tests (`test/assistant-tool-executor.test.ts`): an allowed read-class tool runs
and returns content; a withheld capability (care route, `network` withheld)
returns a `CAPABILITY_WITHHELD` observation and the dispatch client is never
called; a guard `ask` with `reject` returns an error observation; `once`
proceeds; a guard throw fails closed; malformed `arguments` fails closed; the
capability map's strict default governs an unknown tool.

### S3 (W205): wire the gateway to the loop

**Edit:** `src/integrations/assistant-gateway.ts` — `handleAssistantRequest`
buffers when `hasTools(body)` is true and runs `runAssistantToolLoop` with the
injected `executor` + `client`, else the existing M1 passthrough. Streaming with
no tools stays passthrough (no regression).

`AssistantCompletionClient` for a buffered request: POST the body to
`deps.egressUrl` and parse the JSON (the loop needs the full `choices[0].message`,
so a tool-carrying request is never streamed).

Tests (`test/assistant-gateway-tool-wiring.test.ts`): a no-tools request stays
byte-passthrough; a tools request runs the loop and returns the final JSON; a
streaming no-tools request is untouched.

### S4 (W205): run/session binding + the withheld set becomes enforcement

**Edit:** `src/cli/opencode-server.ts` — compose the executor with a run
(`run-registry.begin`), the workspace `WorkflowApplication`, the in-process guard,
and a broker-backed `hold`. Record `origin.kind === "assistant"` on the run
(`run-registry.ts:114-137` gains the variant).

**Edit:** `src/cli/hub.ts:414-427` — the care route's withheld set drives
`application.setCapability(capability, enabled=false)` at composition, so a care
session genuinely lacks the capability (not a label). Keys the withheld set to
the **care identity's** session, not the process: `setCapability` is
process-global today, so per-session withholding is the real work here — a
session-scoped capability view over `allowedCapabilities`, or a fresh application
per session.

Tests (`test/assistant-withheld-enforcement.test.ts`): a care-route identity
requesting a withheld capability wraps the run in a `CAPABILITY_WITHHELD`
observation; a coding-route identity with the same tool succeeds. Negative:
toggling the capability back on re-admits.

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
- `setCapability` per-session scoping if S4 takes the fresh-application route
  instead. Record which was taken in the S4 ledger.
