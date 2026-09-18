/**
 * OpenRouter Auto Router "latest" pool — hub-side, agent-agnostic.
 *
 * WHY THIS EXISTS
 * ---------------
 * The hub routes every agent's model traffic through the loopback metering
 * proxy (`src/integrations/model-usage-proxy.ts`) and defaults agents to
 * `openrouter/auto` (`DEFAULT_OPENCODE_MODEL`). The intended workflow is the
 * `~<lab>/<model>-latest` aliases: one per frontier family, never pinned by
 * hand, always resolving to the current flagship.
 *
 * OpenRouter's Auto Router accepts an `allowed_models` constraint, but that
 * constraint only matches **concrete catalog IDs**. `~...-latest` aliases
 * resolve fine when used as a top-level `model`, but inside `allowed_models`
 * they resolve to nothing. The candidate pool then collapses and every request
 * fails with `404 No models match your request and model restrictions`.
 *
 * This module closes that gap at the hub, where it applies to *every* agent
 * surface (OpenCode, Cline, any future adapter) without a client-side plugin:
 * it resolves each alias to the concrete slug OpenRouter currently points at
 * (`alias_target.slug`) and injects the resolved list into the Auto Router
 * request body as it passes the proxy.
 *
 * IMPORTANT: OpenRouter's "Prevent overrides" toggle
 * (https://openrouter.ai/settings/routing) makes the saved account Auto Router
 * values final and causes request-level settings to be ignored. When it is ON
 * and the saved allowlist is unhealthy, nothing server-side or client-side can
 * fix routing; the saved list must be corrected.
 *
 * @see https://openrouter.ai/docs/guides/routing/routers/auto-router
 */

/** Default pool: one `~...-latest` alias per frontier family. */
export const DEFAULT_AUTO_LATEST_ALIASES: readonly string[] = [
  "~anthropic/claude-opus-latest",
  "~anthropic/claude-sonnet-latest",
  "~anthropic/claude-haiku-latest",
  "~anthropic/claude-fable-latest",
  "~openai/gpt-astra-latest",
  "~openai/gpt-sol-latest",
  "~openai/gpt-terra-latest",
  "~openai/gpt-luna-latest",
  "~openai/gpt-mini-latest",
  "~google/gemini-pro-latest",
  "~google/gemini-flash-latest",
  "~x-ai/grok-latest",
  "~deepseek/deepseek-pro-latest",
  "~deepseek/deepseek-flash-latest",
  "~deepseek/deepseek-v4-flash-latest",
  "~z-ai/glm-latest",
  "~z-ai/glm-flash-latest",
  "~moonshotai/kimi-latest",
];

/** Auto Router plugin id for `openrouter/auto`. */
export const AUTO_ROUTER_PLUGIN_ID = "auto-router";
/** Auto Router plugin id for `openrouter/auto-beta` (it reads its own id). */
export const AUTO_BETA_ROUTER_PLUGIN_ID = "auto-beta-router";

const AUTO_ROUTER_MODELS: Readonly<Record<string, string>> = {
  "openrouter/auto": AUTO_ROUTER_PLUGIN_ID,
  "openrouter/auto-beta": AUTO_BETA_ROUTER_PLUGIN_ID,
};

const OPENROUTER_HOSTS = new Set(["openrouter.ai", "eu.openrouter.ai", "us.openrouter.ai"]);
const DISABLED_TOGGLES = new Set(["0", "false", "off", "disabled", "no"]);

/** Resolved Auto Router pool plus optional cost band. */
export interface AutoLatestConfig {
  readonly aliases: readonly string[];
  readonly costTier?: string;
}

/** True when `model` is an OpenRouter Auto Router slug this module configures. */
export function isAutoRouterModel(model: unknown): model is string {
  return typeof model === "string" && Object.hasOwn(AUTO_ROUTER_MODELS, model);
}

/** The plugin id that `model` reads (`auto-router` or `auto-beta-router`). */
export function autoRouterPluginId(model: string): string {
  return AUTO_ROUTER_MODELS[model] ?? AUTO_ROUTER_PLUGIN_ID;
}

export interface AliasResolverOptions {
  /** Public model catalog URL, e.g. `https://openrouter.ai/api/v1/models`. */
  readonly modelsUrl: string;
  readonly aliases: readonly string[];
  /** Injectable for tests. */
  readonly fetch?: typeof fetch;
  /** Injectable clock for tests. */
  readonly now?: () => number;
  /** Cache lifetime; defaults to 6 hours. */
  readonly ttlMs?: number;
}

export interface AliasResolver {
  /** Concrete slugs for the configured aliases; `[]` on failure (fail open). */
  resolve(): Promise<string[]>;
}

/**
 * Builds a cached `~...-latest` → concrete-slug resolver. Resolution failure
 * returns the last known pool (or `[]`) and never throws: model traffic must
 * not break because the catalog endpoint hiccuped.
 */
export function createAliasResolver(options: AliasResolverOptions): AliasResolver {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
  let cached: { readonly at: number; readonly slugs: string[] } | undefined;
  let inflight: Promise<string[]> | undefined;

  function resolve(): Promise<string[]> {
    if (cached !== undefined && now() - cached.at < ttlMs) return Promise.resolve(cached.slugs);
    if (inflight !== undefined) return inflight;
    inflight = (async () => {
      try {
        const response = await doFetch(options.modelsUrl, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`model catalog fetch failed: ${response.status}`);
        const targets = aliasTargets(await response.json());
        const slugs = options.aliases
          .map((alias) => targets.get(alias))
          .filter((slug): slug is string => slug !== undefined);
        if (slugs.length > 0) cached = { at: now(), slugs };
        return cached?.slugs ?? [];
      } catch {
        return cached?.slugs ?? [];
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  return { resolve };
}

/** Extracts `~alias → alias_target.slug` pairs from a `/models` payload. */
export function aliasTargets(payload: unknown): Map<string, string> {
  const targets = new Map<string, string>();
  if (!isRecord(payload) || !Array.isArray(payload.data)) return targets;
  for (const model of payload.data) {
    if (!isRecord(model)) continue;
    const id = model.id;
    const target = model.alias_target;
    if (typeof id === "string" && id.startsWith("~") && isRecord(target) && typeof target.slug === "string") {
      targets.set(id, target.slug);
    }
  }
  return targets;
}

/**
 * Returns a copy of a chat-completion body with the resolved Auto Router pool
 * injected. Any caller-supplied auto-router plugin is replaced (the hub owns
 * the pool); other plugins are preserved.
 */
export function applyAutoRouterPlugin(
  body: Record<string, unknown>,
  model: string,
  allowedModels: readonly string[],
  costTier?: string,
): Record<string, unknown> {
  const pluginId = autoRouterPluginId(model);
  const existing = Array.isArray(body.plugins) ? body.plugins : [];
  const kept = existing.filter((plugin) => !(isRecord(plugin) && plugin.id === pluginId));
  const plugin: Record<string, unknown> = { id: pluginId, allowed_models: [...allowedModels] };
  if (costTier !== undefined && costTier !== "") plugin.cost_tier = costTier;
  return { ...body, plugins: [...kept, plugin] };
}

/**
 * Derives the Auto Router config from the environment. Enabled by default when
 * the upstream is OpenRouter; `WORKFLOW_OPENROUTER_AUTO_LATEST` disables it,
 * `WORKFLOW_OPENROUTER_AUTO_ALIASES` overrides the pool (comma/space separated),
 * and `WORKFLOW_OPENROUTER_AUTO_COST_TIER` sets the cost band.
 */
export function autoLatestConfigFromEnv(options: {
  readonly upstream: string;
  readonly env?: NodeJS.ProcessEnv;
}): AutoLatestConfig | undefined {
  const env = options.env ?? process.env;
  if (!OPENROUTER_HOSTS.has(upstreamHost(options.upstream) ?? "")) return undefined;
  if (DISABLED_TOGGLES.has(env.WORKFLOW_OPENROUTER_AUTO_LATEST?.trim().toLowerCase() ?? "")) return undefined;
  const aliases = parseAliases(env.WORKFLOW_OPENROUTER_AUTO_ALIASES);
  const costTier = env.WORKFLOW_OPENROUTER_AUTO_COST_TIER?.trim();
  return {
    aliases: aliases.length > 0 ? aliases : DEFAULT_AUTO_LATEST_ALIASES,
    ...(costTier !== undefined && costTier !== "" ? { costTier } : {}),
  };
}

function parseAliases(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function upstreamHost(upstream: string): string | undefined {
  try {
    return new URL(upstream).hostname;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
