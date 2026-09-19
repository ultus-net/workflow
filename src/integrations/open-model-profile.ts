/**
 * TODO(dependency-w070a): W070a (parallel worktree) owns the canonical
 * `ModelProfile` type — the per-family request-shaping layer described in
 * `docs/superpowers/plans/2026-09-19-open-source-model-pivot.md` §3 slice 3
 * (`reasoning_effort`, vendor-correct `thinking` flags, temperature/top-p).
 * That type is absent on this branch. This module is the thin, consumer-side
 * view W070b codes against so replay and strict-schema policy can land in
 * parallel; when W070a merges, replace this file with W070a's type (or import
 * it) and delete this stub. It deliberately does NOT shape requests — it only
 * identifies the family and wire so policy can branch deterministically.
 */

export type ModelFamily = "deepseek" | "glm" | "kimi-k3" | "unknown";

export type ModelWire = "openai" | "anthropic";

export type ReasoningEffort = "low" | "high" | "max";

export interface ModelProfile {
  /** Vendor model id as it appears on the wire (e.g. `deepseek-chat`). */
  readonly modelId: string;
  readonly family: ModelFamily;
  /** Wire format the profile is composed for. */
  readonly wire: ModelWire;
  /** Accepted effort setting, when the family supports one. */
  readonly reasoningEffort: ReasoningEffort | undefined;
  /** Whether the profile requires server-enforced strict tool schemas. */
  readonly strictToolSchemas: boolean;
}

const DEEPSEEK_MARKERS = ["deepseek"];
const GLM_MARKERS = ["glm", "z-ai", "zhipu"];
const KIMI_MARKERS = ["kimi", "moonshot"];

/**
 * Classifies a wire model id into the open-model families the pivot targets.
 * Unknown ids stay `unknown` so policy never applies a vendor contract the
 * model did not advertise.
 */
export function classifyModelFamily(modelId: string): ModelFamily {
  const normalized = modelId.toLowerCase();
  if (DEEPSEEK_MARKERS.some((marker) => normalized.includes(marker))) return "deepseek";
  if (GLM_MARKERS.some((marker) => normalized.includes(marker))) return "glm";
  if (KIMI_MARKERS.some((marker) => normalized.includes(marker))) return "kimi-k3";
  return "unknown";
}

/** Builds the consumer-side profile for a wire model id. */
export function profileFromModelId(modelId: string, wire: ModelWire = "openai"): ModelProfile {
  const family = classifyModelFamily(modelId);
  return {
    modelId,
    family,
    wire,
    reasoningEffort: family === "unknown" ? undefined : "max",
    strictToolSchemas: family === "deepseek",
  };
}

/** DeepSeek's server-validated strict-schema base URL (Beta). */
export const DEEPSEEK_STRICT_BASE_URL = "https://api.deepseek.com/beta";

/** DeepSeek's Anthropic-compatible base URL for mid-conversation insertions. */
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
