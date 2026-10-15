# W198: operator settings reach the unattended hub lanes

Status: implemented, pending CI.

## Problem

`src/cli/hub.ts` composed `createConfiguredAcpRuntime` with **no `settings`** on
every hub-owned unattended lane:

- reviewer: `hub.ts:334` (pre-change)
- RSI proposal turn: `hub.ts:555`
- scheduler run turn: `hub.ts:633`

The interactive lane passes the full document
(`acp-runtime.ts:511`, `mcpServers: enabledMcpServers(options.settings)`), but the
unattended lanes passed nothing. `acp-runtime.ts:411-420` derives both the
disabled set and the already-mounted set from `options.settings?.mcpServers`, so
an absent document meant **operator-enabled MCP connectors never reached a
scheduled or RSI turn**. Any operator connector (an MCP server declared in
`~/.config/workflow/settings.json`) was silently invisible to unattended work.

This was found while scoping the deep-research attach seam
(`augur/docs/planning-questions.md`): the deep-research connector could not reach
a scheduled turn because the lane never composed operator settings at all.

## Fix

New module `src/integrations/hub-lane-settings.ts` with `hubLaneSettings()`, a
deliberately **narrow** projection:

- Reads the operator document through the existing `loadSettings` (global base +
  per-workspace overlay, same precedence as every other surface).
- Projects **`mcpServers` only** and emits `agents: {}`.

The narrowness is load-bearing. Threading the whole `WorkflowSettings` would also
carry `agents.opencode.model` (`acp-runtime.ts:498`) and `autoCompact`
(`:506`) into the unattended lanes, silently changing their model and compaction
posture. The operator's intent is "my configured connectors reach my unattended
work", not "unattended work adopts my interactive model". Emitting `agents: {}`
keeps model and compaction selection byte-identical to the pre-change behavior.

Explicit operator disables (`enabled: false`) survive the projection so the
downstream filter (`acp-runtime.ts:411`) still sees them: an explicit disable
always wins over a skill declaration.

Fail-closed: an absent or unparseable settings file yields `defaultSettings()`
(`mcpServers: []`), which is the pre-W198 behavior. No invented connectors, no new
defaults.

## What is unchanged

- **Authority.** A mounted connector is only *available*. Whether a turn may call
  its tools is still decided by `WorkflowApplication.authorize()` and the
  withheld-capability set. This change is scoping, never a bypass lane
  (`toolbox-catalog.ts:238-266`).
- **The connector allowlist.** `declaredSkillConnectors`
  (`toolbox-catalog.ts:196-200`) is untouched. Widening it was the rejected
  alternative: it would mount a connector **unconditionally**, including on care,
  which violates the withholding requirement. Threading operator settings reuses
  the existing path and leaves the gate as the decider.
- **The built-in guard/delivery floor.** `workflow-guard-mcp` and `skills-mcp`
  keep arriving through the skill-declaration floor; operator servers are additive
  and are passed as `alreadyMounted` to avoid a double mount
  (`acp-runtime.ts:419`).

## Evidence

- `test/hub-lane-settings.test.ts` (new, 4 cases): connectors cross the seam; the
  interactive model/compaction does not leak; absent file is fail-closed;
  workspace overlay merges over the global base.
- `test/ci-suites.txt`: the new suite added in sorted position (after
  `hub-endpoint-dispatch`, before `hub-review`).
- Local: `tsc --noEmit` clean; `npm run build` clean; eslint clean on the three
  changed files; the new suite plus `workflow-settings` / `skill-delivery` /
  `hub-run-gates` (21 tests) green; `ci-suites-manifest` pin test green.

## Follow-ups

- The deep-research connector (Foundry provider class) is the first operator
  connector this unblocks. It remains gated on the operator's `gpt-6-sol`
  provisioning decision (`augur/docs/planning-questions.md`).
- Care route: the withheld set gains `deep_research` explicitly, so the mounted
  connector stays unavailable to care turns. No change needed in this slice; the
  gate already computes it.
