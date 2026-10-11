import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

import type { ModelFamily } from "./model-profile.js";
import { METERED_PLACEHOLDER_KEY } from "./model-usage-proxy.js";
import { autoLatestModelCatalog } from "./openrouter-auto-latest.js";
import {
  enabledMcpServers,
  opencodeMcpServers,
  type McpServerSetting,
  type WorkflowSettings,
} from "./workflow-settings.js";

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
 * opencode v2 built-in-provider credential env var for the metered lane.
 *
 * v2 changed the provider schema AND the activation rule. A config-defined
 * provider is parsed (`/api/config` lists it) but is NOT registered into the
 * model catalog unless it is credential-activated: `/api/provider` and the ACP
 * model picker list credential-activated providers only (verified live on
 * v2.0.10; the migration spec §10 recorded the same `/api/provider` finding).
 * A custom provider id never registers in the ACP picker on v2.0.10 even with
 * `canonical`, `env`, `settings.apiKey`, or an auth-store entry — while
 * overriding the BUILT-IN `openrouter` provider's `settings.baseURL` and
 * activating it with this env var does. The v2 metered lane therefore routes
 * through the built-in `openrouter` provider with the placeholder in this env
 * var; the real upstream key stays exclusively proxy-side.
 */
export const OPENCODE_V2_METERED_ENV_KEY = "OPENROUTER_API_KEY";
/** v2 provider id the metered lane reuses (its catalog + runtime package). */
export const OPENCODE_V2_METERED_PROVIDER_ID = "openrouter";

/**
 * A v2 BUILT-IN provider whose existing package/models a vendor family rides.
 *
 * v2 does not register a config-defined custom provider into the ACP model
 * catalog (#427), so the open-source vendors cannot be exposed as custom
 * providers on v2. Instead each family is routed through its v2 BUILT-IN
 * provider by overriding only `settings.baseURL` (the v2 docs' "Endpoint"
 * route: the provider keeps its existing package, models, and connection) and
 * activating it with the placeholder credential in `envKey`. The real vendor
 * key stays proxy-side.
 *
 * The provider ids were confirmed against the pinned opencode v2.0.10
 * (bundled/fetched models.dev catalog: `deepseek`, `zai`, `moonshotai`) and
 * live-probed on BOTH lanes (a session pinned to `<id>/<model>` reaches a local
 * mock with the placeholder as a bearer token). `zai` is the v2.0.10 spelling
 * of Z.AI/GLM; its activation env var is `ZHIPU_API_KEY` (live-verified — see
 * the per-entry note below). The catalog model ids a vendor built-in advertises
 * are NOT the pool ids; see {@link OPENCODE_V2_VENDOR_MODELS}.
 */
export interface OpenSourceV2BuiltinProvider {
  /** opencode v2 built-in provider id that owns this vendor's catalog. */
  readonly providerId: string;
  /** Credential env var that activates the built-in on v2 (placeholder value). */
  readonly envKey: string;
}

export const OPENCODE_V2_VENDOR_BUILTINS: Readonly<Record<ModelFamily, OpenSourceV2BuiltinProvider | undefined>> = {
  deepseek: { providerId: "deepseek", envKey: "DEEPSEEK_API_KEY" },
  // `zai` activation key: models.dev moved the catalog entry's env to
  // `ZHIPU_API_KEY`. Live-verified on v2.0.10 (2026-09-30, the ACP-lane
  // residual probe): setting `ZAI_API_KEY` does NOT register `zai` in the ACP
  // model picker, while `ZHIPU_API_KEY` does. The earlier `strings`-based
  // inference of `ZAI_API_KEY` was wrong — opencode reads the fetched catalog's
  // env, not the bundled string.
  glm: { providerId: "zai", envKey: "ZHIPU_API_KEY" },
  kimi: { providerId: "moonshotai", envKey: "MOONSHOT_API_KEY" },
};

/**
 * The v2.0.10 BUILT-IN catalog model id that carries a pool model id.
 *
 * opencode v2's ACP model picker validates `session/set_config_option` against
 * the provider's catalog, and the built-in catalogs do NOT carry every pool
 * model id (live-verified v2.0.10, 2026-09-30). The mapping is therefore
 * explicit and version-pinned (re-check on every opencode bump, per AGENTS.md):
 *
 * - `deepseek`: the pool's `deepseek-flash` is absent from the v2.0.10 catalog,
 *   which lists `deepseek-v4-flash` — the vendor-accepted legacy id for the
 *   same DeepSeek-V4.1-Flash model (W070a spec §2). Mapping it keeps the turn
 *   on the identical vendor model rather than a different one.
 * - `moonshotai`: `kimi-k3` is present (identity).
 * - `zai`: neither `glm-5.3` nor `glm-5.3-flash` is in the v2.0.10 catalog (it
 *   tops out at `glm-5.2`), so GLM has no faithfully routable v2 built-in
 *   model id. It is deliberately ABSENT here: {@link v2BuiltinModelRef} then
 *   falls back to the metered Auto Router rather than silently downgrading to
 *   `glm-5.2`. GLM's zai catalog models stay selectable and proxied.
 */
export const OPENCODE_V2_VENDOR_MODELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  deepseek: { "deepseek-flash": "deepseek-v4-flash" },
  moonshotai: { "kimi-k3": "kimi-k3" },
};

/** True when `providerId` is one of the v2 vendor BUILT-IN provider ids. */
function isV2VendorBuiltin(providerId: string): boolean {
  return Object.values(OPENCODE_V2_VENDOR_BUILTINS).some((entry) => entry?.providerId === providerId);
}

/**
 * Translates a config `model` ref (`<providerId>/<modelId>`) into a ref the
 * v2.0.10 ACP picker accepts, so the `session/set_config_option` model pin
 * (#427) does not fail the session with `model not found`.
 *
 * - A known vendor built-in ref is mapped through
 *   {@link OPENCODE_V2_VENDOR_MODELS} (e.g. `deepseek/deepseek-flash` →
 *   `deepseek/deepseek-v4-flash`).
 * - A vendor built-in ref with no faithful catalog id (GLM) falls back to the
 *   metered Auto Router — metered, never a different vendor model.
 * - Any other ref (the metered OpenRouter lane, an explicit operator override,
 *   or a non-vendor ref) passes through unchanged.
 */
export function v2BuiltinModelRef(ref: string): string {
  const slash = ref.indexOf("/");
  if (slash <= 0) return ref;
  const providerId = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const mapped = OPENCODE_V2_VENDOR_MODELS[providerId]?.[modelId];
  if (mapped !== undefined) return `${providerId}/${mapped}`;
  if (isV2VendorBuiltin(providerId)) return `${OPENCODE_V2_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`;
  return ref;
}

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
  /**
   * The vendor family's v2 BUILT-IN provider id (see
   * {@link OPENCODE_V2_VENDOR_BUILTINS}). On v2 the vendor is emitted as an
   * override of this built-in (`settings.baseURL` only) rather than a custom
   * provider, which v2 would not register. Absent means the vendor has no v2
   * built-in and cannot be routed on v2 (recorded, not fabricated); v1 ignores
   * this field entirely (its custom-provider emission is byte-identical).
   */
  readonly v2ProviderId?: string;
}

/**
 * A config-defined LSP server entry (opencode v2 `ConfigLSP.Server`): a
 * `command` argv plus optional `extensions`/`env`/`initialization`. A truthy
 * `lsp` map emits these under the config `lsp` key; a named entry whose id
 * matches a built-in (`typescript`) overrides that built-in's spawn while
 * keeping its root resolution (`packages/opencode/src/lsp/lsp.ts`):
 * `servers[name] = { ...existing, id, root: existing?.root ?? …, spawn: custom }`.
 */
export interface OpencodeLspServer {
  readonly command: readonly string[];
  readonly extensions?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly initialization?: Readonly<Record<string, unknown>> | undefined;
}

export interface MeteredOpencodeConfigOptions {
  readonly proxyUrl: string;
  readonly model?: string | undefined;
  /**
   * W082 (config-side auto-compaction trigger): when true, the composed
   * config carries `compaction: { auto: true }` — the session runtime then
   * compacts on its own at the documented threshold (per-model runtime
   * behavior on the session stream, not the HTTP route; the §9 research
   * note). Deliberate operator opt-in (settings `agents.<id>.autoCompact`),
   * default off: no invented runtime defaults, current behavior unchanged
   * when unset. Budget-guard compatible by construction — a compaction turn
   * is a normal metered model turn through the same loopback proxy the W045
   * interactive budget guard watches.
   */
  readonly autoCompact?: boolean | undefined;
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
/** Workflow-pushed MCP servers (the control plane's settings projection). */
  readonly mcpServers?: readonly McpServerSetting[] | undefined;
  /**
   * W080 mount half: stdio mounts for the delivered skill's DECLARED
   * connectors (validated + built-filtered + operator-disabled-filtered by
   * the caller via `skillConnectorMounts`). Composed into the hub-written
   * config's mcp map only for names not already present (skills-mcp itself
   * arrives through the delivery mount), so the session's tool surface is
   * exactly the declared floor plus the operator's settings — and every
   * entry crosses the same application/guard authorization as any other MCP
   * server. Absent composes nothing.
   */
  readonly skillConnectors?: readonly { readonly name: string; readonly serverPath: string }[] | undefined;
  /**
   * The resolved opencode major version. v1 (<2) keeps the historical
   * `provider`/`npm`/`options` shape byte-for-byte; v2+ emits the v2
   * `providers` shape (`package`/`settings`) and reuses the built-in
   * `openrouter` provider for the metered route, because a config-defined
   * custom provider is not registered into the v2 ACP model catalog (see
   * {@link OPENCODE_V2_METERED_ENV_KEY}). Absent/undefined means v1 (the
   * pre-existing behavior), so callers that do not probe the version are
   * unchanged.
   */
  readonly opencodeMajor?: number | undefined;
  /**
   * W181 (A6): agent-facing instruction-file paths projected into the
   * hub-written config. The caller supplies them only when an enforcing egress
   * posture actually exists (`egressRuntimeContext` returns `undefined`
   * otherwise), so the config never asserts a gate that is not real. Absent
   * leaves the config byte-identical to before this option existed.
   */
  readonly instructions?: readonly string[] | undefined;
  /**
   * LSP enablement (opencode v2 `ConfigLSP.Info`): the value emitted under the
   * config `lsp` key. On v2 an ABSENT key disables every language server
   * (`packages/opencode/src/lsp/lsp.ts`: `if (!cfg.lsp) "all LSPs are
   * disabled"`), so a lane that wants LSP must set this. `true` enables the
   * built-ins; a record enables the built-ins AND applies per-server entries
   * (built-in overrides or custom servers). Absent leaves the config
   * byte-identical to before this option existed.
   */
  readonly lsp?: boolean | Readonly<Record<string, OpencodeLspServer | { readonly disabled: true }>> | undefined;
}

export function meteredOpencodeConfig(options: MeteredOpencodeConfigOptions): Record<string, unknown> {
  const v2 = (options.opencodeMajor ?? 1) >= 2;
  // Expose the Auto Router plus the alias pool as selectable models so the ACP
  // model picker can switch to a specific family's latest without pinning a
  // version. The Auto Router stays the default selection. (v1 only: the v2
  // lane reuses the built-in `openrouter` catalog, which already lists its
  // models, and `~...-latest` aliases are resolved proxy-side for the Auto
  // Router, never forwarded as a model id.)
  const models: Record<string, { name: string }> = {
    [DEFAULT_OPENCODE_MODEL]: { name: "Auto Router" },
    ...autoLatestModelCatalog(options.autoLatest?.aliases ?? []),
  };
  const legacyModel = options.model ?? DEFAULT_OPENCODE_MODEL;
  if (!(legacyModel in models)) models[legacyModel] = { name: legacyModel };
  const vendorProviders = options.openSource?.providers ?? [];
  const v1Provider = (): Record<string, unknown> => ({
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
  // v2: the built-in `openrouter` provider is the ONLY metered route the v2 ACP
  // model catalog registers for the default lane (probe-observed v2.0.10).
  // Override its baseURL to the loopback proxy; activation rides the placeholder
  // env var the launch sets (OPENCODE_V2_METERED_ENV_KEY), so the 0600 config
  // stays credential-free. Each open-source vendor likewise overrides its v2
  // BUILT-IN provider's `settings.baseURL` (the v2 "Endpoint" route keeps the
  // built-in package/models/connection) instead of emitting a custom provider,
  // which v2 does not register; its activation rides the vendor's placeholder
  // env key (OPENCODE_V2_VENDOR_BUILTINS). A vendor with no v2 built-in
  // (`v2ProviderId` absent) is omitted — it cannot be routed on v2, and the
  // omission is deliberate rather than a fabricated custom provider.
  const v2Providers = (): Record<string, unknown> => ({
    [OPENCODE_V2_METERED_PROVIDER_ID]: {
      settings: { baseURL: `${options.proxyUrl}/api/v1` },
    },
    ...Object.fromEntries(
      vendorProviders.flatMap((entry) =>
        entry.v2ProviderId === undefined
          ? []
          : [[entry.v2ProviderId, { settings: { baseURL: entry.baseURL } }] as const],
      ),
    ),
  });
  // v2 default-model translation: the composed open-source default is
  // `<vendorId>/<model>` (vendorId = the v1 custom-provider id). On v2 the same
  // model rides the vendor's BUILT-IN provider id instead. A vendor with no v2
  // built-in falls back to the Auto Router (its config entry was omitted above).
  const v2DefaultModel = (): string => {
    const composed = options.openSource?.defaultModel;
    const slash = composed?.indexOf("/") ?? -1;
    if (composed !== undefined && slash > 0) {
      const builtin = vendorProviders.find((entry) => entry.id === composed.slice(0, slash))?.v2ProviderId;
      if (builtin !== undefined) return `${builtin}/${composed.slice(slash + 1)}`;
    }
    return `${OPENCODE_V2_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`;
  };
  // The operator's explicit model always rides the metered OpenRouter-family
  // provider (closed-model override path). With no override, the open-source
  // pool default applies (translated to the v2 built-in provider on v2); the
  // Auto Router is the fallback when no pool is composed or no vendor has a v2
  // built-in.
  const selectedModel =
    options.model !== undefined
      ? `${v2 ? OPENCODE_V2_METERED_PROVIDER_ID : OPENCODE_METERED_PROVIDER_ID}/${options.model}`
      : v2
        ? v2DefaultModel()
        : options.openSource?.defaultModel ?? `${OPENCODE_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`;
  // Operator-declared MCP servers ride alongside the hub-owned skills mount.
  const mcp: Record<string, unknown> = opencodeMcpServers(options.mcpServers ?? []);
  if (options.skills !== undefined) {
    mcp["skills-mcp"] = {
      type: "local",
      command: [process.execPath, options.skills.serverScript],
      environment: { SKILLS_MCP_DIR: options.skills.skillsDir },
    };
  }
  // W080 mount half: the delivered skill's declared connectors — only names
  // not already present (the delivery mount and operator settings win), each
  // a stdio entry over the vendored built entrypoint.
  for (const connector of options.skillConnectors ?? []) {
    if (mcp[connector.name] !== undefined) continue;
    mcp[connector.name] = {
      type: "local",
      command: [process.execPath, connector.serverPath],
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    ...(v2 ? { providers: v2Providers() } : { provider: v1Provider() }),
    model: selectedModel,
    // The hub is the permission authority: ask-configured tools project
    // session/request_permission to the hub, which resolves each request
    // through WorkflowApplication.authorize (G1 probe: denials honored).
    // `task` is included so subagent spawns are gateable at the hub
    // (subagent probe: the task tool call projected and permission-gated).
    // `skill` is denied per the 2026-09-15 single-delivery-path rule —
    // skills reach the model only through the journaled read_skill. Honest
    // posture: the composed denial's live honoring on the pinned version is
    // probe-gated (the skills-delivery family, pending); the invariant's
    // PROVEN enforcement today is structural (the store lives outside every
    // agent workspace, so the workspace-confined fs lane cannot reach it).
    permission: { edit: "ask", bash: "ask", task: "ask", skill: "deny" },
    // W181 (A6): the posture-gated runtime-context instruction references.
    // Only composed when the caller supplied paths (which it derives from an
    // ACTIVE enforcing posture), so an absent posture leaves this key out
    // entirely — the config never claims deny-by-default on its own.
    ...(options.instructions === undefined || options.instructions.length === 0 ? {} : { instructions: [...options.instructions] }),
    // W082 config-side auto-compaction trigger: only composed when the
    // operator opted in — absent means the runtime's ambient compaction
    // defaults apply, exactly as before this option existed.
    ...(options.autoCompact === true ? { compaction: { auto: true } } : {}),
    // LSP enablement: only composed when a lane supplies a value — absent
    // leaves the config byte-identical to before this option existed. On v2 an
    // absent `lsp` key disables every language server, so the plane lane (which
    // ships the TypeScript server in its image) is the value's source.
    ...(options.lsp === undefined ? {} : { lsp: options.lsp }),
    ...(Object.keys(mcp).length === 0 ? {} : { mcp }),
  };
}

/**
 * The Workflow settings projection for the direct (unmetered) OpenCode launch:
 * operator-declared MCP servers plus the persisted model preference. An empty
 * object means the operator has set nothing, so the launch config stays
 * minimal rather than writing defaults the operator never chose.
 */
export function opencodeSettingsConfig(settings: WorkflowSettings | undefined): Record<string, unknown> {
  if (settings === undefined) return {};
  const mcp = opencodeMcpServers(enabledMcpServers(settings));
  const model = settings.agents.opencode?.model;
  return {
    $schema: "https://opencode.ai/config.json",
    ...(Object.keys(mcp).length === 0 ? {} : { mcp }),
    ...(model === undefined ? {} : { model }),
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
