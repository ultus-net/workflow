# Adapter Boundary Hardening — Implementation Plan

Date: 2026-09-14
Branch: feat/adapter-boundary-hardening
Origin: repo audit of 2026-09-14 (kernel/adapter/integration seams)

## Goal

Close the gaps between the SDK-agnostic claim and the code: make the adapter
contract's control half real, cover every host in conformance, route the
monitor through the hub, fix the port-type direction, and re-sync docs.

## Scope decisions

- Monitor fix is bounded to: hub-attached snapshot projection by default,
  standalone (current local authority) only as an explicit labelled fallback.
  A full hub-mediated coding session driver is out of scope (separate feature).
- `src/adapters/lsp.ts` and `mcp.ts` keep their locations (no move) in this
  pass; only doc clarification.

## Tasks

### T1 — OpenCode control half becomes real

`OpenCodeHostAdapter.beforeToolControl` currently always returns `undefined`;
deny works only via the plugin's inline throw.

Change: adapter's Control type becomes `Error`; `beforeToolControl(deny)`
returns `new Error("Workflow denied <tool>: <reason>")`; the plugin throws
the returned control instead of constructing inline. Conformance can then
assert the same control property for OpenCode as for Cline/ACP.

Files: `src/adapters/opencode.ts`, `src/integrations/opencode-plugin.ts`,
`test/opencode-plugin.test.ts` (update), `test/adapter-conformance.test.ts`
(add OpenCode harness).

### T2 — ACP trust hardening

Match the Cline/OpenCode conservative posture:

- `mutating`: unknown `kind` defaults to mutating; host-supplied `kind` of
  `read`/`search` only narrows when the tool name is in a known-read table
  (otherwise default mutation).
- Subjects: extract path fields from `toolCall.rawInput` when `locations[]`
  is empty; fail closed when a mutating/process proposal yields no subjects
  (cannot be workspace-checked).
- Validation: reject missing `sessionId`/`taskId`/`toolCall` shape with the
  typed error; no truthiness-only checks.
- `stricterCapability`: event-supplied capability may never downgrade the
  built-in classification (mirror Cline/OpenCode).

Files: `src/adapters/acp.ts`, `test/acp-adapter.test.ts`,
`test/adapter-conformance.test.ts` (extend with subjects/mutating traces).

### T3 — Port-type direction fix

Move the contract vocabulary from `src/adapters/host.ts` to
`src/application/host.ts` (application owns its port). `src/adapters/host.ts`
becomes a pure re-export shim for compatibility; update direct importers.

Files: create `src/application/host.ts`; rewrite `src/adapters/host.ts` as a
re-export; update imports in adapters/application/tests as needed.

### T4 — Monitor over the live hub

- Default: resolve hub (auto-spawn), fetch `/snapshot` with the discovery
  token, render the canonical task panel from it; poll on an interval.
- Standalone (hub unresolved): keep current local authority + seed, but the
  UI shows a `standalone (no hub)` indicator and README documents the
  difference.
- The local session driver only runs in standalone mode.

Files: `src/cli/ink-tui.tsx` (restructure), possibly
`src/integrations/workflow-hub.ts` (verify `/snapshot` shape suffices),
`README.md`.

### T5 — Evidence-policy + docs sync

- `/run/finish` with `outcome: "verified"`: runs with empty
  `requiredEvidence` require the verifier capability; document the rule in
  `docs/HUB_PROTOCOL.md` (align §/run/finish with the no-fabrication comment).
- `docs/HOST_ADAPTERS.md`: enumerate all six adapter files (host-neutral
  contract, Cline, OpenCode, ACP, LSP-as-helper, MCP-as-helper), current test
  exemplars, and the actual state of `credentials` classification
  (defined in the union, classification only via `capabilityForTool`
  extensions today).

Files: `src/integrations/run-registry.ts` (rule change + tests),
`docs/HUB_PROTOCOL.md`, `docs/HOST_ADAPTERS.md`.

## Verification per task

`node --import tsx --test <focused tests>` then, at the end,
`npm run lint && npm test && npm run typecheck && npm run build` plus
secondary five-axis review via the guard.
