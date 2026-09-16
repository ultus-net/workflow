import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { METERED_PLACEHOLDER_KEY } from "./model-usage-proxy.js";

/**
 * W048: the goose (AAIF) agent-kind configuration — the launch resolver and
 * the per-runtime environment/config composition for the contained
 * `goose acp` profile. Everything here is PROBE-PENDING by design
 * (`docs/superpowers/plans/2026-09-16-goose-qualification.md`): the six
 * gated probes earn the enforcement classification, never configuration
 * claims. Unknowns the research record explicitly leaves open
 * (`docs/GOOSE_RESEARCH.md` §12) — the config.yaml schema/location under
 * `GOOSE_PATH_ROOT`, and which usage channel carries usage_update — are
 * resolved BY the probes, and a no-mount/mismatch outcome is recorded as an
 * honest negative finding, not a probe failure.
 */

/** Ambient PATH discovery, mirroring `globalOpencodeBinary`. */
export function globalGooseBinary(): string | undefined {
  try {
    const raw = execFileSync("/usr/bin/which", ["goose"], { encoding: "utf8" }).trim();
    if (raw === "" || !existsSync(raw)) return undefined;
    return realpathSync(raw);
  } catch {
    return undefined;
  }
}

export interface GooseLaunch {
  readonly executable: string;
  readonly args: readonly string[];
}

/**
 * Resolve the goose entry: `WORKFLOW_GOOSE_BIN` override (must exist), else
 * the ambient PATH `goose`. goose is a stock AAIF binary (never vendored) —
 * the ambient version is recorded in each probe's `agentInfo` evidence and
 * re-probed on version bump (the weekly release cadence makes goose the
 * first pinned-version-sensitive agent).
 */
export function resolveGooseLaunch(options: {
  readonly envBinOverride: string | undefined;
  readonly gooseOnPath: string | undefined;
}): GooseLaunch {
  if (options.envBinOverride !== undefined) {
    if (!existsSync(options.envBinOverride)) {
      throw new Error(`WORKFLOW_GOOSE_BIN does not exist: ${options.envBinOverride}`);
    }
    return { executable: realpathSync(options.envBinOverride), args: ["acp"] };
  }
  if (options.gooseOnPath === undefined) {
    throw new Error("goose is not on PATH; install goose (aaif-goose/goose) or set WORKFLOW_GOOSE_BIN");
  }
  return { executable: options.gooseOnPath, args: ["acp"] };
}

/** goose provider selection per workload (plan line 23). */
export type GooseProviderKind = "openrouter" | "azure_foundry";

export function gooseProviderKind(env: NodeJS.ProcessEnv = process.env): GooseProviderKind {
  const raw = env.WORKFLOW_GOOSE_PROVIDER?.trim();
  if (raw === undefined || raw === "" || raw === "openrouter") return "openrouter";
  if (raw === "azure_foundry") return "azure_foundry";
  throw new Error(`WORKFLOW_GOOSE_PROVIDER must be "openrouter" or "azure_foundry" (got ${JSON.stringify(raw)})`);
}

/**
 * The hub-owned launch environment for a contained goose runtime. Hub-owned
 * config is the ONLY config: approve mode (mutating tools must cross
 * `session/request_permission` — the guard dispatcher and bwrap remain the
 * hard backstops because goose's write classification is LLM-interpreted
 * best-effort), telemetry off, the per-runtime config root, and the
 * provider credentials by env (never a keyring inside containment).
 *
 * OpenRouter composes through the loopback metering proxy exactly like the
 * Cline/OpenCode paths: the agent sees only the placeholder key and a host
 * pointing at the proxy; the real key stays proxy-side. Azure AI Foundry is
 * env-composed direct (endpoint + API key env; ambient `az`-CLI and Entra
 * auth cannot survive the scratch-HOME boundary — the hub injects the key).
 */
export function gooseLaunchEnvironment(options: {
  readonly provider: GooseProviderKind;
  readonly configRoot: string;
  readonly proxyUrl: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}): Record<string, string> {
  // Only defined env entries survive into the contained launch: the bwrap
  // environment is a Record<string, string> — undefined values from
  // process.env are dropped, never inherited implicitly.
  const environment: Record<string, string> = {
    GOOSE_PATH_ROOT: options.configRoot,
    GOOSE_MODE: "approve",
    GOOSE_TELEMETRY_ENABLED: "false",
    PATH: options.env.PATH ?? "",
    HOME: options.env.HOME ?? "",
  };
  if (options.provider === "openrouter") {
    if (options.proxyUrl === undefined) {
      throw new Error("the openrouter goose profile requires the loopback metering proxy");
    }
    // Plan line 21: OPENROUTER_HOST → proxy with a placeholder key (parity
    // with the Cline/OpenCode metered paths). env > stored secrets.
    environment.OPENROUTER_HOST = `${options.proxyUrl}/api/v1`;
    environment.OPENROUTER_API_KEY = METERED_PLACEHOLDER_KEY;
    environment.GOOSE_PROVIDER = "openrouter";
  } else {
    // Azure AI Foundry direct: required endpoint + key env injected by the
    // hub (env > config > keyring; no keyring inside containment).
    environment.GOOSE_PROVIDER = "azure_foundry";
    for (const name of ["AZURE_FOUNDRY_ENDPOINT", "AZURE_FOUNDRY_API_KEY", "AZURE_FOUNDRY_API_VERSION", "AZURE_FOUNDRY_MODEL"] as const) {
      const value = options.env[name];
      if (value !== undefined && value !== "") environment[name] = value;
    }
    if (environment.AZURE_FOUNDRY_ENDPOINT === undefined) {
      throw new Error("the azure_foundry goose profile requires AZURE_FOUNDRY_ENDPOINT");
    }
    if (environment.AZURE_FOUNDRY_API_KEY === undefined) {
      throw new Error("the azure_foundry goose profile requires AZURE_FOUNDRY_API_KEY (ambient az-CLI and Entra auth cannot survive the scratch-HOME boundary)");
    }
  }
  return environment;
}

/**
 * The hub-written goose config.yaml candidate for the per-runtime root.
 * The research record gives the extension KINDS and attributes (stdio with
 * envs/env_keys, available_tools filtering — `docs/GOOSE_RESEARCH.md` §8)
 * but not a verified schema for `goose acp` under `GOOSE_PATH_ROOT`; the
 * MOUNT probe is the instrument that resolves exactly this (a no-mount
 * outcome is an honest negative finding). Skills arrive ONLY through the
 * skills-mcp stdio mount — no native `.agents/skills` in composed
 * workspaces.
 */
export function gooseConfigYaml(options: {
  readonly skillsServerScript?: string | undefined;
  readonly skillsDir?: string | undefined;
}): string | undefined {
  if (options.skillsServerScript === undefined || options.skillsDir === undefined) return undefined;
  return [
    "# Hub-composed per-runtime goose configuration (W048).",
    "# Probe-pending: the config.yaml schema under GOOSE_PATH_ROOT is",
    "# resolved by the gated MOUNT probe; a no-mount outcome is recorded",
    "# as an honest negative finding.",
    "extensions:",
    "  - type: stdio",
    "    name: skills-mcp",
    `    cmd: ${JSON.stringify([process.execPath, options.skillsServerScript])}`,
    "    envs:",
    `      SKILLS_MCP_DIR: ${JSON.stringify(options.skillsDir)}`,
    "",
  ].join("\n");
}
