/**
 * W070b slice 1: per-model assistant-message replay policy.
 *
 * The retired GPT-era harness stripped or summarized assistant internals when
 * replaying history (compaction, steering, permission replays). The open-model
 * pool punishes that differently per vendor:
 *
 * - Kimi K3: "preserved thinking history" — the complete assistant message
 *   (`reasoning_content` AND `tool_calls`) must be replayed verbatim; a
 *   stripped replay degrades tool discipline.
 * - DeepSeek: tool-call turns cannot be synthesized mid-conversation through
 *   Chat Completion; such insertions must go through the Anthropic-format
 *   path.
 * - GLM: standard chat replay.
 *
 * This module is pure policy plus deterministic detection. It is harness
 * correctness, not a security control: it never claims to prevent anything
 * beyond rejecting malformed replays at the metering-proxy boundary.
 */

/** Where a harness may synthesize/insert a mid-conversation tool-call turn. */
export type ReplayTransport = "chat-completions" | "anthropic-messages";

/**
 * Replay-time family classification from the wire model id. This is W070b's
 * own union (`kimi-k3` vendor name plus an `unknown` fallback) and is
 * intentionally distinct from W070a's canonical `ModelFamily`
 * (`deepseek | glm | kimi`, no fallback) — the replay policy classifies
 * directly from the id and must never apply a vendor contract a model did not
 * advertise. Reconciled after the W070a merge (the `open-model-profile.ts`
 * consumer stub was deleted; W070a owns the canonical type).
 */
export type ModelFamily = "deepseek" | "glm" | "kimi-k3" | "unknown";

const DEEPSEEK_MARKERS = ["deepseek"];
const GLM_MARKERS = ["glm", "z-ai", "zhipu"];
const KIMI_MARKERS = ["kimi", "moonshot"];

export function classifyModelFamily(modelId: string): ModelFamily {
  const normalized = modelId.toLowerCase();
  if (DEEPSEEK_MARKERS.some((marker) => normalized.includes(marker))) return "deepseek";
  if (GLM_MARKERS.some((marker) => normalized.includes(marker))) return "glm";
  if (KIMI_MARKERS.some((marker) => normalized.includes(marker))) return "kimi-k3";
  return "unknown";
}

export interface ReplayPolicy {
  readonly family: ModelFamily;
  /**
   * `preserve-verbatim` requires the full assistant turn (reasoning_content
   * and tool_calls) on replay; `standard` accepts the host's normal replay.
   */
  readonly assistantReplay: "preserve-verbatim" | "standard";
  /** Whether replayed assistant tool-call turns must carry reasoning_content. */
  readonly requiresReasoningContent: boolean;
  /**
   * The transport a harness may use to insert a synthesized tool-call turn
   * mid-conversation. `anthropic-messages` means Chat Completion is forbidden.
   */
  readonly syntheticToolCallTransport: ReplayTransport;
}

const POLICIES: Readonly<Record<ModelFamily, ReplayPolicy>> = {
  "kimi-k3": {
    family: "kimi-k3",
    assistantReplay: "preserve-verbatim",
    requiresReasoningContent: true,
    syntheticToolCallTransport: "chat-completions",
  },
  deepseek: {
    family: "deepseek",
    assistantReplay: "standard",
    requiresReasoningContent: false,
    syntheticToolCallTransport: "anthropic-messages",
  },
  glm: {
    family: "glm",
    assistantReplay: "standard",
    requiresReasoningContent: false,
    syntheticToolCallTransport: "chat-completions",
  },
  unknown: {
    family: "unknown",
    assistantReplay: "standard",
    requiresReasoningContent: false,
    syntheticToolCallTransport: "chat-completions",
  },
};

export function replayPolicyForFamily(family: ModelFamily): ReplayPolicy {
  return POLICIES[family];
}

export function replayPolicyForModel(modelId: string): ReplayPolicy {
  return replayPolicyForFamily(classifyModelFamily(modelId));
}

export type ReplayViolationCode =
  | "stripped-tool-calls"
  | "stripped-reasoning-content"
  | "synthetic-tool-call-turn";

export interface ReplayViolation {
  readonly code: ReplayViolationCode;
  /** Index into the replayed `messages` array. */
  readonly index: number;
  readonly detail: string;
}

interface ReplayMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly reasoning_content?: unknown;
  readonly tool_calls?: unknown;
  readonly tool_call_id?: unknown;
}

function asMessage(value: unknown): ReplayMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as ReplayMessage;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function toolCalls(message: ReplayMessage): readonly Record<string, unknown>[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.filter(
    (call): call is Record<string, unknown> => typeof call === "object" && call !== null && !Array.isArray(call),
  );
}

function toolCallIds(message: ReplayMessage): readonly string[] {
  return toolCalls(message)
    .map((call) => call.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function precedingToolCallIds(messages: readonly unknown[], index: number): readonly string[] {
  let cursor = index - 1;
  while (cursor >= 0) {
    const previous = asMessage(messages[cursor]);
    if (previous?.role !== "tool") break;
    cursor -= 1;
  }
  const owner = cursor >= 0 ? asMessage(messages[cursor]) : undefined;
  return owner?.role === "assistant" ? toolCallIds(owner) : [];
}

function hasOwningToolCall(messages: readonly unknown[], index: number, message: ReplayMessage): boolean {
  const id = typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
  return id !== undefined && precedingToolCallIds(messages, index).includes(id);
}

/**
 * Detects a replay that stripped the assistant internals K3 requires.
 *
 * Two deterministic signals: a `tool` result whose immediately preceding
 * message is not an assistant tool-call turn (the call was dropped or the
 * history summarized), and an assistant tool-call turn missing
 * `reasoning_content` (the thinking half of the preserved turn was stripped).
 */
export function detectStrippedReplay(messages: readonly unknown[]): ReplayViolation[] {
  const violations: ReplayViolation[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = asMessage(messages[index]);
    if (message === undefined) continue;
    if (message.role === "tool" && !hasOwningToolCall(messages, index, message)) {
      violations.push({
        code: "stripped-tool-calls",
        index,
        detail: "tool result is not attributable to a preceding assistant tool-call turn",
      });
    }
    if (message.role === "assistant" && toolCalls(message).length > 0 && !nonEmptyString(message.reasoning_content)) {
      violations.push({
        code: "stripped-reasoning-content",
        index,
        detail: "assistant tool-call turn is missing reasoning_content",
      });
    }
  }
  return violations;
}

/**
 * Detects tool-call turns a harness synthesized and inserted mid-conversation
 * through Chat Completion. DeepSeek forbids that shape and requires the
 * Anthropic-format path instead. A `tool` result with no preceding assistant
 * tool-call turn, or a tool-call turn whose ids never receive a `tool` result
 * before the next non-tool message, is the insertion signature.
 */
export function detectSyntheticToolCallTurns(messages: readonly unknown[]): ReplayViolation[] {
  const violations: ReplayViolation[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = asMessage(messages[index]);
    if (message === undefined) continue;
    if (message.role === "tool") {
      if (!hasOwningToolCall(messages, index, message)) {
        violations.push({
          code: "synthetic-tool-call-turn",
          index,
          detail: "tool result is not attributable to a preceding assistant tool-call turn",
        });
      }
      continue;
    }
    if (message.role === "assistant" && toolCalls(message).length > 0) {
      const ids = toolCallIds(message);
      if (ids.length === 0) {
        violations.push({ code: "synthetic-tool-call-turn", index, detail: "tool-call turn has no call ids" });
        continue;
      }
      const answered = new Set<string>();
      for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
        const next = asMessage(messages[cursor]);
        if (next === undefined) continue;
        if (next.role !== "tool") break;
        const id = typeof next.tool_call_id === "string" ? next.tool_call_id : undefined;
        if (id !== undefined) answered.add(id);
      }
      if (ids.some((id) => !answered.has(id))) {
        violations.push({
          code: "synthetic-tool-call-turn",
          index,
          detail: "assistant tool-call turn is not answered by tool results",
        });
      }
    }
  }
  return violations;
}

export type ReplayEnforcement =
  | { readonly action: "allow"; readonly policy: ReplayPolicy }
  | { readonly action: "reject"; readonly policy: ReplayPolicy; readonly reason: string; readonly violations: readonly ReplayViolation[] }
  | { readonly action: "route-anthropic"; readonly policy: ReplayPolicy; readonly reason: string; readonly violations: readonly ReplayViolation[] };

/**
 * Applies the model's replay policy to one Chat Completion body. Returns an
 * allow decision, a rejection (K3 stripped replay), or a routing signal
 * (DeepSeek synthetic insertion — the harness must use the Anthropic path).
 */
export function enforceReplayPolicy(body: Record<string, unknown>): ReplayEnforcement {
  const modelId = typeof body.model === "string" ? body.model : "";
  const policy = replayPolicyForModel(modelId);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (policy.assistantReplay === "preserve-verbatim") {
    const violations = detectStrippedReplay(messages);
    if (violations.length > 0) {
      return {
        action: "reject",
        policy,
        reason: `replay policy '${policy.family}' requires the complete assistant turn (reasoning_content + tool_calls); detected ${violations.length} stripped replay violation(s)`,
        violations,
      };
    }
  }
  if (policy.syntheticToolCallTransport === "anthropic-messages") {
    const violations = detectSyntheticToolCallTurns(messages);
    if (violations.length > 0) {
      return {
        action: "route-anthropic",
        policy,
        reason: `replay policy '${policy.family}' forbids synthesized tool-call turns via Chat Completion; route the insertion through the Anthropic-format path (${violations.length} violation(s))`,
        violations,
      };
    }
  }
  return { action: "allow", policy };
}

/**
 * Whether a harness may synthesize/insert a tool-call turn on the given
 * transport for this family. Consulted by harness composition; Chat Completion
 * insertion for DeepSeek is forbidden.
 */
export function maySynthesizeToolCallTurn(family: ModelFamily, transport: ReplayTransport): boolean {
  return replayPolicyForFamily(family).syntheticToolCallTransport === transport;
}
