/**
 * C2 (mcp-toolbox → control-plane conversion): the vendored workflow-guard
 * policy core, consumed IN-PROCESS by the hub/seat guard provider.
 *
 * The ten modules alongside this facade are a byte-identical copy of the
 * vendored app's policy source
 * (`mcp-toolbox/apps/workflow-guard-mcp/src/<name>.ts`), enforced by
 * `test/guard-policy-drift.test.ts`. The app keeps its 2k-line behavioral
 * suite; this copy gives the in-process seat the SAME decisions without a
 * subprocess, so the enforcement seat no longer spawns, handshakes, or runs a
 * possibly-stale `dist`. Regenerate the copies (do not edit them here) when the
 * app's policy changes.
 */
export { checkPolicy, CIRCUIT_BREAKER_GUIDANCE, extractPatchPaths, isReadOnlyRole } from "./policy.js";
export type { GuardAction, GuardCheckInput, GuardDecision } from "./policy.js";
