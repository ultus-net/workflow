import { createHash } from "node:crypto";
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

/**
 * W049 dogfood finding (goose 1.50.1, 2026-09-17): goose's session store
 * lives under `GOOSE_PATH_ROOT`, so a resume across a full runtime restart
 * needs the SAME config root, not a fresh per-launch one (`Session not
 * found: 20260917_1` came from a pid+uuid config dir dying with its
 * launch). The runtime keys the dir by workspace instead: deterministic
 * per absolute workspace path, stable across restarts, and shaped to ESCAPE
 * the stale-runtime pruner (`config.<pid>...` requires a pid — a `ws-` tag
 * never matches, so the session store is never swept mid-life).
 *
 * HONEST CONCURRENCY LIMIT: two simultaneous goose runtimes on the SAME
 * workspace share this root. The config.yaml bytes are identical (same
 * skills mount; the metering proxy is env-carried per launch, never in the
 * file), and goose's store is per-session-id files, so the practical risk
 * is bounded — but it is a shared directory, not an isolated one.
 */
export function gooseWorkspaceConfigTag(workspace: string): string {
  const digest = createHash("sha256").update(workspace).digest("hex").slice(0, 12);
  return `ws-${digest}`;
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
    // Ambient PATH passes through deliberately — a deviation from the
    // sanitized bwrap default PATH the cline/opencode launches use, because
    // goose's shell-tool workload needs the operator's real toolchain. The
    // passthrough is boundary-inert: PATH entries cannot resolve inside
    // bwrap unless a bind mounts them, so this shapes what goose may
    // EXECUTE, never what it can read or write. HOME is deliberately
    // absent — launchContainedAcpAgent always overrides it with the scratch
    // home ("HOME always wins"), so an ambient entry would be dead.
    PATH: options.env.PATH ?? "",
  };
  // goose resolves its model at launch (GOOSE_MODEL — env > config). The
  // openrouter default matches the sibling metered paths (openrouter/auto,
  // the same default the OpenCode runtime composes); azure_foundry requires
  // AZURE_FOUNDRY_MODEL. Fail closed rather than letting goose guess.
  const gooseModel = options.env.WORKFLOW_GOOSE_MODEL?.trim()
    ?? options.env.GOOSE_MODEL?.trim()
    ?? (options.provider === "openrouter" ? "openrouter/auto" : options.env.AZURE_FOUNDRY_MODEL?.trim() ?? "");
  if (gooseModel === "") {
    throw new Error("the goose profile requires a model: set WORKFLOW_GOOSE_MODEL (or GOOSE_MODEL; azure_foundry also honors AZURE_FOUNDRY_MODEL)");
  }
  environment.GOOSE_MODEL = gooseModel;
  if (options.provider === "openrouter") {
    if (options.proxyUrl === undefined) {
      throw new Error("the openrouter goose profile requires the loopback metering proxy");
    }
    // Plan line 21: OPENROUTER_HOST → proxy with a placeholder key (parity
    // with the Cline/OpenCode metered paths — the key posture is identical).
    // Live-run evidence (1.50.1): OPENROUTER_HOST is the provider ROOT —
    // goose appends /api/v1/chat/completions itself, so composing the
    // proxy's /api/v1 base here doubled the path (404). env > stored secrets.
    environment.OPENROUTER_HOST = options.proxyUrl;
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
 * The hub-written goose config.yaml for the per-runtime root, in the
 * DOCUMENTED schema (goose-docs.ai/docs/guides/config-files — Extensions
 * Configuration): `extensions` is a MAP keyed by extension name, each entry
 * carrying type/name/enabled/cmd/args/envs/timeout. Skills arrive ONLY
 * through the skills-mcp stdio mount — no native `.agents/skills` in
 * composed workspaces. The first live MOUNT run (1.50.1) rejected the
 * earlier list-shaped candidate with NO_MCP_TOOLS; the documented map
 * shape is what the probe verified GREEN (2026-09-17).
 */
export function gooseConfigYaml(options: {
  readonly skillsServerScript?: string | undefined;
  readonly skillsDir?: string | undefined;
}): string | undefined {
  if (options.skillsServerScript === undefined || options.skillsDir === undefined) return undefined;
  return [
    "# Hub-composed per-runtime goose configuration (W048).",
    "extensions:",
    "  skills-mcp:",
    "    type: stdio",
    "    name: skills-mcp",
    "    enabled: true",
    `    cmd: ${JSON.stringify(process.execPath)}`,
    `    args: ${JSON.stringify([options.skillsServerScript])}`,
    "    env_keys: []",
    "    envs:",
    `      SKILLS_MCP_DIR: ${JSON.stringify(options.skillsDir)}`,
    "    timeout: 300",
    "",
  ].join("\n");
}
