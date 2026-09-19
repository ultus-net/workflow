/**
 * W070b slice 6: golden-probe corpus skeleton for the vendor-verification
 * product (feeds W062). One check set per vendor: DeepSeek strict adherence,
 * K3 replay integrity, GLM flag correctness.
 *
 * These definitions are deterministic and run without network access against
 * the policy modules. The live leg of `test/open-model-golden-probe.test.ts`
 * is probe-gated (`WORKFLOW_OPEN_MODEL_PROBES=1` + per-vendor key env); an
 * unrun vendor records the gate state honestly and stays `advisory`.
 */

import type { JsonSchema } from "../../src/integrations/deepseek-strict-schema.js";

export type GoldenProbeKind = "strict-schema" | "replay-integrity" | "thinking-flags";

export type ExpectedReplayAction = "allow" | "reject" | "route-anthropic";

export interface GoldenProbeCheck {
  readonly id: string;
  readonly kind: GoldenProbeKind;
  readonly description: string;
  /** Replay fixture for replay-integrity checks. */
  readonly replayMessages?: readonly Record<string, unknown>[];
  /** Expected `enforceReplayPolicy` decision for the replay fixture. */
  readonly expectedReplayAction?: ExpectedReplayAction;
}

export interface VendorGoldenProbe {
  readonly vendor: "deepseek" | "kimi" | "glm";
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly baseUrlEnv: string;
  readonly defaultBaseUrl: string;
  /** Representative tool schema for the strict-adherence probe. */
  readonly toolSchema: JsonSchema;
  readonly checks: readonly GoldenProbeCheck[];
}

const DEEPSEEK_TOOL_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    recursive: { type: "boolean" },
  },
};

const KIMI_PRESERVED_REPLAY: readonly Record<string, unknown>[] = [
  { role: "user", content: "read the file" },
  {
    role: "assistant",
    content: null,
    reasoning_content: "I will read the file.",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "read" } }],
  },
  { role: "tool", tool_call_id: "call_1", content: "file body" },
];

const KIMI_STRIPPED_REPLAY: readonly Record<string, unknown>[] = [
  { role: "user", content: "read the file" },
  { role: "assistant", content: "I'll read it." },
  { role: "tool", tool_call_id: "call_1", content: "file body" },
];

const DEEPSEEK_SYNTHETIC_REPLAY: readonly Record<string, unknown>[] = [
  { role: "user", content: "run the seeded tool" },
  { role: "tool", tool_call_id: "call_seed", content: "seeded" },
];

export const OPEN_MODEL_GOLDEN_PROBES: readonly VendorGoldenProbe[] = [
  {
    vendor: "deepseek",
    model: "deepseek-chat",
    apiKeyEnv: "WORKFLOW_DEEPSEEK_API_KEY",
    baseUrlEnv: "WORKFLOW_DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com/beta",
    toolSchema: DEEPSEEK_TOOL_SCHEMA,
    checks: [
      { id: "deepseek-strict-adherence", kind: "strict-schema", description: "representative tool schema strictifies with all-required + additionalProperties:false" },
      {
        id: "deepseek-synthetic-insertion",
        kind: "replay-integrity",
        description: "synthesized mid-conversation tool-call turn is diverted to the Anthropic path",
        replayMessages: DEEPSEEK_SYNTHETIC_REPLAY,
        expectedReplayAction: "route-anthropic",
      },
    ],
  },
  {
    vendor: "kimi",
    model: "kimi-k3",
    apiKeyEnv: "WORKFLOW_KIMI_API_KEY",
    baseUrlEnv: "WORKFLOW_KIMI_BASE_URL",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    toolSchema: DEEPSEEK_TOOL_SCHEMA,
    checks: [
      {
        id: "kimi-replay-preserved",
        kind: "replay-integrity",
        description: "preserved reasoning_content + tool_calls replay passes",
        replayMessages: KIMI_PRESERVED_REPLAY,
        expectedReplayAction: "allow",
      },
      {
        id: "kimi-replay-stripped",
        kind: "replay-integrity",
        description: "stripped replay is rejected",
        replayMessages: KIMI_STRIPPED_REPLAY,
        expectedReplayAction: "reject",
      },
    ],
  },
  {
    vendor: "glm",
    model: "glm-5.3",
    apiKeyEnv: "WORKFLOW_GLM_API_KEY",
    baseUrlEnv: "WORKFLOW_GLM_BASE_URL",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    toolSchema: DEEPSEEK_TOOL_SCHEMA,
    checks: [
      { id: "glm-thinking-flags", kind: "thinking-flags", description: "GLM policy never disables thinking" },
      {
        id: "glm-standard-replay",
        kind: "replay-integrity",
        description: "GLM accepts standard replay with no vendor replay contract",
        replayMessages: [{ role: "tool", tool_call_id: "call_1", content: "x" }],
        expectedReplayAction: "allow",
      },
    ],
  },
];
