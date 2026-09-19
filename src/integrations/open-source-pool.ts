/**
 * W070a: the open-source-only default model pool. Direct vendor endpoints are
 * preferred (cost + context caching); OpenRouter is the uniform fallback for
 * any model whose vendor key/endpoint is unavailable. Every ID here was
 * verified live on the date recorded per entry — see
 * `docs/superpowers/specs/2026-09-19-w070a-routing-live-verification.md` for
 * the exact request/response evidence. Closed models are NOT deleted: an
 * explicit operator override (`WORKFLOW_OPENCODE_MODEL`, or a pool entry in
 * `WORKFLOW_OPEN_MODEL_POOL`) still routes them through the proxy.
 */

import { VENDOR_DEFAULTS, type ModelFamily, type ThinkingMode, type WireProtocol } from "./model-profile.js";

export interface OpenRouterFallback {
  readonly provider: "openrouter";
  /** Concrete OpenRouter catalog id (aliases do not resolve inside allowed_models). */
  readonly model: string;
  readonly modelsUrl: string;
}

export interface OpenModelDefinition {
  /** Hub-facing pool id (also the agent-visible model name). */
  readonly id: string;
  readonly label: string;
  readonly family: ModelFamily;
  /** Vendor model id sent to the direct endpoint. */
  readonly model: string;
  readonly endpoint: string;
  readonly wire: WireProtocol;
  readonly thinking: ThinkingMode;
  readonly fallback?: OpenRouterFallback;
  /** Live-verification provenance for the direct ID/endpoint. */
  readonly verifiedOn: string;
  readonly verifiedSource: string;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const VERIFIED_ON = "2026-09-19";

/**
 * Default pool: DeepSeek V4.1-Flash (`deepseek-flash`), GLM-5.3, GLM-5.3-Flash,
 * and Kimi K3. Fallback OpenRouter ids were read from the live catalog
 * (`/api/v1/models`, HTTP 200) on 2026-09-19.
 */
export const DEFAULT_OPEN_SOURCE_POOL: readonly OpenModelDefinition[] = [
  {
    id: "deepseek-flash",
    label: "DeepSeek V4.1-Flash",
    family: "deepseek",
    model: "deepseek-flash",
    endpoint: VENDOR_DEFAULTS.deepseek.endpoint,
    wire: "openai",
    thinking: "opt-in",
    fallback: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", modelsUrl: OPENROUTER_MODELS_URL },
    verifiedOn: VERIFIED_ON,
    verifiedSource: "https://api-docs.deepseek.com/ (model deepseek-flash, OpenAI base https://api.deepseek.com)",
  },
  {
    id: "glm-5.3",
    label: "GLM-5.3",
    family: "glm",
    model: "glm-5.3",
    endpoint: VENDOR_DEFAULTS.glm.endpoint,
    wire: "openai",
    thinking: "always-on",
    fallback: { provider: "openrouter", model: "z-ai/glm-5.3", modelsUrl: OPENROUTER_MODELS_URL },
    verifiedOn: VERIFIED_ON,
    verifiedSource: "https://docs.z.ai/guides/llm/glm-5.3 (model glm-5.3, OpenAI base https://api.z.ai/api/paas/v4)",
  },
  {
    id: "glm-5.3-flash",
    label: "GLM-5.3-Flash",
    family: "glm",
    model: "glm-5.3-flash",
    endpoint: VENDOR_DEFAULTS.glm.endpoint,
    wire: "openai",
    thinking: "always-on",
    fallback: { provider: "openrouter", model: "z-ai/glm-5.3-flash", modelsUrl: OPENROUTER_MODELS_URL },
    verifiedOn: VERIFIED_ON,
    verifiedSource: "https://docs.z.ai/guides/vlm/glm-5.3-flash (model glm-5.3-flash)",
  },
  {
    id: "kimi-k3",
    label: "Kimi K3",
    family: "kimi",
    model: "kimi-k3",
    endpoint: VENDOR_DEFAULTS.kimi.endpoint,
    wire: "openai",
    thinking: "always-on",
    fallback: { provider: "openrouter", model: "moonshotai/kimi-k3", modelsUrl: OPENROUTER_MODELS_URL },
    verifiedOn: VERIFIED_ON,
    verifiedSource: "https://platform.kimi.ai/docs/api/chat (model kimi-k3, OpenAI base https://api.moonshot.ai/v1)",
  },
];

export function openSourceModelIds(pool: readonly OpenModelDefinition[] = DEFAULT_OPEN_SOURCE_POOL): readonly string[] {
  return pool.map((entry) => entry.id);
}

export function findOpenModel(id: string, pool: readonly OpenModelDefinition[] = DEFAULT_OPEN_SOURCE_POOL): OpenModelDefinition | undefined {
  return pool.find((entry) => entry.id === id);
}

/** True when `id` is a member of the open-source pool. */
export function isOpenSourceModel(id: string, pool: readonly OpenModelDefinition[] = DEFAULT_OPEN_SOURCE_POOL): boolean {
  return pool.some((entry) => entry.id === id);
}

/**
 * Resolves the env-configured pool. `WORKFLOW_OPEN_MODEL_POOL` selects an
 * ordered subset by pool id (comma/space separated); an unknown id is a
 * configuration error, never silently dropped.
 */
export function openSourcePoolFromEnv(env: NodeJS.ProcessEnv = process.env): readonly OpenModelDefinition[] {
  const raw = env.WORKFLOW_OPEN_MODEL_POOL?.trim();
  if (raw === undefined || raw === "") return DEFAULT_OPEN_SOURCE_POOL;
  const ids = raw.split(/[,\s]+/).filter((part) => part.length > 0);
  return ids.map((id) => {
    const entry = findOpenModel(id);
    if (entry === undefined) {
      throw new Error(`WORKFLOW_OPEN_MODEL_POOL names an unknown open-source model: ${JSON.stringify(id)}`);
    }
    return entry;
  });
}

export type ModelRouteKind = "direct" | "openrouter";

export interface ModelRoute {
  readonly kind: ModelRouteKind;
  readonly model: string;
  readonly endpoint: string;
  /** Provider family used to pick the metering proxy; openrouter for fallbacks. */
  readonly provider: ModelFamily | "openrouter";
}

/**
 * Direct-first routing with OpenRouter fallback. `directAvailable` is the
 * caller's live signal (vendor key present / health probe); when false and the
 * entry has a verified fallback, the OpenRouter concrete id is used instead.
 * No fallback and no direct availability fails loudly rather than guessing an
 * id.
 */
export function resolveOpenModelRoute(def: OpenModelDefinition, options: { readonly directAvailable?: boolean } = {}): ModelRoute {
  if (options.directAvailable !== false) {
    return { kind: "direct", model: def.model, endpoint: def.endpoint, provider: def.family };
  }
  if (def.fallback === undefined) {
    throw new Error(`open-source model ${JSON.stringify(def.id)} has no verified OpenRouter fallback; cannot route without the vendor endpoint`);
  }
  return { kind: "openrouter", model: def.fallback.model, endpoint: "", provider: "openrouter" };
}

/**
 * Explicit operator override for closed models. Closed models remain fully
 * supported and are never removed from the codebase; an operator selects one
 * by naming it, which bypasses the open-source default pool.
 */
export function closedModelOverride(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  return isOpenSourceModel(trimmed) ? undefined : trimmed;
}

/** Effective default selection: operator override wins, else the pool default. */
export function resolveModelSelection(options: {
  readonly override?: string | undefined;
  readonly pool?: readonly OpenModelDefinition[];
} = {}): { readonly model: string; readonly source: "override" | "pool"; readonly closed: boolean } {
  const override = closedModelOverride(options.override);
  if (override !== undefined) return { model: override, source: "override", closed: true };
  const pool = options.pool ?? DEFAULT_OPEN_SOURCE_POOL;
  const first = pool[0];
  if (first === undefined) throw new Error("open-source pool is empty");
  return { model: first.id, source: "pool", closed: false };
}
