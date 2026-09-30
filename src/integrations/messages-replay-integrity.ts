/**
 * P9 option D: the anthropic Messages-schema replay integrity check.
 *
 * The chat-completions lane enforces W070b's replay policy
 * (`enforceReplayPolicy` in `src/integrations/model-replay-policy.ts`). The
 * messages lane is W070b's SANCTIONED synthetic-tool-call transport (deepseek's
 * `route-anthropic` decision) and stays replay-UNgated by recorded decision
 * (docs/PARKED_AND_LIMITATIONS.md:38, the W123 compatibility record). This
 * module is the queued successor: a pure detector plus a fail-closed decision
 * for the messages lane, the messages-schema sibling of
 * `detectSyntheticToolCallTurns`.
 *
 * THE W070b COMPATIBILITY CONSTANT (do not false-reject the sanctioned path):
 * the insertion the replay policy routes to this lane is a synthetic
 * tool-call TURN — a matched `tool_use`/`tool_result` pair (with its preserved
 * thinking, signature intact). The detector therefore flags only the UNPAIRED
 * halves of such a turn and a stripped thinking signature; a matched pair is
 * always allowed. A tier that flagged every tool_use/tool_result turn would
 * contradict the policy that sends those turns here.
 *
 * Pure policy plus deterministic detection: no IO, no model id, no vendor
 * contract — the vendor's Messages schema is structural. It never claims to
 * prevent anything beyond refusing a body that cannot be safely replayed at the
 * metering-proxy boundary.
 */

/** The named policy under which a messages-lane replay integrity refusal is structured. */
export const MESSAGES_REPLAY_POLICY = "messages-replay-integrity" as const;

export type MessagesReplayViolationCode =
  | "unanswered-tool-use"
  | "unattributed-tool-result"
  | "missing-thinking-signature"
  | "missing-messages"
  | "unparseable-body";

export interface MessagesReplayViolation {
  readonly code: MessagesReplayViolationCode;
  /** Index into the replayed `messages` array; -1 for a body-level violation. */
  readonly index: number;
  readonly detail: string;
}

export type MessagesReplayIntegrityDecision =
  | { readonly action: "allow"; readonly policy: typeof MESSAGES_REPLAY_POLICY }
  | {
      readonly action: "reject";
      readonly policy: typeof MESSAGES_REPLAY_POLICY;
      readonly reason: string;
      readonly violations: readonly MessagesReplayViolation[];
    };

type Rejection = Extract<MessagesReplayIntegrityDecision, { action: "reject" }>;

function rejection(violations: readonly MessagesReplayViolation[]): Rejection {
  return {
    action: "reject",
    policy: MESSAGES_REPLAY_POLICY,
    reason: `messages-schema replay integrity check rejected the request: ${violations.length} violation(s) — the body cannot be safely replayed`,
    violations,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function contentBlocks(message: Record<string, unknown>): readonly Record<string, unknown>[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record !== undefined) blocks.push(record);
  }
  return blocks;
}

interface ToolUseRef {
  readonly id: string;
  readonly index: number;
}

interface ToolResultRef {
  readonly id: string;
  readonly index: number;
}

/**
 * Detects a messages body the replay policy cannot safely replay.
 *
 * Three deterministic structural signals: an assistant `tool_use` block never
 * answered by a following `tool_result` (`unanswered-tool-use`); a
 * `tool_result` block with no PRECEDING `tool_use` carrying its `tool_use_id`
 * (`unattributed-tool-result`); and a `thinking` block whose preserved
 * `signature` was stripped (`missing-thinking-signature`). A matched
 * tool_use/tool_result pair — including W070b's sanctioned synthetic insertion
 * — is attributed and passes.
 */
export function detectMessagesSchemaReplayViolations(messages: readonly unknown[]): MessagesReplayViolation[] {
  const violations: MessagesReplayViolation[] = [];
  const toolUses: ToolUseRef[] = [];
  const toolResults: ToolResultRef[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = asRecord(messages[index]);
    if (message === undefined) continue;
    for (const block of contentBlocks(message)) {
      if (block.type === "tool_use") {
        const id = block.id;
        if (typeof id === "string" && id.length > 0) toolUses.push({ id, index });
        else violations.push({ code: "unanswered-tool-use", index, detail: "tool_use block carries no id and cannot be answered" });
      } else if (block.type === "tool_result") {
        const id = block.tool_use_id;
        if (typeof id === "string" && id.length > 0) toolResults.push({ id, index });
        else violations.push({ code: "unattributed-tool-result", index, detail: "tool_result block carries no tool_use_id and cannot be attributed" });
      } else if (block.type === "thinking") {
        const signature = block.signature;
        if (typeof signature !== "string" || signature.length === 0) {
          violations.push({
            code: "missing-thinking-signature",
            index,
            detail: "thinking block carries no signature; the vendor's preserved-thinking replay is unrecoverable",
          });
        }
      }
    }
  }

  for (const use of toolUses) {
    const answered = toolResults.some((result) => result.id === use.id && result.index > use.index);
    if (!answered) {
      violations.push({
        code: "unanswered-tool-use",
        index: use.index,
        detail: `tool_use '${use.id}' is not answered by a following tool_result`,
      });
    }
  }
  for (const result of toolResults) {
    const declared = toolUses.some((use) => use.id === result.id && use.index < result.index);
    if (!declared) {
      violations.push({
        code: "unattributed-tool-result",
        index: result.index,
        detail: `tool_result '${result.id}' has no preceding tool_use`,
      });
    }
  }

  violations.sort((left, right) => left.index - right.index);
  return violations;
}

/**
 * Applies the messages-schema replay integrity check to one parsed Messages
 * body. Returns an allow decision or a structured, named rejection. A body with
 * no `messages` array fails closed (`missing-messages`).
 */
export function enforceMessagesReplayIntegrity(body: Record<string, unknown>): MessagesReplayIntegrityDecision {
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return rejection([{ code: "missing-messages", index: -1, detail: "the messages body carries no messages array to validate" }]);
  }
  const violations = detectMessagesSchemaReplayViolations(messages);
  if (violations.length > 0) return rejection(violations);
  return { action: "allow", policy: MESSAGES_REPLAY_POLICY };
}

/**
 * The fail-closed refusal for a messages body that is not a parseable JSON
 * object: under the integrity opt-in an unverifiable body cannot be proven
 * replay-safe, so it is refused rather than forwarded.
 */
export function unparseableMessagesBodyRejection(): Rejection {
  return rejection([{ code: "unparseable-body", index: -1, detail: "the messages body was not a parseable JSON object and cannot be validated" }]);
}
