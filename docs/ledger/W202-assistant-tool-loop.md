# W202 spec: the assistant gateway tool loop (M4)

Date: 2026-10-16. Branch: `feat/w202-gateway-tool-loop`. Base: `2aeb6aa9`.

## Goal

M4 (`docs/.../integration-plan.md`): the assistant gateway executes tool calls
through `authorize()` + `guard_check`. Today `src/integrations/assistant-gateway.ts`
is byte-passthrough with **no tools and no `authorize()`** (M1 scope, stated in
its header comment). This wave starts M4.

## Seam map (recon, at base)

| Concern | Reusable seam | Note |
| --- | --- | --- |
| Canonical ordering | `src/integrations/opencode-server-authority.ts:318-395` | kernel-first (`application.authorize`) then guard; guard `ask` parks on the broker in `ask-me`, fails closed in `auto-resolve` |
| Capability mapper | `opencode-server-authority.ts:909-921` | maps *host* tool names (`bash`, `edit`, ...) — no MCP-server-tool mapping exists |
| Guard (in-process) | `src/integrations/mcp-toolbox-guard.ts:298-349` (`guardInputFromToolCall`), `:196` (`createDefaultToolboxGuardProvider`) | `guard_check` runs in-process, never over stdio (C2) |
| Stdio MCP client | `src/integrations/project-memory.ts:66-120`, `review-followups.ts:1-2` | the `Client` + `StdioClientTransport` pattern |
| Ask parking | `src/ui/permission-broker.ts:409-450` (`parkAsk`/`answerAsk`) | the one operator ask transport |
| Run binding | `src/integrations/run-registry.ts:543` (`begin`), `:636` (`finish`), `:123-137` (`RunOrigin`) | `RunOrigin` is a closed union; no `assistant` variant |
| Withheld set | `src/application/workflow.ts:218` / `:243-252` (`authorize`, `CAPABILITY_WITHHELD`), `:168-174` (`setCapability`) | `setCapability` is process-global, not per-session |

## The two decisions this wave does NOT take

These are authority/containment calls. Guessing them risks a hole, so they are
left for the operator:

1. **Does the plane launch mcp-toolbox servers over stdio?** Current architecture
   (`opencode-agent-config.ts:382-399`) is that the plane *writes config* and the
   sandboxed agent launches the servers; `guard_check` is in-process. The M4 row
   in `integration-plan.md` says "hub-launched stdio toolbox", which reverses
   that. Launching catalog servers in the plane is a new trust surface.

2. **How is an arbitrary MCP tool classified?** `opencodePermissionCapability`
   covers host tool names only. An MCP tool from, say, `learning-mcp` has no
   capability, no `mutating` flag, and no subjects. A default must be chosen
   (strictest, presumably `process` + `mutating`, with `authorize`'s workspace
   check given nothing to match) and the care route's withheld set must become
   real enforcement rather than the current display-only label
   (`src/cli/hub.ts:414-427` -> `hub-http.ts:297-305`; no `setCapability` call
   site exists).

## Slice built here (decision-independent)

**`src/integrations/assistant-tool-loop.ts`** — the tool-call loop with injected
ports. It carries the one piece of M4 with no authority content: buffering and
parsing `choices[].message.tool_calls`, executing each call through an injected
`executeTool` port, appending the `role:"tool"` observations, and re-issuing
until the model stops calling tools (or the iteration cap). The gateway's
non-tool path stays byte-for-byte M1 passthrough, so streaming is not regressed.

Discriminator: a request that carries no `tools` array is M1 passthrough; a
request that carries one is buffered and run through the loop. This is why the
loop can be built now: it depends on the two decisions only at the `executeTool`
boundary, which stays an injected port.

## Acceptance

- `test/assistant-tool-loop.test.ts`: 6/6. A fake backend that returns
  `tool_calls` on round 1 and a plain message on round 2 drives exactly two
  `runCompletion` calls; `executeTool` is invoked once per call id with the
  parsed arguments; the second request body carries the original conversation,
  the assistant message with its `tool_calls`, and one `role:"tool"` message per
  call; a backend that keeps returning `tool_calls` stops at `maxIterations`
  with `truncated: true`; a throwing executor becomes an error observation for
  that call without aborting the loop; `parseToolCalls` skips every malformed
  entry and normalizes a missing `arguments` to `""`; the caller's `messages`
  array is never mutated.
- `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npm run build` clean.
- `test/ci-suites-manifest.test.ts`: 5/5 (the new suite is registered in sorted
  order in `test/ci-suites.txt`).

## Not in this slice

The gateway is NOT yet wired to the loop: `handleAssistantRequest` still
byte-passes-through every request, including one that carries `tools`. Wiring it
is a later slice because it needs the executor port to be real, and the port is
where the two open decisions above land. Until then the loop is a self-contained,
tested unit with no caller.

