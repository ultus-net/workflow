# W205 S2: the assistant tool executor

Date: 2026-10-16. Branch: `feat/w205-assistant-tool-executor`. Base: `2486551b`.

## Goal

Slice S2 of `docs/ASSISTANT_TOOL_AUTHORITY.md`. Fills the `AssistantToolExecutor`
port the tool loop (W202) left injected. The executor classifies each MCP tool
(S1), runs the canonical authority ordering, and parks a guard `ask` on the
operator hold. Dispatch is a single injected port, so S2 has no live-server
dependency: the module is the authority ordering and nothing else.

## What landed

**New:** `src/integrations/assistant-tool-executor.ts`.

| Export | Role |
| --- | --- |
| `AssistantToolDispatcher` | the injected dispatch port: `dispatch(call, context, toolClass)` |
| `AssistantToolExecutorOptions` | application, capability map, dispatcher, session/task, optional guard/hold/workspace |
| `createAssistantToolExecutor(options)` | returns an `AssistantToolExecutor` |

Ordering, exactly as the daemon seat (`opencode-server-authority.ts:318-395`):

1. **Classify.** `classifyMcpTool(name, capabilities)` → `{ capability, mutating }`.
2. **Parse, fail closed.** Non-JSON or empty `arguments` → an error observation;
   the loop appends it as `role: "tool"`.
3. **Authorize (kernel first).** `application.authorize(proposal)`; a deny OR a
   throw returns an error observation naming the code. The dispatcher is never
   reached on deny.
4. **Guard.** Built directly as `{ action: "mcp", toolName, workspaceRoot? }` (the
   host-tool mapper has no MCP mapping; the guard's `mcp` action keys on
   `toolName`, `guard-policy/policy.ts:205-207`). `deny` → error; `ask` → park on
   the hold (`reject`/timeout → error, `once`/`always` → proceed); a throw → fail
   closed.
5. **Dispatch.** Only an allowed call reaches `dispatcher.dispatch`.

The executor never throws: every failure is an error observation, matching the
loop's own executor-throw path.

## Design notes

- **Decision (b) is now enforced end to end.** A withheld capability produces a
  `CAPABILITY_WITHHELD` observation before the dispatcher is reached, and an
  undeclared tool fails to the strictest class, so it is withheld whenever
  `process` is not allowed. The care route's withheld set is real enforcement from
  here.
- **The guard `ask` never dangles.** No hold configured → fail closed. The spec's
  `ask` semantics follow the authority seat: an ask is a "human decides" verdict,
  not a deny.
- **Dispatch is one port.** S4 composes the real dispatcher (MCP client / contained
  shell). Keeping it injected is what lets S2 test the whole ordering against a
  fake.

## Acceptance

- `test/assistant-tool-executor.test.ts`: 11/11. Allowed read-class tool
  dispatches with the declared class; withheld capability → `CAPABILITY_WITHHELD`,
  no dispatch; unknown tool → strictest class, withheld when `process` absent;
  guard deny → error, no dispatch; guard ask + reject → error, the ask parked with
  the call id and matched surface; guard ask + once → dispatches (and no `matched`
  is fabricated when the decision lacks one); guard ask with no hold → fail closed;
  guard throw → fail closed; malformed and empty arguments → fail closed;
  unknown task → `UNKNOWN_TASK` (mutating tool, since the read path short-circuits
  before the task check at `workflow.ts:264`).
- `npx tsc --noEmit` 0, `npm run lint` 0, `npm run build` clean.
- `test/ci-suites-manifest.test.ts` 5/5 (registered in sorted order after
  `test/assistant-isolation.test.ts`).
- Related: `assistant-tool-loop` + `mcp-tool-capability` + `assistant-gateway` +
  `assistant-isolation` 30/30.

## Not in this slice

The real dispatcher and the gateway wiring. S3 buffers a tool-carrying request
through the loop; S4 composes the executor with a run, the workspace application,
the in-process guard, and the broker-backed hold.
