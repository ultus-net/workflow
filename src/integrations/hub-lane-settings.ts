import { loadSettings, defaultSettings, type WorkflowSettings } from "./workflow-settings.js";

/**
 * W198 (2026-10-15): the hub composition root's operator-settings seam for the
 * unattended lanes (reviewer, RSI, scheduler).
 *
 * Before this module, `src/cli/hub.ts` composed `createConfiguredAcpRuntime`
 * with no `settings` at all on every hub-owned lane
 * (`hub.ts:334` reviewer, `:555` RSI, `:633` scheduler), while the interactive
 * lane passed the full document (`acp-runtime.ts:511`). The consequence was
 * that operator-enabled MCP connectors were invisible to every scheduled and
 * RSI turn: `acp-runtime.ts:411-420` derives the disabled set and the
 * already-mounted set from `options.settings?.mcpServers`, so an absent
 * document meant no operator connectors ever reached those lanes.
 *
 * The projection is deliberately NARROW: `mcpServers` only, with `agents`
 * emptied. Threading the whole `WorkflowSettings` would also carry
 * `agents.opencode.model` and `autoCompact` into the unattended lanes
 * (`acp-runtime.ts:498`, `:506`), silently changing their model and compaction
 * posture. The operator's ask is "my configured connectors reach my unattended
 * work", not "unattended work adopts my interactive model". Emitting
 * `agents: {}` keeps model and compaction selection exactly as they were
 * before this change.
 *
 * Authority is unchanged: a mounted connector is only *available*. Whether a
 * turn may call its tools is still decided by `WorkflowApplication.authorize()`
 * and the withheld-capability set — mounting is scoping, never a bypass lane.
 */

/**
 * The settings document an unattended hub lane composes: the operator's MCP
 * servers only, read from the same global + workspace overlay `loadSettings`
 * resolves. `home` is injectable for tests; production leaves it undefined and
 * resolves the real `homedir()`.
 *
 * An absent or unparseable settings file yields `defaultSettings()`
 * (`mcpServers: []`), which is the pre-W198 behavior: no operator connectors,
 * no invented ones. Fail-closed, no new defaults. An explicit operator disable
 * (`enabled: false`) is preserved here and still honored downstream by
 * `acp-runtime.ts:411` (an explicit disable always wins over a skill
 * declaration).
 */
export function hubLaneSettings(options: { readonly home?: string | undefined; readonly workspace?: string | undefined } = {}): WorkflowSettings {
  const loaded = loadSettings(options);
  if (loaded.mcpServers.length === 0) return defaultSettings();
  return { version: 1, mcpServers: loaded.mcpServers, agents: {} };
}
