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

import { composeBodyTransforms, createModelUsageProxy, type EgressDenialEvent, type EgressObservation, type ModelUsageMetrics, type ModelUsageProxy, type ProxyPayloadPolicy } from "./model-usage-proxy.js";
import { applyCacheMarkers, modelProfile, shapeRequestBody, type CacheMarkerOptIn, type ModelFamily, type ModelTaskClass } from "./model-profile.js";
import { DEFAULT_OPEN_SOURCE_POOL, type OpenModelDefinition } from "./open-source-pool.js";
import type { BudgetDowngradeRuntime } from "./session-budget.js";
import type { CredentialEndpoint } from "./credentials.js";

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
  /**
   * W109 (W098 c2): the per-pool prompt-cache opt-in. True enables the
   * cache-control marker pass (`applyCacheMarkers`) for this pool's
   * anthropic-wire profiles; absent stays absent. P14 (issue #293): a map
   * narrows the opt-in per family — only the families listed `true` are
   * marked, an omitted family stays dark.
   */
  readonly cacheMarkers?: CacheMarkerOptIn;
  /**
   * W118 (the W095 budget-downgrade consumer): the downgrade axes passed
   * through to every family proxy. The activation reads each family
   * proxy's OWN recorded usage (the granularity residual: a session
   * spreading traffic across families sums separately). Absent = no
   * downgrade.
   */
  readonly budgetDowngrade?: BudgetDowngradeRuntime;
  /**
   * P9 option D (issue #288, 2026-09-30): when explicitly `true`, every family
   * proxy enforces the anthropic Messages-schema replay integrity check on the
   * `POST /v1/messages` lane (an unpaired tool_use/tool_result or a stripped
   * thinking signature is refused with a structured, named 400; an unparseable
   * body fails closed). The W070b sanctioned synthetic-tool-call insertion
   * stays allowed. DEFAULT `undefined` is DARK: no proxy gets the tier, so the
   * lane stays byte-unchanged by construction. Its production gate is the
   * host-body audit (the brief's option D) — this wires the opt-in, it does not
   * turn anything ON.
   */
  readonly messagesReplayIntegrity?: boolean;
  /**
   * W180 (NVIDIA adoption wave A3): the proxy payload/egress policy threaded
   * into every family proxy BY COMPOSITION. The W070a per-family proxies do not
   * reimplement the tier: they pass the same `payloadPolicy` seam through to
   * `createModelUsageProxy`, so the shared W178 `decideEgress` decision governs
   * each family proxy exactly as it governs the OpenRouter lane. Absent (the
   * default) leaves every family proxy byte-identical to today.
   */
  readonly payloadPolicy?: ProxyPayloadPolicy;
  readonly onUsage?: (family: ModelFamily, usage: Record<string, unknown>) => void;
  /**
   * W181 (A5): shared egress observation sink applied to every family proxy in
   * the pool. Absent leaves each proxy's default (no observation).
   */
  readonly onEgressObservation?: (observation: EgressObservation) => void;
  /**
   * W182 (A7): the shared egress-denial sink threaded into every family proxy,
   * so a credential-gate denial through the open-source lane parks on the same
   * hub surface as the OpenRouter lane. Only the credential gates reach it —
   * W180's path/function policy tier (issue #440) does not yet route here, so an
   * approvable `egress_policy` denial cannot flow through. Absent leaves the
   * family proxies' refusal posture byte-identical. Observation only.
   */
  readonly onEgressDenied?: ((event: EgressDenialEvent) => void) | undefined;
  /**
   * W179 gate-2 binding, per family. The family proxies inject a vendor key
   * loaded through a SEPARATE custody path (`OPEN_MODEL_KEY_ENV` / key files)
   * — not `CredentialDefinition.allowedEndpoints` — so the binding is supplied
   * explicitly per family, never derived from the OpenRouter-origin operator
   * definitions (which would not match a vendor host and could only 403 all
   * family traffic). Absent leaves every family proxy's gate 2 inactive and
   * byte-identical; an empty array for a family matches nothing (fail closed).
   */
  readonly credentialEndpointsByFamily?: Readonly<Partial<Record<ModelFamily, readonly CredentialEndpoint[]>>>;
}

export interface OpenModelMeteringPool {
  readonly providers: readonly OpenModelProvider[];
  readonly byFamily: ReadonlyMap<ModelFamily, OpenModelProvider>;
  /** Aggregated usage across every vendor proxy in the pool. */
  metrics(): ModelUsageMetrics;
  /**
   * P15 (b): the per-family view of the pool's RECORDED usage — one entry
   * per family with a composed proxy, each the family proxy's OWN metrics()
   * (the same per-entry records the aggregate sums), never a view-side
   * re-derivation of tokens or costs. Additive: `metrics()` stays the
   * cross-family aggregate its consumers (the W119 abort-tier snapshot)
   * already read, byte-identical.
   */
  perFamilyMetrics(): ReadonlyMap<ModelFamily, ModelUsageMetrics>;
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
          modelProfile({
            family,
            model: def.model,
            // W109: the definition's wire reaches the profile — the pool
            // definition declares the wire, and an anthropic-wire pool must
            // shape and mark on that wire. The pre-change composer dropped
            // the wire, which made anthropic-wire profiles unconstructible;
            // threading it is ONE PREREQUISITE of several for such pools to
            // function end-to-end (frontier round 1 P1: the messages-lane
            // transform+metering governance, a production opt-in
            // composition, and probed vendor support are the others —
            // queued in the W109 ledger item).
            wire: def.wire,
            ...(options.taskClass === undefined ? {} : { taskClass: options.taskClass }),
            ...(options.cacheMarkers === undefined ? {} : { cacheMarkers: options.cacheMarkers }),
          }),
        ]),
      );
      const proxy = await createModelUsageProxy({
        upstream,
        apiKey: key,
        transformBody: composeBodyTransforms([
          (body) => {
            const model = body.model;
            if (typeof model !== "string") return body;
            const profile = profiles.get(model);
            return profile === undefined ? body : shapeRequestBody(profile, body);
          },
          (body) => {
            const model = body.model;
            if (typeof model !== "string") return body;
            const profile = profiles.get(model);
            return profile === undefined ? body : applyCacheMarkers(profile, body);
          },
        ]),
        ...(options.cacheMarkers === undefined
          ? {}
          : {
              // P9 option C (issue #288, 2026-09-30): markers-only on the
              // anthropic messages lane. Reuses `applyCacheMarkers` verbatim
              // (the same per-family opt-in + wire gate) on the lane's STATIC
              // HEAD — no shaping, no downgrade, no usage.include, no replay
              // gate. Supplied ONLY when an opt-in exists, so the default lane
              // forwards byte-unchanged by construction; a family omitted from
              // the map returns the body by reference, also byte-unchanged. The
              // P8 provider-lane probes remain the activation gate — this does
              // not turn any family ON.
              messagesTransformBody: composeBodyTransforms([
                (body: Record<string, unknown>) => {
                  const model = body.model;
                  if (typeof model !== "string") return body;
                  const profile = profiles.get(model);
                  return profile === undefined ? body : applyCacheMarkers(profile, body);
                },
              ]),
            }),
        ...(options.onUsage === undefined
          ? {}
          : { onUsage: (usage: Record<string, unknown>) => options.onUsage?.(family, usage) }),
        ...(options.budgetDowngrade === undefined ? {} : { budgetDowngrade: options.budgetDowngrade }),
        // W182 (A7): the shared egress-denial sink rides every family proxy.
        ...(options.onEgressDenied === undefined ? {} : { onEgressDenied: options.onEgressDenied }),
        // P9 option D: supplied ONLY on an explicit true opt-in, so the default
        // pool never gets the tier (the lane stays dark/byte-unchanged).
        ...(options.messagesReplayIntegrity === true ? { messagesReplayIntegrity: true } : {}),
        ...(options.onEgressObservation === undefined ? {} : { onEgressObservation: options.onEgressObservation }),
        // W180 (A3/A4): threaded by composition — the family proxy consults the
        // same shared decision; absent leaves the proxy byte-identical.
        ...(options.payloadPolicy === undefined ? {} : { payloadPolicy: options.payloadPolicy }),
        // W179 gate-2: the family's explicit binding (dark when absent).
        ...(options.credentialEndpointsByFamily?.[family] === undefined
          ? {}
          : { credentialEndpoints: options.credentialEndpointsByFamily[family] }),
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
  // P15 (b): ONE snapshot source for both views — the aggregate sums these
  // same per-entry recorded metrics (unchanged arithmetic and order), and
  // perFamilyMetrics exposes each family's entry as-is. Recorded-only: the
  // split is read from the proxies, never re-derived from a request log.
  const recordedByFamily = (): ReadonlyMap<ModelFamily, ModelUsageMetrics> =>
    new Map(providers.map((provider) => [provider.family, provider.proxy.metrics()]));
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
      let cacheReadTokens = 0;
      let cacheCreateTokens = 0;
      let latest: number | undefined;
      for (const metrics of recordedByFamily().values()) {
        requests += metrics.requests;
        usageEvents += metrics.usageEvents;
        promptTokens += metrics.promptTokens;
        completionTokens += metrics.completionTokens;
        totalTokens += metrics.totalTokens;
        costUsd += metrics.costUsd;
        cacheReadTokens += metrics.cacheReadTokens;
        cacheCreateTokens += metrics.cacheCreateTokens;
        if (metrics.latestPromptTokens !== undefined) latest = metrics.latestPromptTokens;
      }
      return { requests, usageEvents, promptTokens, completionTokens, totalTokens, costUsd, latestPromptTokens: latest, cacheReadTokens, cacheCreateTokens };
    },
    perFamilyMetrics(): ReadonlyMap<ModelFamily, ModelUsageMetrics> {
      return recordedByFamily();
    },
    async close(): Promise<void> {
      await Promise.allSettled(providers.map((provider) => provider.proxy.close()));
    },
  };
}
