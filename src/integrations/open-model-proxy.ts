/**
 * W070a: composes the open-source vendors through the existing loopback
 * metering proxy — one proxy per vendor family, each holding that vendor's
 * real key proxy-side while the agent receives only the placeholder key. This
 * is the same posture as the OpenRouter composition: the key never enters the
 * agent's environment or config files.
 *
 * Direct vendor endpoints are preferred. A family with no resolved key starts
 * no proxy, so its models route through the OpenRouter fallback instead (see
 * `resolveOpenModelRoute`); nothing here guesses an id or invents a key.
 */

import { createModelUsageProxy, type ModelUsageMetrics, type ModelUsageProxy } from "./model-usage-proxy.js";
import { modelProfile, shapeRequestBody, type ModelFamily, type ModelTaskClass } from "./model-profile.js";
import { DEFAULT_OPEN_SOURCE_POOL, type OpenModelDefinition } from "./open-source-pool.js";

export interface OpenModelProvider {
  readonly providerId: string;
  readonly family: ModelFamily;
  /** Loopback base URL the agent uses (proxy origin + vendor path prefix). */
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly proxy: ModelUsageProxy;
}

export interface CreateOpenModelMeteringPoolOptions {
  readonly pool?: readonly OpenModelDefinition[];
  readonly keys: Readonly<Partial<Record<ModelFamily, string>>>;
  /**
   * Overrides the upstream endpoint per definition. Injectable for tests so
   * composition can be exercised against loopback fakes; production uses the
   * live-verified vendor endpoint.
   */
  readonly upstreamOverride?: (def: OpenModelDefinition) => string | undefined;
  /** Task class driving each profile's effort default; coding is the default. */
  readonly taskClass?: ModelTaskClass;
  readonly onUsage?: (family: ModelFamily, usage: Record<string, unknown>) => void;
}

export interface OpenModelMeteringPool {
  readonly providers: readonly OpenModelProvider[];
  readonly byFamily: ReadonlyMap<ModelFamily, OpenModelProvider>;
  /** Aggregated usage across every vendor proxy in the pool. */
  metrics(): ModelUsageMetrics;
  close(): Promise<void>;
}

export function openModelProviderId(family: ModelFamily): string {
  return `workflow-${family}`;
}

/** Loopback base URL for a vendor: preserve the vendor's API path prefix. */
export function proxyBaseUrl(proxyUrl: string, endpoint: string): string {
  const path = new URL(endpoint).pathname.replace(/\/+$/, "");
  return `${proxyUrl}${path}`;
}

export async function createOpenModelMeteringPool(options: CreateOpenModelMeteringPoolOptions): Promise<OpenModelMeteringPool> {
  const pool = options.pool ?? DEFAULT_OPEN_SOURCE_POOL;
  const byFamily = new Map<ModelFamily, OpenModelDefinition[]>();
  for (const def of pool) {
    const list = byFamily.get(def.family);
    if (list === undefined) byFamily.set(def.family, [def]);
    else list.push(def);
  }

  const providers: OpenModelProvider[] = [];
  const started: ModelUsageProxy[] = [];
  try {
    for (const [family, defs] of byFamily) {
      const key = options.keys[family];
      if (key === undefined || key.trim() === "") continue;
      const first = defs[0];
      if (first === undefined) continue;
      // All models in a family must share one vendor endpoint; otherwise one
      // proxy cannot serve them and the config would silently misroute.
      for (const def of defs) {
        if (def.endpoint !== first.endpoint) {
          throw new Error(`open-source family ${family} spans multiple endpoints (${first.endpoint} vs ${def.endpoint}); split the family before composing`);
        }
      }
      const upstream = options.upstreamOverride?.(first) ?? first.endpoint;
      // W070a: apply ModelProfile request shaping at the vendor boundary so the
      // invariant (GLM/K3 never receive thinking:disabled) holds on the wire,
      // not just in the type. Profiles are keyed by the vendor model id the
      // agent sends in the request body.
      const profiles = new Map(
        defs.map((def) => [
          def.model,
          modelProfile({ family, model: def.model, ...(options.taskClass === undefined ? {} : { taskClass: options.taskClass }) }),
        ]),
      );
      const proxy = await createModelUsageProxy({
        upstream,
        apiKey: key,
        transformBody: (body) => {
          const model = body.model;
          if (typeof model !== "string") return body;
          const profile = profiles.get(model);
          return profile === undefined ? body : shapeRequestBody(profile, body);
        },
        ...(options.onUsage === undefined
          ? {}
          : { onUsage: (usage: Record<string, unknown>) => options.onUsage?.(family, usage) }),
      });
      started.push(proxy);
      const provider: OpenModelProvider = {
        providerId: openModelProviderId(family),
        family,
        baseUrl: proxyBaseUrl(proxy.url, first.endpoint),
        models: defs.map((def) => def.id),
        proxy,
      };
      providers.push(provider);
    }
  } catch (error) {
    await Promise.allSettled(started.map((proxy) => proxy.close()));
    throw error;
  }

  const byFamilyProviders = new Map(providers.map((provider) => [provider.family, provider]));
  return {
    providers,
    byFamily: byFamilyProviders,
    metrics(): ModelUsageMetrics {
      let requests = 0;
      let usageEvents = 0;
      let promptTokens = 0;
      let completionTokens = 0;
      let totalTokens = 0;
      let costUsd = 0;
      let latest: number | undefined;
      for (const provider of providers) {
        const metrics = provider.proxy.metrics();
        requests += metrics.requests;
        usageEvents += metrics.usageEvents;
        promptTokens += metrics.promptTokens;
        completionTokens += metrics.completionTokens;
        totalTokens += metrics.totalTokens;
        costUsd += metrics.costUsd;
        if (metrics.latestPromptTokens !== undefined) latest = metrics.latestPromptTokens;
      }
      return { requests, usageEvents, promptTokens, completionTokens, totalTokens, costUsd, latestPromptTokens: latest };
    },
    async close(): Promise<void> {
      await Promise.allSettled(providers.map((provider) => provider.proxy.close()));
    },
  };
}
