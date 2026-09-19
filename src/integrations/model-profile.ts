/**
 * W070a (owner) / W070b (consumer): per-vendor request shaping for the
 * open-source model pool. Pure contracts and pure transforms only — no IO, no
 * SDK imports, no clock. The hub resolves a `ModelProfile` for the active pool
 * model + task class and applies `shapeRequestBody` as a chat-completion body
 * crosses the metering proxy.
 *
 * Grounded vendor facts (fetched 2026-09-19; see
 * `docs/superpowers/specs/2026-09-19-w070a-routing-live-verification.md`):
 *
 * - DeepSeek V4.1-Flash (`deepseek-flash`): thinking is opt-in via
 *   `thinking: { type: "enabled" }`; `reasoning_effort` is low/high/max,
 *   default high.
 * - GLM-5.3 / 5.3-Flash: reasoning is always on; `thinking.type: "disabled"`
 *   is a hard error, only `"enabled"` is accepted; `reasoning_effort` is
 *   low/high/max, default max.
 * - Kimi K3: always reasons, exposes top-level `reasoning_effort`
 *   (low/high/max, default max); preserved thinking replay is a W070b
 *   concern (reasoning_content + tool_calls pass back verbatim).
 */

export type ModelFamily = "deepseek" | "glm" | "kimi";
export type WireProtocol = "openai" | "anthropic";
export type ReasoningEffort = "low" | "high" | "max";
export type ModelTaskClass = "coding" | "general" | "batch";
export type ThinkingMode = "opt-in" | "always-on";

export interface VendorDefaults {
  readonly family: ModelFamily;
  /** Preferred wire for the pool (OpenAI chat is uniform across all three). */
  readonly wire: WireProtocol;
  /** OpenAI-compatible base URL, including the vendor path prefix. */
  readonly endpoint: string;
  /** Anthropic-compatible base URL (documented; not the pool default). */
  readonly anthropicEndpoint: string;
  readonly thinking: ThinkingMode;
  readonly defaultEffort: ReasoningEffort;
  /** Vendor-recommended sampling; applied only when the body omits a value. */
  readonly temperature?: number;
  readonly topP?: number;
}

export const VENDOR_DEFAULTS: Readonly<Record<ModelFamily, VendorDefaults>> = {
  deepseek: {
    family: "deepseek",
    wire: "openai",
    endpoint: "https://api.deepseek.com",
    anthropicEndpoint: "https://api.deepseek.com/anthropic",
    thinking: "opt-in",
    defaultEffort: "high",
  },
  glm: {
    family: "glm",
    wire: "openai",
    endpoint: "https://api.z.ai/api/paas/v4",
    anthropicEndpoint: "https://api.z.ai/api/anthropic",
    thinking: "always-on",
    defaultEffort: "max",
    temperature: 1,
    topP: 0.95,
  },
  kimi: {
    family: "kimi",
    wire: "openai",
    endpoint: "https://api.moonshot.ai/v1",
    anthropicEndpoint: "https://api.moonshot.ai/anthropic",
    thinking: "always-on",
    defaultEffort: "max",
  },
};

export interface ModelProfile {
  readonly family: ModelFamily;
  /** Vendor model id sent upstream (e.g. `deepseek-flash`, `kimi-k3`). */
  readonly model: string;
  readonly wire: WireProtocol;
  readonly endpoint: string;
  readonly thinking: ThinkingMode;
  readonly taskClass: ModelTaskClass;
  readonly reasoningEffort: ReasoningEffort;
  readonly defaultEffort: ReasoningEffort;
}

export interface ModelProfileInput {
  readonly family: ModelFamily;
  readonly model: string;
  readonly taskClass?: ModelTaskClass;
  readonly wire?: WireProtocol;
  readonly endpoint?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

/**
 * Per-task-class effort defaults. Coding gets the strongest verified level
 * (DeepSeek `high` per its guide; GLM/K3 `max` per their vendor docs), general
 * work the vendor default, and batch the cheapest level — the off-peak
 * scheduler pairs `batch` with the 50%-rate windows.
 */
export function reasoningEffortFor(family: ModelFamily, taskClass: ModelTaskClass): ReasoningEffort {
  const defaults = VENDOR_DEFAULTS[family];
  switch (taskClass) {
    case "coding":
      return family === "deepseek" ? "high" : "max";
    case "general":
      return defaults.defaultEffort === "max" ? "high" : defaults.defaultEffort;
    case "batch":
      return "low";
  }
}

export function modelProfile(input: ModelProfileInput): ModelProfile {
  const defaults = VENDOR_DEFAULTS[input.family];
  const taskClass = input.taskClass ?? "coding";
  return {
    family: input.family,
    model: input.model,
    wire: input.wire ?? defaults.wire,
    endpoint: input.endpoint ?? defaults.endpoint,
    thinking: defaults.thinking,
    taskClass,
    reasoningEffort: input.reasoningEffort ?? reasoningEffortFor(input.family, taskClass),
    defaultEffort: defaults.defaultEffort,
  };
}

/**
 * Applies a profile's vendor parameters to a chat-completion body. The
 * hard invariant: GLM and Kimi requests NEVER carry
 * `thinking.type: "disabled"` — GLM-5.3 rejects it outright and K3 does not
 * accept the field. Returns a new object; never mutates its input.
 */
export function shapeRequestBody(profile: ModelProfile, body: Record<string, unknown>): Record<string, unknown> {
  const shaped = applySampling(profile, body);
  switch (profile.family) {
    case "deepseek":
      return profile.wire === "anthropic"
        ? { ...shaped, reasoning: { effort: profile.reasoningEffort } }
        : { ...shaped, thinking: { type: "enabled" }, reasoning_effort: profile.reasoningEffort };
    case "glm":
      // `disabled` is a hard error on GLM-5.3: force enabled, never passthrough.
      return { ...shaped, thinking: { type: "enabled" }, reasoning_effort: profile.reasoningEffort };
    case "kimi":
      // K3 reasons unconditionally; `thinking` is not a valid K3 field, so a
      // GPT-era `thinking: { type: "disabled" }` must be dropped, not sent.
      return { ...omitKey(shaped, "thinking"), reasoning_effort: profile.reasoningEffort };
  }
}

/**
 * True when `body` is safe to send for `family`: no disabled-thinking flag and
 * the effort field is a verified value. Exposed so callers (and W070b's replay
 * policy) can assert the invariant rather than re-deriving it.
 */
export function isShapeableForFamily(family: ModelFamily, body: Record<string, unknown>): boolean {
  const thinking = body.thinking;
  if (family !== "deepseek") {
    if (isRecord(thinking) && thinking.type === "disabled") return false;
  }
  const effort = body.reasoning_effort;
  return effort === undefined || effort === "low" || effort === "high" || effort === "max";
}

function applySampling(profile: ModelProfile, body: Record<string, unknown>): Record<string, unknown> {
  const defaults = VENDOR_DEFAULTS[profile.family];
  let result = body;
  if (defaults.temperature !== undefined && body.temperature === undefined) {
    result = { ...result, temperature: defaults.temperature };
  }
  if (defaults.topP !== undefined && body.top_p === undefined) {
    result = { ...result, top_p: defaults.topP };
  }
  return result;
}

function omitKey(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(body)) {
    if (name !== key) result[name] = value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
