import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  affinityPin,
  applyAutoRouterPlugin,
  createAliasResolver,
  isAutoRouterModel,
  narrowToAffinityPin,
  type AffinityPinEvent,
  type AliasResolver,
  type AutoLatestAffinityOptions,
} from "./openrouter-auto-latest.js";
import { checkEgressCredential, checkCredentialEndpoint, METERED_PLACEHOLDER_KEY } from "./egress-credential.js";
import type { CredentialEndpoint } from "./credentials.js";
import { decideEgress, type EgressDecision, type EgressPolicy, type EgressRequest } from "./egress-policy.js";
import { enforceReplayPolicy } from "./model-replay-policy.js";
import { enforceMessagesReplayIntegrity, unparseableMessagesBodyRejection } from "./messages-replay-integrity.js";
import { budgetDowngradeActive, type BudgetDowngradeRuntime } from "./session-budget.js";

export { METERED_PLACEHOLDER_KEY };

/**
 * W179: the value-free refusal event for the second credential gate. Only
 * destination facts travel — the request host/port/pathname and the policy
 * family. Deliberately carries NO header value, NO placeholder, and NO query
 * string, so any consumer (log, ledger) that prints this event cannot leak
 * secret or request content.
 */
export interface CredentialEndpointRejection {
  readonly policy: "credential_endpoint_mismatch";
  readonly host: string;
  readonly port: number | undefined;
  /** Pathname only; the query string is never captured. */
  readonly pathname: string;
}

/**
 * W180 (NVIDIA adoption wave A3): the value-free refusal event for the
 * path/function allowlist tier. Only destination facts travel — host, port,
 * method, pathname, and the policy family. Deliberately carries NO header
 * value, NO placeholder, and NO query string, so a consumer that prints this
 * event cannot leak secret or request content. The method/pathname are request
 * facts, not credential or body content.
 */
export interface EgressPolicyRejection {
  readonly policy: "egress_policy";
  readonly host: string;
  readonly port: number | undefined;
  readonly method: string | undefined;
  /** Pathname only; the query string is never captured. */
  readonly pathname: string;
  /** The shared decision's reason, e.g. `denied_by_enforce_rule` or `no_matching_rule`. */
  readonly reason: string;
}

/**
 * W180 (NVIDIA adoption wave A4): the value-free refusal event for the
 * payload size ceiling — the C3 payload-policy extension point. Only byte
 * counts and the policy family travel; never body bytes or headers.
 */
export interface PayloadSizeRejection {
  readonly policy: "payload_too_large";
  readonly limitBytes: number;
  readonly observedBytes: number;
}

/**
 * W180 (A3/A4): the composed payload/egress policy axes. Both sub-policies
 * default dark. The `egressPolicy` may be supplied alone (path/function
 * allowlist) and the `maxRequestBodyBytes` may be supplied alone (size
 * ceiling). They are grouped so an extension surface has one typed seam.
 */
export interface ProxyPayloadPolicy {
  /**
   * A3: the path/function allowlist consulted through W178's shared
   * `decideEgress`. It applies ONLY to requests bound for the proxy's own
   * upstream origin (a proxy is single-origin by construction), so the L4
   * `host` is not part of the grant — the tier closes the function-broad
   * grant for proxy-passed traffic. The tier is deny-by-default for a supplied
   * policy: `decideEgress`'s `no_matching_rule` (its documented default-allow
   * reason, which the W178 core reports rather than denies) is treated as DENY.
   * Per-endpoint posture is respected: an `audit`-mode endpoint still forwards
   * out-of-scope requests (`audit_only`), and an `enforce`-mode endpoint
   * refuses them (`denied_by_enforce_rule`). See `applyEgressPolicyTier`.
   */
  readonly egressPolicy?: EgressPolicy | undefined;
  /**
   * A4: the size ceiling (C3 extension point). A request body larger than
   * this many bytes is refused BEFORE any body transform, credential
   * injection, or forwarding. Absent leaves today's behavior byte-identical.
   * Fail closed: a supplied limit of `0` refuses every non-empty body.
   */
  readonly maxRequestBodyBytes?: number | undefined;
}

/**
 * W182 (NVIDIA adoption wave A7): the SHARED, value-free egress denial event —
 * the one shape the proxy-boundary rejections emit, so an operator-approval
 * sink attaches at one point instead of forking per gate. It fires from gate 1
 * (`egress-credential`), gate 2 (`credential_endpoint_mismatch`), and — as of
 * W184 — the W180 path/function policy tier (`egress_policy`). The
 * `egress_policy` deny-by-default `no_matching_rule` family is the one W182
 * operator-APPROVABLE family, so an approval can now merge a durable revision
 * end-to-end. Carries ONLY destination facts — host, port, method, pathname,
 * and the policy family/reason — never a header value, secret, placeholder, or
 * query string. `pathname` is already query-free by the time it arrives.
 *
 * Observation-only at this seam: the callback cannot block, delay, or rewrite
 * a request; a throw is swallowed so an approval sink can never change the
 * proxy's refusal posture (the refusal is answered regardless).
 */
export interface EgressDenialEvent {
  /**
   * The value-free policy family: `egress-credential`,
   * `credential_endpoint_mismatch`, or (W184) `egress_policy`.
   */
  readonly policy: string;
  /** A value-free reason label; never request content. */
  readonly reason: string;
  readonly host: string;
  readonly port: number | undefined;
  readonly method: string | undefined;
  /** Pathname only; the query string is never captured. */
  readonly pathname: string;
}

/**
 * P9 A′: the messages-lane model-label journal bound. The journal is
 * observation only; past the bound the OLDEST label drops so a long-lived
 * proxy never grows unbounded (the repo's bounded-journal posture). 64 matches
 * the run registry's bounded gate journals (`src/integrations/activity-timeline.ts:34`).
 */
const MESSAGES_LANE_LABEL_LIMIT = 64;

/**
 * W181 (A5): the egress observation journal bound. Observation only; past the
 * bound the OLDEST event drops so a long-lived proxy never grows unbounded
 * (the same bounded-journal posture as the messages-lane labels above). 128 is
 * a deliberately small window: the journal is a live sample for the audit
 * bridge, not the durable ledger (that is `egress-audit-mcp`'s job).
 */
const EGRESS_OBSERVATION_LIMIT = 128;

/**
 * W181 (A5): a bounded, path-shape-derived function class for the observation
 * seam. The URL's query string is never read into the result — only the path
 * suffix selects a label — so nothing query-shaped can reach the ledger. The
 * labels mirror the `egress-audit-mcp` suggested classes.
 */
function classifyEgressFunctionClass(method: string | undefined, url: string | undefined): string {
  if (typeof url !== "string") return "unknown";
  const path = url.split("?")[0] ?? "";
  if (method === "POST" && /\/v1\/messages$/.test(path)) return "messages";
  if (method === "POST" && /\/chat\/completions$/.test(path)) return "chat-completions";
  if (/\/models$/.test(path)) return "models-list";
  if (/\/embeddings$/.test(path)) return "embeddings";
  return "unknown";
}

/** Structural deep copy so neither the callback nor a reader can mutate a recorded event. */
function copyEgressObservation(observation: EgressObservation): EgressObservation {
  return observation.kind === "reach"
    ? { ...observation, anomalyContext: { ...observation.anomalyContext } }
    : { ...observation, anomalyContext: { ...observation.anomalyContext } };
}

/**
 * W109 (W095 c2): a body transform for the metering proxy's policy-routing
 * seam. Pure: takes the current body, returns the next body (or a non-record
 * to be skipped). Consumers: the W070a profile shaping, the W098 c2 cache
 * marker pass, and the W095 budget-downgrade body rewrite (the third
 * consumer, landed W118).
 */
export type BodyTransform = (body: Record<string, unknown>) => Record<string, unknown>;

/**
 * W109 (W095 c2): composes body transforms in order into one transform for
 * the proxy's `transformBody` seam. Per-stage fail-open: a stage whose
 * return is not a record — or that THROWS — is skipped and the chain
 * continues with the last good body, so composing consumers cannot change
 * the pass-through posture. An empty list returns the body untouched.
 *
 * Ordering guidance for policy consumers (frontier round 1 P3): a stage
 * that REWRITES `body.model` (the W095 budget-downgrade rewrite) must
 * attach BEFORE the profile-shaping stage — both key on `body.model`, and
 * a model rewrite after shaping leaves the body shaped for the
 * pre-downgrade model. HONORED by the W118 consumer: the downgrade stage
 * composes BEFORE the caller's transformBody (the shaping+marker stages)
 * inside createModelUsageProxy, and the order is discriminated by the
 * W118 pin (the downgraded body carries no pre-downgrade shaping
 * artifacts).
 */
export function composeBodyTransforms(transforms: readonly BodyTransform[]): BodyTransform {
  return (body: Record<string, unknown>): Record<string, unknown> => {
    let current = body;
    for (const transform of transforms) {
      let result: unknown;
      try {
        result = transform(current);
      } catch {
        // W109 (frontier round 1 P2): the fail-open extends to THROWING
        // stages — a buggy policy-critical stage is skipped and the chain
        // continues with the last good body, so composing consumers cannot
        // change the pass-through posture (a propagating throw would 502 the
        // whole pool).
        continue;
      }
      if (isRecordTransformResult(result)) current = result;
    }
    return current;
  };
}

function isRecordTransformResult(value: Record<string, unknown> | unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ModelUsageMetrics {
  readonly requests: number;
  readonly usageEvents: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly latestPromptTokens: number | undefined;
  /**
   * P12 (W109 gap 2): the cache components, first-class so the cache-hit
   * savings the cache-marker position rests on are observable in the metering
   * trail. LANE ASYMMETRY: the anthropic messages lane reports the cache
   * components OUTSIDE input_tokens, so these are part of promptTokens (the
   * prompt side sums all three); the OpenAI chat-completions lane reports
   * cached reads INSIDE prompt_tokens (as
   * `prompt_tokens_details.cached_tokens`) and has no cache-create concept.
   *
   * W123 cached-subset split (2026-09-30, issue #290): now IMPLEMENTED for the
   * OpenAI lane — `prompt_tokens_details.cached_tokens` is recorded here as
   * `cacheReadTokens` so the deployed-lane cache reads are visible to
   * `proxy.metrics()`. The cached read stays a SUBSET of prompt_tokens, so
   * `promptTokens`/`totalTokens` are NOT re-summed (double-count guard). OpenAI
   * has no cache-create equivalent, so `cacheCreateTokens` stays at its
   * measured zero on this lane.
   */
  readonly cacheReadTokens: number;
  readonly cacheCreateTokens: number;
}

/**
 * P9 A′ (2026-09-30, issue #288): the parse-only observability journal for the
 * anthropic Messages lane (`POST /v1/messages`). The lane's outbound body is
 * parsed into a THROWAWAY record purely to read the request-side model id —
 * `outboundBody` is never reassigned, so the forwarded bytes stay
 * byte-identical to the inbound bytes (the pass-through posture is untouched:
 * no shaping, no cache markers, no budget downgrade, no replay reject). This
 * closes W111's "no model labels in the trail" gap for this lane without
 * entering transform governance — the queued P9 decision is unchanged.
 *
 * Deliberately NOT folded into `ModelUsageMetrics`: those counters are summed
 * across proxies by the pool/runtime aggregates and read byte-identically by
 * the W119 abort-tier snapshot, so adding a categorical label set there would
 * perturb consumers rather than be additive. The label set is a bounded
 * journal, the same observation-only posture as the hub's bounded gate
 * journals (`src/integrations/hub-http.ts:587`).
 */
export interface MessagesLaneLabels {
  /** Request-side model ids observed on `POST /v1/messages`, in arrival order, bounded (oldest dropped). */
  readonly models: readonly string[];
  /** Messages-lane bodies that were not a parseable JSON object (forwarded raw; counted, never rejected). */
  readonly malformedBodies: number;
}

/**
 * W181 (A5, NVIDIA adoption): the proxy's egress observation vocabulary.
 *
 * This is the wire shape the `egress-audit-mcp` ledger consumes
 * (`mcp-toolbox/apps/egress-audit-mcp/src/egress-ledger.ts`): a destination,
 * the function class reached on it, and the token class that carried it, plus
 * the anomaly-relevant facts. It is OBSERVATION ONLY — emitting one never
 * blocks, delays, or rewrites a request; the proxy's pass-through posture is
 * unchanged. `destination` is a bare hostname (never a URL, path, or query),
 * and no secret, placeholder value, or query string crosses this seam.
 *
 * The token classes are a structural copy of the ledger's closed set. They are
 * redeclared here (not imported) to respect the package boundary: `src/` must
 * not import from `mcp-toolbox/` (a separate pnpm package), so the ledger's
 * `EgressTokenClass` cannot be the shared type. The bridge
 * (`src/integrations/egress-audit-client.ts`) is the one place that maps this
 * shape onto the ledger's `AppendReachInput`, and its test pins the two
 * vocabularies together.
 */
export type EgressTokenClass = "session-placeholder" | "absent" | "foreign" | "unknown";

export interface EgressReachEvent {
  readonly kind: "reach";
  /** Bare upstream hostname the proxy forwarded to (never a path or query). */
  readonly destination: string;
  /** Bounded identity of the function reached (`chat-completions`, `messages`, `models-list`, ...). */
  readonly functionClass: string;
  readonly tokenClass: EgressTokenClass;
  /** Anomaly-relevant facts the ledger needs; values are never included, only labels. */
  readonly anomalyContext: { readonly credentialHeader: string | undefined };
}

export interface EgressRejectEvent {
  readonly kind: "reject";
  readonly destination: string;
  readonly functionClass: string;
  readonly tokenClass: EgressTokenClass;
  readonly anomalyContext: { readonly policy: string; readonly credentialHeader: string | undefined };
}

export type EgressObservation = EgressReachEvent | EgressRejectEvent;

export interface ModelUsageProxy {
  /** Loopback base URL agents use as their provider baseUrl (no path suffix). */
  readonly url: string;
  readonly metrics: () => ModelUsageMetrics;
  /** P9 A′: the parse-only request-side model-label journal for the messages lane (observability only). */
  readonly messagesLaneLabels: () => MessagesLaneLabels;
  /**
   * W181 (A5): the bounded egress observation journal — reach and reject events
   * in arrival order, oldest dropped past the bound. Observation only; a
   * snapshot copy so consumers cannot mutate the live journal.
   */
  readonly egressObservations: () => readonly EgressObservation[];
  readonly close: () => Promise<void>;
}

/**
 * The Cline connector's `providers.json` content pointing its provider at the
 * metering proxy (a Cline-specific shape; OpenCode and goose are configured by
 * their own launch config). Verified against Cline's StoredProviderSettings
 * schema: `settings.baseUrl` wins over provider defaults (explicit > apiLine >
 * default), while the env `CLINE_API_KEY` placeholder satisfies ACP
 * `isSessionReady` — the real key never enters the agent's environment or
 * config files.
 */
export function meteredProviderSettings(proxyUrl: string, providerId = "openrouter"): Record<string, unknown> {
  return {
    version: 1,
    lastUsedProvider: providerId,
    modes: {},
    providers: {
      [providerId]: {
        settings: {
          provider: providerId,
          apiKey: METERED_PLACEHOLDER_KEY,
          baseUrl: `${proxyUrl}/api/v1`,
        },
        updatedAt: new Date().toISOString(),
        tokenSource: "manual",
      },
    },
  };
}

interface MutableMetrics {
  requests: number;
  usageEvents: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latestPromptTokens: number | undefined;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface AutoLatestProxyOptions {
  /** `~...-latest` aliases to resolve into the Auto Router pool. */
  readonly aliases: readonly string[];
  /** Optional Auto Router cost band (`low`..`max`). */
  readonly costTier?: string;
  /** Model catalog URL; defaults to `<upstream>/api/v1/models`. */
  readonly modelsUrl?: string;
  /** Injectable for tests. */
  readonly fetch?: typeof fetch;
  /** Injectable for tests. */
  readonly now?: () => number;
  /** Cache lifetime for resolved aliases. */
  readonly ttlMs?: number;
  /** Backoff after a failed catalog fetch; defaults to 1 minute. */
  readonly negativeTtlMs?: number;
  /**
   * W098 c3 / issue #297: the affinity opt-in (default OFF). When enabled the
   * resolved pool is narrowed to ONE slug — the first in CONFIGURED alias
   * order (`affinityPin`) — before the `allowed_models` injection. A pin whose
   * alias does not resolve (or a fail-open resolver) is ABSENT: the pool is
   * left un-narrowed (Auto Router free-routes) and a degradation event is
   * logged. The narrowing yields to an active budget downgrade, which re-pins
   * to its target at the turn boundary.
   */
  readonly affinity?: AutoLatestAffinityOptions | undefined;
}

/**
 * Hub-owned metering proxy for model traffic. The upstream provider key lives
 * ONLY here: agents receive a placeholder key and a baseUrl pointing at this
 * proxy, which strips inbound credentials, injects the real key, and records
 * token/cost usage from responses. Chat-completion requests are rewritten to
 * ask the provider for usage accounting so usage is present even in SSE
 * streams; the anthropic Messages lane (POST /v1/messages) forwards without
 * that body seam and its usage is extracted from the anthropic shape (W123:
 * park P9 part 1). P9 A′ (issue #288) adds a parse-only, bounded request-side
 * model-label journal to that lane without shaping the forwarded body — the
 * lane stays untransformed (the transform-governance decision stays queued).
 * The proxy binds loopback only.
 */
export async function createModelUsageProxy(options: {
  readonly upstream: string;
  readonly apiKey: string;
  readonly onUsage?: (usage: Record<string, unknown>) => void;
  /**
   * W181 (A5): optional observation sink. When provided, each forwarded request
   * emits an `EgressReachEvent` (after the origin-form guard passes) and each
   * boundary rejection emits an `EgressRejectEvent`. Observation only: the
   * callback cannot block, delay, or rewrite the request — a throw is swallowed
   * and the request continues (the pass-through posture is never changed by an
   * observer). Absent leaves the proxy exactly as before.
   */
  readonly onEgressObservation?: ((observation: EgressObservation) => void) | undefined;
  /**
   * W070a: optional pure transform applied to a parsed chat-completion body
   * before forwarding. The open-source pool uses it to apply `ModelProfile`
   * request shaping at the vendor boundary. A non-object return is ignored so
   * a misbehaving transform cannot corrupt the request. Absent leaves the body
   * untouched.
   *
   * W109 (W095 c2): this option is the metering proxy's POLICY-ROUTING
   * transform point — the same seam the W095 design note names for the
   * budget-downgrade body rewrite (its third consumer, alongside the W070a
   * profile shaping and the W098 c2 cache-marker pass). Policy consumers
   * compose through `composeBodyTransforms`; the pass-through posture is
   * unchanged for unclassified traffic (absent transforms and non-record
   * returns leave the body untouched).
   */
  readonly transformBody?: ((body: Record<string, unknown>) => Record<string, unknown>) | undefined;
  /**
   * P9 option C (issue #288, 2026-09-30): optional pure transform applied to a
   * parsed anthropic Messages body (`POST /v1/messages`) before forwarding. The
   * open-source pool wires it to the W109 marker pass (`applyCacheMarkers`) so
   * the lane's STATIC HEAD (system block + last tool definition) carries
   * `cache_control` markers — markers ONLY, gated by the profile's per-family
   * opt-in, never shaping or downgrade. Absent leaves the lane byte-unchanged
   * (the A′ pass-through posture); a transform that returns its input BY
   * REFERENCE is also byte-unchanged (the body is not re-serialized, so key
   * order and whitespace survive). A non-object return is ignored.
   */
  readonly messagesTransformBody?: BodyTransform | undefined;
  /**
   * P9 option D (issue #288, 2026-09-30): when explicitly `true`, enforce the
   * anthropic Messages-schema replay integrity check on the
   * `POST /v1/messages` lane. A parsed body the check cannot safely replay
   * (an unpaired tool_use/tool_result, a stripped thinking signature) is
   * refused with a structured, named 400 BEFORE anything is forwarded; an
   * unparseable body fails closed too (it cannot be proven replay-safe). The
   * W070b sanctioned synthetic-tool-call insertion (a matched
   * tool_use/tool_result pair) stays allowed. DEFAULT `undefined` (and `false`)
   * is DARK: the lane keeps the A′ pass-through posture byte-unchanged. This is
   * a correctness control, not a transform — it never rewrites a forwarded
   * body. Its production gate is the host-body audit (the brief's option D);
   * the dark default is the recorded posture until that audit lands.
   */
  readonly messagesReplayIntegrity?: boolean | undefined;
  /**
   * W118 (the W095 budget-downgrade consumer): when set, requests whose
   * session usage has crossed the WARN fraction of the budget (any cap
   * dimension at >= fraction * cap, the same comparison budgetViolation
   * uses at the abort tier) are downgraded to the target — composed
   * BEFORE the caller's transformBody (the rewrite applies before the
   * profile-keyed shaping, the W109 ordering guidance the W118 pin
   * discriminates). Absent leaves traffic untouched (the pass-through
   * posture is the default; a downgrade is opt-in). The activation reads
   * the proxy's OWN recorded usage — per-family on the open-source lane
   * (the granularity residual: a session spreading traffic across family
   * proxies sums separately). The abort tier is untouched: the W045 guard
   * still cancels at the full cap.
   *
   * P15 part (a): the LANE decides the enforcement shape. On a concrete
   * model the body.model is rewritten to the target (the W118 stage). On
   * the Auto Router lane (the autoLatest seam composed, body.model an
   * auto-router slug) the rewrite is SKIPPED and the injected
   * `allowed_models` narrows to exactly the target instead — the router
   * keeps resolving, constrained. Narrow-before-inject: the narrowing
   * decides what the injection injects and does not consume the catalog
   * resolution (the target is operator-configured, not alias-resolved —
   * a catalog outage cannot silently un-apply an active downgrade; the
   * resolver's fail-open still governs the un-narrowed pool exactly as
   * before).
   */
  readonly budgetDowngrade?: BudgetDowngradeRuntime | undefined;
  /**
   * When set, chat completions targeting `openrouter/auto` have the resolved
   * `~...-latest` pool injected as the Auto Router `allowed_models` before
   * forwarding. Absent leaves traffic untouched.
   */
  readonly autoLatest?: AutoLatestProxyOptions | undefined;
  /**
   * W179 (NVIDIA adoption wave A2): the endpoint binding for the injected
   * credential — the SECOND gate. When present, the proxy refuses to inject
   * the real key unless the request's (host, port, path) is covered by one of
   * these endpoints, answering a `credential_endpoint_mismatch` 403 that logs
   * neither secret, nor placeholder, nor query string. Absent leaves today's
   * behavior byte-identical (gate 2 inactive); this option is the composition
   * point where the credential definition's `allowedEndpoints` is threaded in.
   */
  readonly credentialEndpoints?: readonly CredentialEndpoint[] | undefined;
  /**
   * W179: observability sink for a gate-2 refusal. Receives only value-free
   * destination facts (policy family, host, port, pathname, endpoint index) —
   * never the secret, the placeholder, or the query string. Absent means the
   * refusal is answered but not logged; the proxy itself writes no log line.
   */
  readonly onCredentialEndpointRejected?: ((event: CredentialEndpointRejection) => void) | undefined;
  /**
   * W180 (NVIDIA adoption waves A3+A4): the composed proxy payload/egress
   * policy. Absent (the default) leaves today's behavior byte-identical.
   * When supplied, the tier is fail-closed: see `ProxyPayloadPolicy`.
   */
  readonly payloadPolicy?: ProxyPayloadPolicy | undefined;
  /**
   * W180 (A3): observability sink for a path/function policy refusal.
   * Receives only value-free destination facts (host, port, method, pathname,
   * reason) — never the secret, the placeholder, the query string, or body
   * bytes. Absent means the refusal is answered but not logged.
   */
  readonly onEgressPolicyRejected?: ((event: EgressPolicyRejection) => void) | undefined;
  /**
   * W180 (A4): observability sink for a payload size-ceiling refusal.
   * Receives only the configured limit and the observed byte count. Absent
   * means the refusal is answered but not logged.
   */
  readonly onPayloadSizeRejected?: ((event: PayloadSizeRejection) => void) | undefined;
  /**
   * W182 (A7): the shared egress denial sink. When provided, every
   * proxy-boundary rejection this proxy itself emits reports one value-free
   * `EgressDenialEvent` here — gate 1 (`egress-credential`), gate 2
   * (`credential_endpoint_mismatch`), and (W184) the W180 path/function policy
   * tier (`egress_policy`). The `egress_policy` deny-by-default
   * `no_matching_rule` family is the one W182 operator-APPROVABLE family, so an
   * approval can now merge a durable revision end-to-end. Observation only: the
   * callback cannot block, delay, or rewrite the request, and a throw is
   * swallowed. Absent leaves every refusal answered exactly as before.
   */
  readonly onEgressDenied?: ((event: EgressDenialEvent) => void) | undefined;
}): Promise<ModelUsageProxy> {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new TypeError("model usage proxy requires a non-empty upstream API key");
  }
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== "https:" && upstream.hostname !== "localhost" && upstream.hostname !== "127.0.0.1") {
    throw new TypeError("model usage proxy upstream must be https (or loopback for tests)");
  }
  const metrics: MutableMetrics = { requests: 0, usageEvents: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, latestPromptTokens: undefined, cacheReadTokens: 0, cacheCreateTokens: 0 };
  // P9 A′: the messages-lane parse-only journal — request-side model ids in
  // arrival order (bounded) plus a malformed-body count. Observation only:
  // nothing here shapes or rejects the forwarded body.
  const messagesLaneModels: string[] = [];
  let malformedMessagesBodies = 0;
  // W181 (A5): the bounded egress observation journal. Every entry is a copy,
  // so neither the callback nor a reader can mutate a recorded event.
  const egressObservations: EgressObservation[] = [];
  const emitEgressObservation = (observation: EgressObservation): void => {
    const copy = copyEgressObservation(observation);
    egressObservations.push(copy);
    if (egressObservations.length > EGRESS_OBSERVATION_LIMIT) egressObservations.shift();
    try {
      options.onEgressObservation?.(copy);
    } catch {
      // Observation is advisory: a throwing sink must never change the
      // pass-through posture (the same fail-open discipline as
      // composeBodyTransforms).
    }
  };
  // W182 (A7): the shared denial emitter. The credential-gate rejections
  // (gate 1 and gate 2) and — as of W184 — the W180 path/function policy tier
  // funnel through here so an operator-approval sink attaches at one point.
  // W180's `egress_policy` deny-by-default `no_matching_rule` family is W182's
  // one operator-approvable family, so an approval can merge a durable revision
  // end-to-end. Observation only: a throwing sink is swallowed and never
  // changes the refusal posture.
  const emitEgressDenial = (event: EgressDenialEvent): void => {
    try {
      options.onEgressDenied?.(event);
    } catch {
      // Observation is advisory at this seam: a throwing sink must never
      // suppress the refusal (the pass-through/refusal posture is unchanged).
    }
  };
  const autoLatest = options.autoLatest;
  const aliasResolver: AliasResolver | undefined =
    autoLatest === undefined
      ? undefined
      : createAliasResolver({
          modelsUrl: autoLatest.modelsUrl ?? new URL("/api/v1/models", upstream).toString(),
          aliases: autoLatest.aliases,
          ...(autoLatest.fetch === undefined ? {} : { fetch: autoLatest.fetch }),
          ...(autoLatest.now === undefined ? {} : { now: autoLatest.now }),
          ...(autoLatest.ttlMs === undefined ? {} : { ttlMs: autoLatest.ttlMs }),
          ...(autoLatest.negativeTtlMs === undefined ? {} : { negativeTtlMs: autoLatest.negativeTtlMs }),
        });

  // W098 c3 / issue #297: the affinity pin. OPT-IN, default OFF; the pin is
  // per-(role, tier, settings) and restart-stable (the pure `affinityPin`),
  // and it is logged at pin/re-pin/degradation. `lastPinSlug`/`lastDegraded`
  // dedupe the log to state transitions (a pin is a session-lifetime fact, not
  // a per-request event). NEVER mid-stream: the narrowing is a composition-time
  // body choice, exactly like the role assignment it modifies.
  const affinity = autoLatest?.affinity;
  const affinityEnabled = affinity?.enabled === true;
  let lastPinSlug: string | undefined;
  let lastDegraded = false;
  const logAffinity = (event: AffinityPinEvent): void => {
    affinity?.onEvent?.(event);
  };

  // W118: the budget-downgrade stage reads the proxy's OWN recorded usage at
  // REQUEST time (this `metrics` object mutates as usage events land), so a
  // session crossing the warn fraction downgrades its subsequent requests.
  // ORDER (the W109 guidance honored): the downgrade composes BEFORE the
  // caller's transformBody — a rewrite precedes shaping so the body shapes
  // for the downgraded-TO model; a target without a pool profile passes
  // through unshaped (the order-discriminating pin asserts the original
  // model's shaping artifacts are absent on downgraded requests).
  // P15 part (a): on the Auto Router lane the stage does NOT rewrite — the
  // narrowing at the injection site below carries the downgrade, because a
  // body.model rewrite would switch the session OFF the router the
  // constraint acts through. The skip requires the autoLatest seam: without
  // it there is no plugin to narrow and the W118 rewrite stays the only
  // downgrade mechanism.
  const downgrade = options.budgetDowngrade;
  const downgradeStage = downgrade === undefined
    ? undefined
    : (body: Record<string, unknown>): Record<string, unknown> => {
        if (!budgetDowngradeActive(metrics, downgrade.budget, downgrade.fraction)) return body;
        if (aliasResolver !== undefined && isAutoRouterModel(body.model)) return body;
        return { ...body, model: downgrade.targetModel };
      };
  // Both consumers set → the downgrade composes BEFORE the caller's
  // transformBody (the rewrite applies before the profile-keyed shaping, per
  // the W109 ordering guidance); a single consumer
  // runs alone; neither stays undefined (pass-through).
  const bodyTransform =
    options.transformBody === undefined
      ? downgradeStage
      : downgradeStage === undefined
        ? options.transformBody
        : composeBodyTransforms([downgradeStage, options.transformBody]);
  // P9 option C: the messages-lane transform, applied to the parsed
  // `POST /v1/messages` body (never to chat completions). The caller gates it
  // (the pool supplies it only when a cache-marker opt-in exists); a body it
  // returns by reference is left byte-identical.
  const messagesTransform = options.messagesTransformBody;
  // P9 option D: the messages-lane replay integrity reject tier. DARK by
  // default (`undefined`/`false`); the caller must opt in explicitly.
  const messagesReplayIntegrity = options.messagesReplayIntegrity === true;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `model usage proxy upstream failure: ${error instanceof Error ? error.message : String(error)}` }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    metrics.requests += 1;
    // W052: token-bound egress at the enforced boundary. Requests may carry the
    // hub-provisioned session placeholder (or no credential at all — the proxy
    // injects the real key), but a foreign credential smuggled through
    // agent-controlled content is rejected here rather than forwarded. This is
    // enforceable only for traffic that routes through this proxy; see
    // docs/EGRESS_CAPABILITY_AUDIT.md for the bypass note.
    const credential = checkEgressCredential(req.headers);
    if (!credential.allowed) {
      // W181 (A5): the reject is observed with the destination, a path-derived
      // function class, and the foreign token class. No credential value,
      // placeholder, or query string is recorded — only the header NAME.
      emitEgressObservation({
        kind: "reject",
        destination: upstream.hostname,
        functionClass: classifyEgressFunctionClass(req.method, req.url),
        tokenClass: credential.kind === "foreign" ? "foreign" : "unknown",
        anomalyContext: { policy: "egress-credential", credentialHeader: credential.header },
      });
      // W182 (A7): emit the shared value-free denial event so an operator
      // sink can park a pending rule. A foreign credential is credential
      // custody, not an approvable egress rule — the sink itself decides that
      // (`isApprovableEgressDenial`), this seam only reports the facts. The
      // destination is the proxy's own upstream (a single-origin proxy), never
      // an attacker-supplied absolute-form host; only the request path is read.
      const denialPath = new URL(req.url ?? "/", upstream).pathname;
      emitEgressDenial({
        policy: "egress-credential",
        reason: "foreign-credential",
        host: upstream.hostname,
        port: upstream.port === "" ? (upstream.protocol === "https:" ? 443 : 80) : Number(upstream.port),
        method: req.method,
        pathname: denialPath,
      });
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: `model usage proxy rejected a non-session credential in ${credential.header ?? "request headers"}`,
        policy: "egress-credential",
      }));
      return;
    }
    // P1: reject absolute-form request-targets — RFC 7230 allows
    // `GET http://attacker/...` which would make new URL(absolute, base)
    // ignore the upstream and exfiltrate the injected Bearer key. The target
    // is resolved once here and reused by the W180 gate and the injection gate
    // below; this guard runs BEFORE the W180 policy gate so a policy is only
    // ever consulted for a same-origin request (an absolute-form target is
    // answered 400 exactly as before, with or without a policy).
    const target = new URL(req.url ?? "/", upstream);
    if (target.origin !== upstream.origin) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "model usage proxy only forwards origin-form request targets" }));
      return;
    }
    // W180 (NVIDIA adoption waves A3+A4): the payload/egress policy gate,
    // inserted in the gate order AFTER gate 1 (`checkEgressCredential`) and
    // BEFORE the lane parse, the body transforms, the credential-injection
    // gate, and forwarding. This ordering is the A4 invariant pinned by test
    // (`test/model-usage-proxy.test.ts#"W180 A4: the policy/body-transform
    // seam runs before credential injection and never observes the resolved
    // key"`): a body transform or policy stage can never observe the resolved
    // upstream key because injection happens strictly later.
    //
    // Both tiers are DARK by default (`options.payloadPolicy` absent): absent
    // the gate is skipped entirely and today's behavior is byte-identical.
    if (options.payloadPolicy !== undefined) {
      // A3: the path/function allowlist through W178's shared decision. The
      // tier's deny-by-default composition lives in `applyEgressPolicyTier`.
      // The port used for the L4 match is the ORIGIN port (443/80 for a
      // scheme-default target), matching the credential-endpoint gate.
      const port = target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port);
      const policy = options.payloadPolicy.egressPolicy;
      if (policy !== undefined) {
        const request: EgressRequest = {
          host: target.hostname,
          port,
          ...(req.method === undefined ? {} : { method: req.method }),
          path: target.pathname,
        };
        const tier = applyEgressPolicyTier(request, policy);
        if (!tier.allowed) {
          const rejection = egressPolicyRejection(request, tier.decision);
          options.onEgressPolicyRejected?.(rejection);
          // W184: route the policy denial through the SHARED denial event too.
          // W182's store can only park an operator-APPROVABLE rule from this
          // seam; the W180 tier's deny-by-default `no_matching_rule` is exactly
          // its one approvable family, so an approval can now merge a durable
          // revision end-to-end (the back-compat `onEgressPolicyRejected` sink
          // still fires). Value-free: destination facts + the reason only, never
          // a header, secret, placeholder, or query (pathname is query-free here).
          emitEgressDenial({
            policy: rejection.policy,
            reason: rejection.reason,
            host: rejection.host,
            port: rejection.port,
            method: rejection.method,
            pathname: rejection.pathname,
          });
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({
            error: `model usage proxy rejected a request outside the egress policy's allowed function set (${rejection.reason})`,
            policy: rejection.policy,
          }));
          return;
        }
      }
    }
    const inbound = await readAll(req);
    if (options.payloadPolicy?.maxRequestBodyBytes !== undefined && inbound.length > options.payloadPolicy.maxRequestBodyBytes) {
      // A4: the size-ceiling stage (C3 payload-policy extension point). It
      // runs BEFORE any body transform, credential injection, or forwarding;
      // the refusal carries only byte counts. Fail closed: a supplied `0`
      // refuses every non-empty body.
      const rejection: PayloadSizeRejection = {
        policy: "payload_too_large",
        limitBytes: options.payloadPolicy.maxRequestBodyBytes,
        observedBytes: inbound.length,
      };
      options.onPayloadSizeRejected?.(rejection);
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: `model usage proxy refused a request body over the configured size ceiling (${rejection.observedBytes} > ${rejection.limitBytes} bytes)`,
        policy: rejection.policy,
      }));
      return;
    }
    const isCompletions = req.method === "POST" && typeof req.url === "string" && /\/chat\/completions$/.test(req.url);
    const isMessages = req.method === "POST" && typeof req.url === "string" && /\/v1\/messages$/.test(req.url);
    let outboundBody = inbound;
    // P9 A′ (issue #288): the messages lane's parse-only observability capture.
    // The body is parsed into a THROWAWAY record to read the request-side model
    // id into the bounded journal and to count malformed bodies. On its own
    // `outboundBody` would stay untouched (byte-identical forwarded bytes), but
    // P9 option C layers the caller-supplied `messagesTransformBody` on top:
    // the parsed record is handed to the markers-only stage, and the body is
    // re-serialized ONLY when that stage returns a DIFFERENT object — a stage
    // that returns its input by reference (the dark family / opt-in-off case)
    // leaves the bytes byte-identical. This is never shaping, downgrade, a
    // replay gate, or a `usage.include` injection. Parse failure increments the
    // malformed-body counter instead of 400ing (the chat-completions lane's
    // 400 posture is NOT adopted here), keeping the lane pass-through even on a
    // body the vendor must judge — and the transform is never invoked on an
    // unparseable body. A ZERO-LENGTH body is not parseable JSON, so it is
    // counted too (the P9a review's zero-length blind spot): the capture is
    // NOT guarded by `inbound.length > 0`, unlike the completions branch,
    // because the counter's contract is "bodies that were not a parseable JSON
    // object". The empty bytes still forward raw and never invoke the seam.
    if (isMessages) {
      let parsedMessages: unknown;
      try {
        parsedMessages = JSON.parse(inbound.toString("utf8"));
      } catch {
        parsedMessages = undefined;
      }
      if (!isRecord(parsedMessages)) {
        malformedMessagesBodies += 1;
        // P9 option D: under the integrity opt-in an unparseable body cannot be
        // proven replay-safe, so it fails closed instead of forwarding raw.
        if (messagesReplayIntegrity) {
          const refusal = unparseableMessagesBodyRejection();
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: refusal.reason, policy: refusal.policy, violations: refusal.violations }));
          return;
        }
      } else {
        // P9 option D: the messages-lane replay integrity reject tier (dark by
        // default). A parsed body the check cannot safely replay is refused
        // before any transform or forward — the W070b sanctioned synthetic
        // insertion (a matched tool_use/tool_result pair) is allowed.
        if (messagesReplayIntegrity) {
          const decision = enforceMessagesReplayIntegrity(parsedMessages);
          if (decision.action === "reject") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: decision.reason, policy: decision.policy, violations: decision.violations }));
            return;
          }
        }
        if (typeof parsedMessages.model === "string" && parsedMessages.model.length > 0) {
          messagesLaneModels.push(parsedMessages.model);
          if (messagesLaneModels.length > MESSAGES_LANE_LABEL_LIMIT) messagesLaneModels.shift();
        }
        if (messagesTransform !== undefined) {
          const transformed = messagesTransform(parsedMessages);
          if (transformed !== parsedMessages && isRecord(transformed)) {
            outboundBody = Buffer.from(JSON.stringify(transformed), "utf8");
          }
        }
      }
    }
    if (isCompletions && inbound.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(inbound.toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "model usage proxy received malformed JSON chat completion body" }));
        return;
      }
      if (!isRecord(parsed)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "model usage proxy received non-object chat completion body" }));
        return;
      }
      // W070b slice 1: enforce the model's assistant-message replay policy at
      // the wire boundary. K3 is rejected on a stripped replay; DeepSeek
      // synthesized tool-call turns are diverted to the Anthropic path. This
      // is harness correctness — it rejects malformed replays, it does not
      // guarantee model behavior. W123 compatibility record: the anthropic-
      // messages transport this policy sanctions (route-anthropic) is NOT
      // gated here — its Messages-schema integrity check (tool_use /
      // thinking-signature replay) is the queued successor decision; the
      // W123 metering slice is type-keyed and replay-agnostic.
      const replay = enforceReplayPolicy(parsed);
      if (replay.action === "reject") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: replay.reason, policy: replay.policy.family, violations: replay.violations }));
        return;
      }
      if (replay.action === "route-anthropic") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: replay.reason, policy: replay.policy.family, violations: replay.violations }));
        return;
      }
      // Hub-owned Auto Router pool: resolve `~...-latest` aliases to concrete
      // slugs and inject them so the router's `allowed_models` (which does not
      // understand aliases) actually has candidates. Fail open on resolution
      // failure so traffic is never blocked by a catalog hiccup.
      // P15 part (a): an active downgrade NARROWS the injected pool to the
      // target BEFORE the injection — the same applyAutoRouterPlugin call
      // with one candidate, and the resolution is not consulted for the
      // narrowed request (the target is operator-configured, not
      // catalog-resolved, so a catalog outage cannot silently un-apply the
      // downgrade; the fail-open resolve still governs the un-narrowed pool
      // exactly as before). Narrow-before-inject: the injected list IS the
      // narrowed list — no post-injection patch.
      // W098 c3 / issue #297 (precedence context): affinity is a narrowing
      // WITHIN key 1 that binds BEFORE the other routing keys act and yields to
      // them — budget (key 2) re-pins it, schedule (key 3) composes an off-peak
      // pool's own pin, failover (key 4) is the yield-to case and is NOT wired
      // today. The narrowing therefore REMOVES OpenRouter's own cross-vendor
      // reroute for the session: a pinned vendor's outage persists to the turn
      // boundary (with no wired failover, potentially the session) — the
      // recorded outage-persistence cost (spec §4/§5). The open-source-pool lane
      // needs NO work (one family per proxy, one composed model per launch): it
      // is already maximally pinned, and the topology-daemon surface wires no
      // autoLatest option — this spec's coverage is the OpenRouter-lane proxies.
      let routed = parsed;
      if (aliasResolver !== undefined && isAutoRouterModel(parsed.model)) {
        const downgradeActive = downgrade !== undefined && budgetDowngradeActive(metrics, downgrade.budget, downgrade.fraction);
        let allowedModels: readonly string[];
        if (downgradeActive && downgrade !== undefined) {
          // Key 2 yields the pin: the active downgrade re-pins to its target at
          // the turn boundary (a logged re-pin), and the affinity pin never
          // overrides budget. Narrow-before-inject / resolver-independent, so
          // a catalog outage cannot un-apply the downgrade.
          allowedModels = [downgrade.targetModel];
          if (affinityEnabled && downgrade.targetModel !== lastPinSlug) {
            logAffinity({ event: "re-pin", role: affinity?.role, tier: affinity?.tier, alias: undefined, slug: downgrade.targetModel, reason: "budget-downgrade" });
            lastPinSlug = downgrade.targetModel;
            lastDegraded = false;
          }
        } else if (affinityEnabled) {
          const pairs = await aliasResolver.resolvePairs();
          const pinAlias = affinityPin(affinity?.role, affinity?.tier, autoLatest?.aliases ?? []);
          const pinnedSlug = pinAlias === undefined ? undefined : pairs.find((entry) => entry.alias === pinAlias)?.slug;
          if (pinnedSlug === undefined) {
            // DEGRADED-RESOLVER: the pin is ABSENT. Do NOT narrow to a later
            // alias — the pin follows CONFIGURED order, not resolved order — so
            // Auto Router free-routes over whatever resolved (or nothing on a
            // fail-open resolver), logged once as a degradation event.
            if (!lastDegraded) {
              logAffinity({
                event: "degraded",
                role: affinity?.role,
                tier: affinity?.tier,
                alias: pinAlias,
                slug: undefined,
                reason: pairs.length === 0 ? "resolver-fail-open" : "pin-alias-unresolvable",
              });
              lastDegraded = true;
              lastPinSlug = undefined;
            }
            allowedModels = pairs.map((entry) => entry.slug);
          } else {
            lastDegraded = false;
            if (pinnedSlug !== lastPinSlug) {
              logAffinity({ event: "pin", role: affinity?.role, tier: affinity?.tier, alias: pinAlias, slug: pinnedSlug, reason: undefined });
              lastPinSlug = pinnedSlug;
            }
            allowedModels = narrowToAffinityPin(pairs.map((entry) => entry.slug), pinnedSlug);
          }
        } else {
          allowedModels = await aliasResolver.resolve();
        }
        if (allowedModels.length > 0) {
          routed = applyAutoRouterPlugin(parsed, parsed.model, allowedModels, autoLatest?.costTier);
        }
      }
      if (bodyTransform !== undefined) {
        const shaped = bodyTransform(routed);
        if (isRecord(shaped)) routed = shaped;
      }
      const existing = isRecord(routed.usage) ? routed.usage : {};
      // Ask the provider for usage accounting so usage arrives even in streams.
      outboundBody = Buffer.from(JSON.stringify({ ...routed, usage: { ...existing, include: true } }), "utf8");
    }

    // W179 (NVIDIA adoption wave A2): the SECOND credential gate, at the
    // header-injection point. Gate 1 (above) proved the request carried no
    // foreign credential; this gate proves the credential BINDING covers the
    // destination before the real key is injected. Both must pass — a valid
    // placeholder with an out-of-binding destination is refused here. The
    // decision reads only `target.pathname`, `target.hostname`, and the
    // resolved port; the query string and request headers never enter it, and
    // the refusal body/event carry neither secret nor placeholder nor query.
    if (options.credentialEndpoints !== undefined) {
      const port = target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port);
      const endpointDecision = checkCredentialEndpoint(
        { host: target.hostname, port, path: target.pathname },
        options.credentialEndpoints,
      );
      if (!endpointDecision.allowed) {
        const rejection: CredentialEndpointRejection = {
          policy: "credential_endpoint_mismatch",
          host: target.hostname,
          port,
          pathname: target.pathname,
        };
        // W181 (A5): observe the gate-2 refusal too, so the ledger sees every
        // proxy-boundary rejection. Value-free: destination, a path-derived
        // function class, the policy family, and the credential header NAME
        // only (here undefined) — never a secret, placeholder, or query.
        emitEgressObservation({
          kind: "reject",
          destination: target.hostname,
          functionClass: classifyEgressFunctionClass(req.method, req.url),
          tokenClass: credential.kind === "session-placeholder" ? "session-placeholder" : "absent",
          anomalyContext: { policy: rejection.policy, credentialHeader: undefined },
        });
        options.onCredentialEndpointRejected?.(rejection);
        // W182 (A7): the same shared value-free denial event. This gate's
        // reason is recorded as the policy family so a sink can classify it
        // non-approvable (a credential-custody refusal, never loosened by an
        // egress rule).
        emitEgressDenial({
          policy: rejection.policy,
          reason: "destination-outside-credential-binding",
          host: rejection.host,
          port: rejection.port,
          method: req.method,
          pathname: rejection.pathname,
        });
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: "model usage proxy refused to inject the credential: request destination is outside the credential endpoint binding",
          policy: rejection.policy,
        }));
        return;
      }
    }
    // W181 (A5): observe the forwarded reach AFTER every gate has passed, so a
    // request refused by gate 2 is never miscounted as a reach. The destination
    // is the validated upstream hostname (bare, no path/query/port); the
    // function class is path-derived; the token class is the one the credential
    // gate decided. No credential value, placeholder, or query string is ever
    // included.
    emitEgressObservation({
      kind: "reach",
      destination: target.hostname,
      functionClass: classifyEgressFunctionClass(req.method, req.url),
      tokenClass: credential.kind === "session-placeholder" ? "session-placeholder" : "absent",
      anomalyContext: { credentialHeader: undefined },
    });
    const response = await fetch(target, {
      method: req.method ?? "GET",
      headers: scrubRequestHeaders(req.headers, options.apiKey, outboundBody.length),
      body: req.method === "GET" || req.method === "HEAD" ? null : new Uint8Array(outboundBody),
      redirect: "manual",
      signal: AbortSignal.timeout(300_000),
    });

    const contentType = response.headers.get("content-type") ?? "";
    res.writeHead(response.status, forwardedResponseHeaders(response, contentType));
    if (contentType.includes("text/event-stream") && response.body !== null) {
      // W123: the anthropic Messages stream's usage events are CUMULATIVE,
      // never deltas — message_start carries the prompt side (message.usage)
      // and message_delta re-carries the totals (usage; the SDK types mark
      // them "cumulative — not a delta!", and summing across events
      // double-counts — the recorded cautionary instance is langchainjs
      // #10249). The per-request pending record takes the LAST-OBSERVED value
      // per field and emits ONE usage event per message at stream end, so the
      // lane's event count matches the JSON lane's.
      let anthropicPending: Record<string, number> | undefined;
      const recordSseLine = (line: string): void => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (data.length === 0 || data === "[DONE]") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return; // Non-JSON SSE chunk; ignore for metering.
        }
        if (!isRecord(parsed)) return;
        if (parsed.type === "message_start" || parsed.type === "message_delta") {
          const usage = parsed.type === "message_start"
            ? (isRecord(parsed.message) && isRecord(parsed.message.usage) ? parsed.message.usage : undefined)
            : (isRecord(parsed.usage) ? parsed.usage : undefined);
          if (usage !== undefined) anthropicPending = { ...anthropicPending, ...anthropicUsageNumbers(usage) };
          return;
        }
        recordUsage(parsed);
      };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value !== undefined && value.length > 0) {
          res.write(Buffer.from(value));
          buffered += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, index).trim();
            buffered = buffered.slice(index + 1);
            recordSseLine(line);
          }
        }
      }
      recordSseLine(buffered.trim());
      if (anthropicPending !== undefined) recordAnthropicUsage(anthropicPending);
      res.end();
      return;
    }
    const text = await response.text();
    recordJsonUsage(text);
    res.end(text);
  }

  function recordJsonUsage(text: string): void {
    try {
      recordUsage(JSON.parse(text));
    } catch {
      // Non-JSON body; nothing to meter.
    }
  }

  function recordUsage(payload: unknown): void {
    if (!isRecord(payload)) return;
    // W123: the anthropic Messages JSON lane — a message response carries
    // `type: "message"` and the anthropic usage shape (input_tokens /
    // output_tokens / cache_*_input_tokens — no OpenAI prompt_tokens /
    // completion_tokens / total_tokens / cost keys), so the pre-W123 OpenAI
    // extraction recorded every anthropic event as usageEvents += 1 with ZERO
    // tokens (park P9: the trail was polluted, not absent). The detection keys
    // on the wire type the chat-completions lane never carries, so it cannot
    // misclassify; an unrecognized usage shape keeps the as-found behavior
    // (usageEvents += 1 with zeros — frozen by the W123 hold-out).
    if (payload.type === "message" && isRecord(payload.usage)) {
      recordAnthropicUsage(payload.usage);
      return;
    }
    const usage = payload.usage;
    if (!isRecord(usage)) return;
    metrics.usageEvents += 1;
    metrics.promptTokens += numberOrZero(usage.prompt_tokens);
    metrics.completionTokens += numberOrZero(usage.completion_tokens);
    metrics.totalTokens += numberOrZero(usage.total_tokens);
    metrics.costUsd += numberOrZero(usage.cost);
    // W123 cached-subset split (2026-09-30, issue #290): the OpenAI
    // chat-completions lane reports cached prompt reads as a SUBSET of
    // prompt_tokens under `prompt_tokens_details.cached_tokens`. Record that
    // subset as cacheReadTokens first-class so the deployed-lane cache reads
    // are observable — promptTokens/totalTokens are deliberately NOT changed
    // (the read is already inside prompt_tokens; summing it again would
    // double-count). See `openAiCacheReadTokens` for the shape + guard.
    metrics.cacheReadTokens += openAiCacheReadTokens(usage);
    if (typeof usage.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens)) {
      metrics.latestPromptTokens = usage.prompt_tokens;
    }
    options.onUsage?.(usage);
  }

  // W123: the anthropic usage normalizer — the P9 extraction correction.
  // Shape (recorded): the non-stream message response carries
  // usage { input_tokens, output_tokens, cache_creation_input_tokens,
  // cache_read_input_tokens }; the stream splits it across message_start
  // (message.usage) and message_delta (usage), CUMULATIVE — see the SSE
  // branch's per-request accumulator. NORMALIZATION (the judgment on the
  // page): anthropic reports the cache components OUTSIDE input_tokens while
  // OpenAI's prompt_tokens INCLUDES cached reads, so the prompt side sums all
  // three — the W045/W118 budget caps and the metering trail mean the same
  // thing on both lanes (and the abort tier, aggregated across lanes since
  // W119, now sees the anthropic lane's real token mass). COST boundary: the
  // anthropic usage carries no cost field — costUsd stays the OpenRouter
  // lane's usage.cost; the anthropic lane's local cost is unmeasured (bounded
  // server-side by the OpenRouter per-key credit limit, the session-budget
  // backstop). TRANSFORM boundary: the messages lane forwards untouched (no
  // body seam, no shaping/markers/downgrade) — the governance half of park P9
  // stands, decision-first. REPLAY compatibility record: enforceReplayPolicy
  // stays chat-completions-scoped (the isCompletions branch below); the
  // anthropic-messages transport is W070b's sanctioned synthetic-tool-call
  // path and remains replay-ungated — the Messages-schema integrity check
  // (tool_use / thinking-signature replay) is the queued successor decision.
  function recordAnthropicUsage(usage: Record<string, unknown>): void {
    const inputTokens = numberOrZero(usage.input_tokens);
    const cacheCreation = numberOrZero(usage.cache_creation_input_tokens);
    const cacheRead = numberOrZero(usage.cache_read_input_tokens);
    const outputTokens = numberOrZero(usage.output_tokens);
    const promptSide = inputTokens + cacheCreation + cacheRead;
    metrics.usageEvents += 1;
    metrics.promptTokens += promptSide;
    metrics.completionTokens += outputTokens;
    metrics.totalTokens += promptSide + outputTokens;
    // P12: the cache components enter the metrics sums first-class — the
    // cache-hit savings are observable in the trail, never re-derived from
    // the wire (these are the same numbers folded into promptSide above).
    metrics.cacheCreateTokens += cacheCreation;
    metrics.cacheReadTokens += cacheRead;
    if (typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)) {
      metrics.latestPromptTokens = promptSide;
    }
    // The raw fields ride onUsage untouched — P12's seam (the model now
    // carries the cache fields first-class, above; the raw wire record still
    // rides for consumers that need the exact shape).
    options.onUsage?.({ ...usage });
  }

  // Warm the alias cache so the first Auto Router request does not wait on the
  // catalog fetch. Fire-and-forget: failure is handled inside the resolver.
  if (aliasResolver !== undefined) void aliasResolver.resolve();

  const started = await new Promise<AddressInfo>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectServer(new Error("model usage proxy failed to bind"));
        return;
      }
      resolveServer(address);
    });
  });

  return {
    url: `http://127.0.0.1:${started.port}`,
    metrics: () => ({ ...metrics }),
    // P9 A′: a snapshot copy so consumers cannot mutate the live journal.
    messagesLaneLabels: () => ({ models: [...messagesLaneModels], malformedBodies: malformedMessagesBodies }),
    // W181 (A5): a snapshot copy of the bounded egress observation journal.
    egressObservations: () => egressObservations.map(copyEgressObservation),
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

// RFC 7230 §6.1 hop-by-hop headers are connection-scoped and must never be
// forwarded; `authorization` is replaced with the real key, `content-length`
// is recomputed for the rewritten body, and `accept-encoding` is forced to
// identity so SSE/JSON bodies stay parseable for metering.
const HOP_BY_HOP_HEADERS = new Set([
  "authorization",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
]);

function scrubRequestHeaders(headers: http.IncomingHttpHeaders, apiKey: string, contentLength: number): Record<string, string> {
  // The Connection header may additionally name sender-specific hop-by-hop
  // headers; those must be stripped too.
  const connectionTokens = new Set<string>();
  const connectionValue = headers.connection;
  for (const entry of Array.isArray(connectionValue) ? connectionValue : [connectionValue]) {
    if (typeof entry !== "string") continue;
    for (const token of entry.split(",")) {
      const trimmed = token.trim().toLowerCase();
      if (trimmed.length > 0) connectionTokens.add(trimmed);
    }
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) continue;
    result[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  result.authorization = `Bearer ${apiKey}`;
  result["content-length"] = String(contentLength);
  // Identity keeps SSE/JSON bodies parseable for metering.
  result["accept-encoding"] = "identity";
  return result;
}

// End-to-end upstream headers worth surfacing to the agent so provider
// signaling (retries, rate limits, redirects) survives the passthrough.
const FORWARDED_RESPONSE_HEADERS = ["content-type", "retry-after", "location"];

function forwardedResponseHeaders(response: Response, contentType: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null && value.length > 0) result[name] = value;
  }
  for (const [name, value] of response.headers.entries()) {
    if (name.startsWith("x-ratelimit-")) result[name] = value;
  }
  result["content-type"] = contentType || "application/octet-stream";
  return result;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * W123 cached-subset split (2026-09-30, issue #290): extract the OpenAI
 * chat-completions cached prompt read — `prompt_tokens_details.cached_tokens`.
 * The value is a SUBSET of `prompt_tokens`, so the caller records it as
 * `cacheReadTokens` and leaves the prompt/total sums alone.
 *
 * Guards: absent detail, a non-record detail, or a non-number / non-finite /
 * negative `cached_tokens` yields a measured zero (never NaN). The
 * anthropic-shaped `cache_read_input_tokens` (or a bare top-level
 * `cached_tokens`) is deliberately NOT read here — the type-keyed anthropic
 * detection (`recordAnthropicUsage`) owns that shape, so a malformed payload
 * carrying BOTH shapes can only add the read once (the double-count guard).
 * OpenAI has no cache-create concept, so there is no companion field.
 */
function openAiCacheReadTokens(usage: Record<string, unknown>): number {
  const details = usage.prompt_tokens_details;
  if (!isRecord(details)) return 0;
  const cached = details.cached_tokens;
  return typeof cached === "number" && Number.isFinite(cached) && cached >= 0 ? cached : 0;
}

/** W123: the recognized numeric fields of the anthropic Messages usage shape
 * (the wire contract: input_tokens, output_tokens, and the cache components
 * cache_creation_input_tokens / cache_read_input_tokens — confirmed
 * cumulative across message_start/message_delta on the stream). Vendor
 * extras ride onUsage raw and never enter the metrics sums; the cache
 * components stopped being "extras" in P12 — they meter first-class
 * (recordAnthropicUsage), everything else stays raw-only. */
function anthropicUsageNumbers(usage: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const field of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
    const value = usage[field];
    if (typeof value === "number" && Number.isFinite(value)) result[field] = value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAll(stream: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolveRead, rejectRead) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolveRead(Buffer.concat(chunks)));
    stream.on("error", rejectRead);
  });
}

/**
 * W180 (A3): the path/function allowlist tier's composition over W178's
 * shared `decideEgress`.
 *
 * The tier does NOT reimplement policy logic: it asks the one pure decision
 * and then applies the deny-by-default posture the proxy issue requires. W178's
 * `decideEgress` deliberately reports `no_matching_rule` as allowed-but-reported
 * — that is the honest core contract and is left untouched (the W178 review
 * P2). The PROXY tier, once an `EgressPolicy` is supplied, promotes exactly
 * that case to a denial, because a supplied policy that names no rule for the
 * destination must not silently re-open the function-broad grant:
 *
 *   - `rule_matched`            → allow (an explicit grant; `audit` mode still
 *     forwards because the rule granted the function);
 *   - `audit_only`              → allow (the endpoint's declared posture is
 *     `audit` — W178's documented observe-and-forward; the tier does not
 *     silently convert an audit posture into enforcement);
 *   - `denied_by_enforce_rule`  → deny (the core's own enforce deny);
 *   - `no_matching_rule`        → deny (deny-by-default for a supplied policy).
 *
 * Equivalent formulation: allow iff the core allows AND the reason is not
 * `no_matching_rule`. This is the precise composition the issue names: the core
 * decides per-endpoint posture, the tier only closes the no-rule case.
 * Absent a supplied policy the caller never invokes this function, so today's
 * behavior stays byte-identical.
 */
export function applyEgressPolicyTier(
  request: EgressRequest,
  policy: EgressPolicy,
): { readonly allowed: boolean; readonly decision: EgressDecision } {
  const decision = decideEgress(request, policy);
  if (decision.allowed && decision.reason !== "no_matching_rule") {
    return { allowed: true, decision };
  }
  return { allowed: false, decision };
}

/** W180: the value-free rejection facts derived from a tier decision. */
export function egressPolicyRejection(
  request: EgressRequest,
  decision: EgressDecision,
): EgressPolicyRejection {
  return {
    policy: "egress_policy",
    host: request.host,
    port: request.port,
    method: request.method,
    pathname: request.path ?? "/",
    reason: decision.reason,
  };
}
