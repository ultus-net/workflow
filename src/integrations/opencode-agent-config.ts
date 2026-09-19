import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

import { METERED_PLACEHOLDER_KEY } from "./model-usage-proxy.js";
import { autoLatestModelCatalog } from "./openrouter-auto-latest.js";

/**
 * Hub-written OpenCode launch configuration. The hub owns the agent's config
 * surface (probe-proven: `test/acp-opencode-mcp-mount-probe.test.ts` mounts
 * hub-written config from `XDG_CONFIG_HOME`, and the ask-config G1 probe
 * proves ask-configured permission requests reach the client and denials
 * are honored). The metered provider points the agent at the loopback
 * metering proxy with a placeholder credential — the real upstream key never
 * enters the agent's environment or config files, mirroring the Cline
 * metering pattern (`docs/ACP_DECISION.md` G1).
 */

export const OPENCODE_METERED_PROVIDER_ID = "workflow-metered";
export const DEFAULT_OPENCODE_MODEL = "openrouter/auto";

/**
 * A hub-owned open-source vendor provider: the agent points at the loopback
 * metering proxy with the placeholder credential, exactly like the OpenRouter
 * provider, while the real vendor key stays proxy-side.
 */
export interface MeteredVendorProvider {
  readonly id: string;
  readonly name: string;
  readonly baseURL: string;
  readonly models: Readonly<Record<string, { readonly name: string }>>;
}

export interface MeteredOpencodeConfigOptions {
  readonly proxyUrl: string;
  readonly model?: string | undefined;
  /**
   * When set, the `~...-latest` alias pool is exposed as additional selectable
   * models in the ACP model picker (the Auto Router stays the default).
   */
  readonly autoLatest?: { readonly aliases: readonly string[] } | undefined;
  /**
   * W070a: the open-source vendor providers composed through their own
   * loopback proxies. `defaultModel` is the full `<providerId>/<model>` the
   * agent selects when the operator has not overridden it.
   */
  readonly openSource?:
    | { readonly providers: readonly MeteredVendorProvider[]; readonly defaultModel: string }
    | undefined;
  /**
   * Plan Task F1: the skills-mcp delivery mount. When provided, the agent
   * mounts the hub-owned skills server (list_skills/read_skill) — the single
   * delivery path the application's skill precondition journals against (the
   * driver's onSkillRead). Probe-proven surface
   * (`test/acp-opencode-mcp-mount-probe.test.ts`: hub-written config mounts
   * from XDG_CONFIG_HOME and list_skills returns the fixture skill verbatim).
   */
  readonly skills?: { readonly serverScript: string; readonly skillsDir: string } | undefined;
}

export function meteredOpencodeConfig(options: MeteredOpencodeConfigOptions): Record<string, unknown> {
  // Expose the Auto Router plus the alias pool as selectable models so the ACP
  // model picker can switch to a specific family's latest without pinning a
  // version. The Auto Router stays the default selection.
  const models: Record<string, { name: string }> = {
    [DEFAULT_OPENCODE_MODEL]: { name: "Auto Router" },
    ...autoLatestModelCatalog(options.autoLatest?.aliases ?? []),
  };
  const legacyModel = options.model ?? DEFAULT_OPENCODE_MODEL;
  if (!(legacyModel in models)) models[legacyModel] = { name: legacyModel };
  const vendorProviders = options.openSource?.providers ?? [];
  const provider = (): Record<string, unknown> => ({
    [OPENCODE_METERED_PROVIDER_ID]: {
      npm: "@ai-sdk/openai-compatible",
      name: "Workflow metered proxy",
      options: {
        baseURL: `${options.proxyUrl}/api/v1`,
        // Placeholder credential only — the same posture as the Cline
        // metering path: the per-runtime 0600 config file carries the
        // placeholder, and the real upstream key stays exclusively in the
        // hub-side proxy, which ignores the placeholder and injects the
        // real key upstream. (opencode 1.18's config schema requires a
        // plain string here, not an env reference — verified live.)
        apiKey: METERED_PLACEHOLDER_KEY,
      },
      models,
    },
    ...Object.fromEntries(
      vendorProviders.map((entry) => [
        entry.id,
        {
          npm: "@ai-sdk/openai-compatible",
          name: entry.name,
          options: { baseURL: entry.baseURL, apiKey: METERED_PLACEHOLDER_KEY },
          models: { ...entry.models },
        },
      ]),
    ),
  });
  // The operator's explicit model always rides the legacy OpenRouter-family
  // provider (closed-model override path). With no override, the open-source
  // pool default applies when composed, else the Auto Router.
  const selectedModel =
    options.model !== undefined
      ? `${OPENCODE_METERED_PROVIDER_ID}/${options.model}`
      : options.openSource?.defaultModel ?? `${OPENCODE_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`;
  return {
    $schema: "https://opencode.ai/config.json",
    provider: provider(),
    model: selectedModel,
    // The hub is the permission authority: ask-configured tools project
    // session/request_permission to the hub, which resolves each request
    // through WorkflowApplication.authorize (G1 probe: denials honored).
    // `task` is included so subagent spawns are gateable at the hub
    // (subagent probe: the task tool call projected and permission-gated).
    permission: { edit: "ask", bash: "ask", task: "ask" },
    ...(options.skills === undefined
      ? {}
      : {
          mcp: {
            "skills-mcp": {
              type: "local",
              command: [process.execPath, options.skills.serverScript],
              environment: { SKILLS_MCP_DIR: options.skills.skillsDir },
            },
          },
        }),
  };
}

export interface OpencodeLaunchResolution {
  /** Agent executable (self-contained compiled binary, realpath-resolved). */
  readonly executable: string;
}

export interface OpencodeLaunchInput {
  /** WORKFLOW_OPENCODE_BIN override. */
  readonly envBinOverride?: string | undefined;
  /** Realpath-resolved global `opencode` binary, or undefined when absent. */
  readonly opencodeOnPath?: string | undefined;
  /** Existence probe, injectable for tests. */
  readonly exists?: ((path: string) => boolean) | undefined;
  /** Symlink resolver, injectable for tests. */
  readonly realpath?: ((path: string) => string) | undefined;
}

export function resolveOpencodeLaunch(input: OpencodeLaunchInput): OpencodeLaunchResolution {
  const exists = input.exists ?? existsSync;
  const realpath = input.realpath ?? realpathSync;
  const override = input.envBinOverride?.trim();
  if (override !== undefined && override !== "") {
    if (!exists(override)) {
      throw new Error(`WORKFLOW_OPENCODE_BIN points at a missing binary: ${override}`);
    }
    return { executable: realpath(override) };
  }
  if (input.opencodeOnPath === undefined) {
    throw new Error("No OpenCode agent available: install the opencode CLI globally or set WORKFLOW_OPENCODE_BIN");
  }
  return { executable: input.opencodeOnPath };
}

/** Realpath-resolved global `opencode` binary, or undefined when not installed. */
export function globalOpencodeBinary(): string | undefined {
  let bin: string;
  try {
    bin = execFileSync("/usr/bin/which", ["opencode"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
  if (bin === "") return undefined;
  try {
    return realpathSync(bin);
  } catch {
    return undefined;
  }
}
