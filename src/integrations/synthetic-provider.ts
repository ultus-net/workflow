/**
 * Synthetic (api.synthetic.new) as the PRIMARY metered upstream, with
 * OpenRouter as the automatic failover lane.
 *
 * WHY THIS EXISTS
 * ---------------
 * The hub routes every agent's model traffic through the loopback metering
 * proxy (`model-usage-proxy.ts`). Historically that proxy held ONE upstream
 * (OpenRouter) and one key. The operator pivot makes Synthetic the primary
 * provider and OpenRouter the fallback when Synthetic is rate limited:
 *
 *   request -> synthetic (primary)  --429/5xx/connection-->  openrouter/auto
 *
 * Synthetic is OpenAI-compatible (`POST https://api.synthetic.new/v1/...`,
 * `Authorization: Bearer $SYNTHETIC_API_KEY`) and names models with its own
 * `syn:` / `hf:` aliases, so a fallback cannot forward the Synthetic model id
 * to OpenRouter. Per the operator decision the fallback always re-pins the
 * model to `openrouter/auto` — a deterministic, always-resolving target
 * rather than an inferred per-alias mapping.
 *
 * This module is PURE (no IO): it owns the lane facts (hosts, upstreams, key
 * env/file names), the config composition, and the failover decision, so the
 * policy is unit-testable without a network. `model-usage-proxy.ts` consumes
 * it at its existing policy-routing seam.
 *
 * POSTURE / HONESTY
 * -----------------
 * The failover is best-effort, NOT a guarantee: it fires only on a
 * failure-class response BEFORE the first response byte. A Synthetic stream
 * that fails mid-stream surfaces as an error (the recorded SSE limitation the
 * routing policy already carries for key-4 failover). It never switches lanes
 * mid-stream.
 *
 * LANDING POSTURE (operator direction: "enable by default immediately")
 * ---------------------------------------------------------------
 * The pair is ACTIVE BY DEFAULT whenever a Synthetic key is resolvable
 * (`SYNTHETIC_API_KEY` env, then `synthetic.key` in the OpenCode auth store,
 * then `~/.config/workflow/synthetic-api-key`). With no resolvable
 * Synthetic key the proxy keeps today's single-upstream OpenRouter behavior
 * byte-for-byte, so a keyless checkout does not fail. The OpenRouter failover
 * upstream reuses the existing upstream key (canonical `WORKFLOW_UPSTREAM_KEY`
 * / `~/.config/workflow/upstream-key`, or the OpenCode auth store), and is a
 * runtime PREREQUISITE: the loaders throw without it, so a Synthetic-only
 * deployment is not reachable through the current callers. Set
 * `WORKFLOW_SYNTHETIC=0` to disable the pair explicitly.
 *
 * KNOWN INTERACTIONS (stated, not hidden):
 *  - Budget downgrade (`WORKFLOW_BUDGET_DOWNGRADE_MODEL`) rewrites `body.model`
 *    to its target on the Synthetic lane too; the operator must set a
 *    Synthetic target there (the default target is an OpenRouter slug, which
 *    Synthetic rejects without failover).
 *  - The primary-hop model mapping only rewrites the `openrouter/auto`
 *    default; any other model id passes through to Synthetic unchanged.
 */

export const SYNTHETIC_HOST = "api.synthetic.new";
export const SYNTHETIC_UPSTREAM = `https://${SYNTHETIC_HOST}`;

/**
 * Synthetic's OpenAI-compatible model catalog. The reference
 * `opencode-auto-router` plugin discovers the `syn:*` aliases from this exact
 * endpoint (the aliases are absent from the public models.dev catalog), so the
 * Workflow control plane can resolve the same aliases operator-side rather
 * than hard-coding them.
 */
export const SYNTHETIC_MODELS_URL = `${SYNTHETIC_UPSTREAM}/openai/v1/models`;

export const OPENROUTER_UPSTREAM = "https://openrouter.ai";

/** Synthetic's OpenAI-compatible chat-completions host set. */
const SYNTHETIC_HOSTS = new Set([SYNTHETIC_HOST]);

/** Env var carrying the Synthetic upstream key (canonical). */
export const SYNTHETIC_KEY_ENV = "SYNTHETIC_API_KEY";
/** Key file under `~/.config/workflow/` carrying the Synthetic upstream key. */
export const SYNTHETIC_KEY_FILE = "synthetic-api-key";

/** The `WORKFLOW_SYNTHETIC` env toggle; DEFAULT ON (absent means enabled). */
export const SYNTHETIC_TOGGLE_ENV = "WORKFLOW_SYNTHETIC";

/**
 * The Synthetic model the hub maps the agent's default `openrouter/auto`
 * requests to on the primary hop. Aligned with the reference
 * `opencode-auto-router` plugin's `primaryModel` default (the screenshot's
 * "Large text model" row).
 *
 * The plugin registers a friendly router alias `syn:auto` that remaps via the
 * model's `modelID` to this concrete alias upstream; the Workflow proxy
 * achieves the same effect without a client plugin by rewriting the composed
 * `openrouter/auto` default to this id. The agent config keeps
 * `openrouter/auto` (a picker-valid built-in catalog id on v1 and v2), so the
 * v2 ACP model pin is untouched. An explicit operator
 * `WORKFLOW_OPENCODE_MODEL` that is not an auto-router slug passes through
 * unchanged.
 */
export const SYNTHETIC_DEFAULT_MODEL = "syn:large:text";

/**
 * The permanent Synthetic `syn:*` category aliases, per Synthetic's Supported
 * Models table. They always point at the current best model per category, so
 * nothing is pinned by hand — the same posture as the OpenRouter
 * `~<lab>/<model>-latest` aliases.
 */
export const SYNTHETIC_ALIASES: Readonly<Record<string, string>> = {
  "syn:large:text": "Large text model",
  "syn:small:text": "Small text model",
  "syn:large:vision": "Large vision model",
  "syn:small:vision": "Small vision model",
};

/**
 * The role -> alias routing the reference plugin applies at the agent level.
 * OpenCode V2 exposes no per-request model hook (every request hook carries
 * `readonly model`), so routing is coarse, by agent. Workflow's control plane
 * composes one model per launch today; this table documents the intended
 * role->pool mapping and is the alignment target for a future role->model
 * settings axis (W095 key-1). Exported for that follow-up and for tests.
 */
export const SYNTHETIC_AGENT_ROUTES: readonly { readonly match: string; readonly model: string }[] = [
  { match: "vision|image|screenshot|ocr|multimodal", model: "syn:large:vision" },
  { match: "explore|search|grep|read|title|summar|compact|quick|small|fast", model: "syn:small:text" },
  { match: "build|code|coder|edit|implement|plan|review|debug|refactor|general|test", model: "syn:large:text" },
];

const DISABLED_TOGGLES = new Set(["0", "false", "off", "disabled", "no"]);
const ENABLED_TOGGLES = new Set(["1", "true", "on", "enabled", "yes"]);

/** True when `upstream` is a Synthetic host. */
export function isSyntheticUpstream(upstream: string): boolean {
  try {
    return SYNTHETIC_HOSTS.has(new URL(upstream).hostname);
  } catch {
    return false;
  }
}

/**
 * The single fallback model OpenRouter receives on failover. The operator
 * chose a fixed `openrouter/auto` (deterministic, always-resolving) rather
 * than a per-alias map, so a Synthetic id never has to be translated or
 * guessed.
 *
 * The wire id OpenRouter expects is `openrouter/auto` VERBATIM — confirmed
 * both by the reference `opencode-auto-router` plugin (whose captured request
 * body is `{"model": "openrouter/auto", ...}`) and by this repo's existing
 * `isAutoRouterModel` / `DEFAULT_OPENCODE_MODEL`, which pass `openrouter/auto`
 * through unchanged. The `/auto` suffix is OpenRouter's model id; the leading
 * `openrouter/` is the OpenRouter provider namespace the API also accepts, so
 * the whole string is forwarded as-is.
 */
export const FALLBACK_AUTO_ROUTER_MODEL = "openrouter/auto";

/**
 * The failure-class statuses that trigger a pre-first-byte failover. 429 is
 * the operator's named trigger (rate limit); 5xx covers provider outages. A
 * connection-level failure (fetch rejects: DNS, refused, TLS) is handled at
 * the call site as the same class.
 */
export function isFailoverStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export interface SyntheticFailoverResolved {
  /** Primary metered upstream (Synthetic), e.g. `https://api.synthetic.new`. */
  readonly primary: string;
  /** Fallback metered upstream (OpenRouter). */
  readonly fallback: string;
  readonly syntheticApiKey: string;
  readonly openrouterApiKey: string;
}

/** One failover, as observed by the proxy's bounded journal. */
export interface SyntheticFailoverEvent {
  /** The status that triggered the failover, or undefined for a connection error. */
  readonly status: number | undefined;
  /** The model the failed Synthetic request named (before the fallback re-pin). */
  readonly fromModel: string | undefined;
  /** The fixed fallback model OpenRouter received. */
  readonly toModel: string;
  /** Wall-clock time of the failover. */
  readonly at: number;
}

/** Env, then the caller-supplied auth-store key, then the 0600 key file. */
function resolveSyntheticKey(
  env: NodeJS.ProcessEnv,
  authKey: string | undefined,
  readKeyFile: ((name: string) => string | undefined) | undefined,
): string | undefined {
  const fromEnv = (env[SYNTHETIC_KEY_ENV] ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  const fromAuth = authKey?.trim();
  if (fromAuth !== undefined && fromAuth !== "") return fromAuth;
  const fromFile = readKeyFile?.(SYNTHETIC_KEY_FILE)?.trim();
  return fromFile !== undefined && fromFile !== "" ? fromFile : undefined;
}

/**
 * Translates the agent-facing API path to Synthetic's OpenAI-compatible path.
 *
 * OpenCode's metered provider (v1 custom provider and v2's built-in
 * `openrouter` override) and Cline all use baseURL `<proxy>/api/v1`, so the
 * proxy receives `/api/v1/chat/completions`. OpenRouter serves that path, but
 * Synthetic serves `/v1/chat/completions` (verified live 2026-10-02:
 * `/api/v1/...` 404s; `/v1/...` and `/openai/v1/...` exist). The primary hop
 * therefore rewrites the leading `/api/v1` to `/v1`; the OpenRouter failover
 * hop keeps the original path.
 */
export function syntheticUpstreamPath(pathname: string): string {
  const prefix = "/api/v1/";
  return pathname.startsWith(prefix) ? `/v1/${pathname.slice(prefix.length)}` : pathname;
}

/**
 * The fallback body: the failed request with `model` re-pinned to the fixed
 * OpenRouter Auto Router slug `openrouter/auto`, preserved verbatim (that is
 * the id OpenRouter serves, per the reference plugin's captured body). Every
 * other field is preserved (a failover must not rewrite the conversation).
 */
export function fallbackBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, model: FALLBACK_AUTO_ROUTER_MODEL };
}

/** The OpenRouter Auto Router slug surfaced to operators/logs. */
export function fallbackModelLabel(): string {
  return FALLBACK_AUTO_ROUTER_MODEL;
}

/**
 * The `synthetic.key` credential in an OpenCode auth store document, if
 * present. PURE (no IO): callers read the auth.json and pass the parsed
 * object. Mirrors `openrouterAuthKeyFromAuth` in `acp-runtime.ts`.
 */
export function syntheticAuthKeyFromAuth(auth: unknown): string | undefined {
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return undefined;
  const synthetic = (auth as Record<string, unknown>).synthetic;
  if (typeof synthetic !== "object" || synthetic === null || Array.isArray(synthetic)) return undefined;
  const key = (synthetic as Record<string, unknown>).key;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
}

/** Parses the `WORKFLOW_SYNTHETIC` toggle; absent/enabled -> true, off -> false. */
export function syntheticToggleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[SYNTHETIC_TOGGLE_ENV] ?? "").trim().toLowerCase();
  if (ENABLED_TOGGLES.has(value)) return true;
  if (DISABLED_TOGGLES.has(value)) return false;
  return true;
}

/**
 * The resolved metered lane: which upstream the proxy points at, which key it
 * injects there, and (on the Synthetic primary) the OpenRouter failover pair.
 */
export interface MeteredLane {
  readonly upstream: string;
  readonly apiKey: string;
  readonly failover?: SyntheticFailoverResolved | undefined;
}

export interface ResolveMeteredLaneOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit `WORKFLOW_ACP_UPSTREAM`; absent auto-selects from key presence. */
  readonly configuredUpstream?: string | undefined;
  /** The existing OpenRouter upstream key (canonical, or auth-store fallback). */
  readonly openrouterApiKey: string;
  /** Synthetic key discovered in the OpenCode auth store, if any. */
  readonly authKey?: string | undefined;
  /** Synthetic key file reader; injectable for tests. */
  readonly readKeyFile?: ((name: string) => string | undefined) | undefined;
  /** Test override for the Synthetic key (wins over env/auto). */
  readonly syntheticApiKey?: string | undefined;
}

/**
 * Resolves the primary metered lane. Auto-selection (the operator pivot):
 * with a resolvable Synthetic key the lane is Synthetic-primary + OpenRouter
 * failover; with none it stays OpenRouter single-upstream, so a keyless
 * checkout is unchanged. An EXPLICIT `WORKFLOW_ACP_UPSTREAM` is always
 * honored (an operator-locked origin is never silently overridden); if it
 * names Synthetic and a key exists, the failover pair composes, otherwise the
 * configured upstream runs alone.
 *
 * NOTE on the Synthetic-only branch (no OpenRouter key): this pure resolver
 * supports it (Synthetic runs without a fallback), but the runtime callers
 * each resolve the OpenRouter key through `loadUpstreamApiKey`, which THROWS
 * when no OpenRouter key is present. OpenRouter is therefore a runtime
 * prerequisite on every lane; the Synthetic-only branch is exercised by the
 * unit tests but is not reachable through the current loaders. A future
 * Synthetic-only deployment must make the loaders return `""` rather than
 * throw when a Synthetic key is resolvable.
 */
export function resolveMeteredLane(options: ResolveMeteredLaneOptions): MeteredLane {
  const env = options.env ?? process.env;
  const configured = options.configuredUpstream?.trim();
  const enabled = syntheticToggleEnabled(env);
  const syntheticKey = enabled
    ? options.syntheticApiKey ?? resolveSyntheticKey(env, options.authKey, options.readKeyFile)
    : undefined;
  const openrouterApiKey = options.openrouterApiKey.trim();
  const failoverFor = (primary: string, synthetic: string): SyntheticFailoverResolved | undefined =>
    openrouterApiKey === ""
      ? undefined
      : { primary, fallback: OPENROUTER_UPSTREAM, syntheticApiKey: synthetic, openrouterApiKey };
  if (configured !== undefined && configured !== "") {
    if (syntheticKey !== undefined && isSyntheticUpstream(configured)) {
      return { upstream: configured, apiKey: syntheticKey, failover: failoverFor(configured, syntheticKey) };
    }
    return { upstream: configured, apiKey: openrouterApiKey };
  }
  if (syntheticKey !== undefined) {
    return { upstream: SYNTHETIC_UPSTREAM, apiKey: syntheticKey, failover: failoverFor(SYNTHETIC_UPSTREAM, syntheticKey) };
  }
  return { upstream: OPENROUTER_UPSTREAM, apiKey: openrouterApiKey };
}

/** The runtime failover sink: one structured line per failover event. */
export function logFailover(event: SyntheticFailoverEvent): void {
  const trigger = event.status === undefined ? "connection-error" : `status ${event.status}`;
  console.error(
    `[failover] synthetic -> openrouter: ${trigger} (model ${event.fromModel ?? "unknown"} -> ${event.toModel})`,
  );
}
