import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { fleetAssetsRoot, loadFleetManifest, type FleetOptions } from "./fleet-payload.js";
import { rewriteFleetModelRef } from "./fleet-agent-install.js";

/**
 * W185: the vendored fleet's per-agent tier pins, resolved for the v2 runtime.
 *
 * The vendored agents pin `model: synthetic/syn:{small,large}:text` in their
 * frontmatter (see `assets/opencode-fleet/agents/*.md`). The runtime-lane
 * install rewrites the provider prefix to the metered id, so the INSTALLED
 * agent carries `model: <meteredId>/syn:<tier>:text`.
 *
 * The gap this module closes: on OpenCode v2 the session runner resolves the
 * model from `session.model` ONLY (`packages/core/src/session/runner/model.ts`
 * — `SessionRunnerModel.resolve(session)`), never from `agent.info.model`
 * (`AgentV2.Info` DOES carry an optional `model: Model.Ref`; the runner simply
 * ignores it). So a session created with `{"agent":"executor"}` records the
 * session DEFAULT model, not the agent's tier pin. The v1 runner DID fall back
 * to `agent.model` (`packages/opencode/src/session/prompt.ts`), which is why
 * the pin was assumed to carry over; it does not on v2.
 *
 * This module is the shared resolver BOTH hub-owned lanes consume: the server
 * lane injects the resolved ref into `POST /api/session` when a request names
 * an `agent` without a `model` (the gateway seam), and the ACP lane pins the
 * resolved tier as its session model when it runs as a fleet agent
 * (`AcpRuntimeOptions.fleetAgent` — the seam is deliberately plumbed but not yet
 * wired to a caller, deferred as a separate behavior change). It is a pure
 * function of the shipped bytes — the vendored source stays byte-identical.
 */

/** Strip the manifest's `agent:` prefix and `.md` suffix to recover the agent id. */
function agentIdFromEntry(file: string): string {
  return basename(file).replace(/\.md$/, "");
}

/** Reads the `model:` value from a leading `---` frontmatter block, or undefined. */
function frontmatterModel(payload: string): string | undefined {
  const lines = payload.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "---") break;
    const match = /^model:\s*(\S.*?)\s*$/.exec(line);
    if (match !== null) return match[1]!.trim();
  }
  return undefined;
}

/**
 * The vendored fleet's per-agent tier pins, keyed by agent id, with the model
 * ref already rewritten to the metered provider id (`<meteredId>/syn:<tier>:text`)
 * — the same ref the runtime install writes into the installed agent files.
 * Only agents that pin a `model:` appear. Fail closed: a manifest that cannot
 * be read throws (never a silently empty map).
 */
export function fleetAgentTierPins(options: Pick<FleetOptions, "root"> = {}): Readonly<Record<string, string>> {
  const manifest = loadFleetManifest(options);
  const pins: Record<string, string> = {};
  for (const entry of manifest.entries) {
    if (entry.kind !== "agent") continue;
    const source = join(fleetAssetsRoot(options), "agents", entry.file);
    const model = frontmatterModel(readFileSync(source, "utf8"));
    if (model === undefined) continue;
    pins[agentIdFromEntry(entry.file)] = rewriteFleetModelRef(model);
  }
  return pins;
}

/**
 * Split a `<providerId>/<modelId>` ref into the v2 `Model.Ref` shape
 * (`{ id, providerID }`) the session-create body expects. A ref with no `/`
 * has no provider and yields undefined (never an invented provider).
 */
export function modelRefFromString(ref: string): { readonly id: string; readonly providerID: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/**
 * The `Model.Ref` to seed a session's model with when it is created for
 * `agentId` and names no explicit model. `undefined` when the agent has no
 * pin (an unknown/operator agent keeps the session default, never a fabricated
 * pin).
 */
export function sessionModelRefForAgent(
  pins: Readonly<Record<string, string>>,
  agentId: string,
): { readonly id: string; readonly providerID: string } | undefined {
  const ref = pins[agentId];
  return ref === undefined ? undefined : modelRefFromString(ref);
}

/**
 * {@link fleetAgentTierPins} wrapped fail-open to an empty map. The pins are a
 * pure function of the vendored assets tree; in a packaged runtime that tree is
 * always present, but a resolve failure must never refuse a daemon/runtime —
 * the caller then leaves the session-create body / session model unchanged
 * (the pre-W185 behavior). The error is surfaced on stderr, never swallowed.
 */
export function safeFleetAgentTierPins(options: Pick<FleetOptions, "root"> = {}): Readonly<Record<string, string>> {
  try {
    return fleetAgentTierPins(options);
  } catch (error) {
    console.error(`[tiers] fleet agent tier pins unavailable, session models unchanged: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}
