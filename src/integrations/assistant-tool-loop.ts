/**
 * W202 (assistant tool loop, M4): the OpenAI tool-call loop for the assistant
 * gateway. Execution and authority are INJECTED PORTS: this module holds no
 * authority content, so the M4 decisions (which tools execute, how their
 * capability is classified, where they run) land behind a single port and can be
 * changed without touching the loop.
 *
 * The loop buffers one completion round-trip at a time, parses
 * `choices[].message.tool_calls`, runs each call through the injected executor,
 * appends the assistant message plus one `role: "tool"` observation per call,
 * and re-issues until the model stops calling tools or the iteration cap is
 * reached. A throw from the executor becomes an error observation for that one
 * call; it never aborts the loop.
 *
 * The gateway's non-tool path stays M1 byte passthrough. The gateway calls this
 * loop only for a request that carries a `tools` array (see `hasTools`), so a
 * streaming request with no tools is never buffered here.
 *
 * (Template literals are deliberately absent: `+` concatenation keeps sources
 * patchable under the guard shell classifier.)
 */

import type { AssistantRoute } from "./assistant-gateway.js";

/** One tool call the model requested, exactly as the model emitted it. */
export interface AssistantToolCall {
  readonly id: string;
  readonly name: string;
  /** The RAW `function.arguments` string from the model (usually JSON text). */
  readonly arguments: string;
}

/** The per-call context the executor receives. */
export interface AssistantToolContext {
  readonly identity: string;
  readonly route: AssistantRoute;
  readonly iteration: number;
}

/** One tool observation, ready to become a `role: "tool"` message. */
export interface AssistantToolResult {
  readonly callId: string;
  readonly content: string;
  readonly isError?: boolean;
}

/** The injected tool executor (the M4 decisions land behind this port). */
export interface AssistantToolExecutor {
  execute(call: AssistantToolCall, context: AssistantToolContext): Promise<AssistantToolResult>;
}

/** The injected completion transport: one buffered chat-completion round-trip. */
export interface AssistantCompletionClient {
  runCompletion(body: Readonly<Record<string, unknown>>, context: AssistantToolContext): Promise<unknown>;
}

export interface AssistantToolLoopResult {
  /** The final assistant response body, OpenAI-shaped. */
  readonly body: unknown;
  /** How many completion round-trips were spent. */
  readonly iterations: number;
  /** True when the iteration cap stopped a model that was still calling tools. */
  readonly truncated: boolean;
}

/**
 * True when the body carries a non-empty `tools` array. This is the loop's
 * discriminator: a body without tools is M1 passthrough.
 */
export function hasTools(body: Readonly<Record<string, unknown>>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/**
 * Parse `choices[].message.tool_calls` into the loop's call shape. Malformed
 * entries are skipped, never thrown on: a tool call with no string id, no
 * `function` record, or no string name is not a call the loop can run.
 */
export function parseToolCalls(message: unknown): readonly AssistantToolCall[] {
  if (!isRecord(message)) return [];
  const toolCalls = message.tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  const calls: AssistantToolCall[] = [];
  for (const entry of toolCalls) {
    if (!isRecord(entry)) continue;
    const id = entry.id;
    if (typeof id !== "string") continue;
    const fn = entry.function;
    if (!isRecord(fn)) continue;
    const name = fn.name;
    if (typeof name !== "string") continue;
    const rawArguments = fn.arguments;
    calls.push({ id, name, arguments: typeof rawArguments === "string" ? rawArguments : "" });
  }
  return calls;
}

/**
 * Run the tool-call loop to completion. `body` is never mutated: each round-trip
 * carries a fresh `messages` array built from the original conversation plus the
 * accumulated assistant/tool turns.
 */
export async function runAssistantToolLoop(options: {
  readonly body: Readonly<Record<string, unknown>>;
  readonly identity: string;
  readonly route: AssistantRoute;
  readonly client: AssistantCompletionClient;
  readonly executor: AssistantToolExecutor;
  readonly maxIterations?: number;
}): Promise<AssistantToolLoopResult> {
  const maxIterations = options.maxIterations ?? 8;
  const baseMessages = Array.isArray(options.body.messages) ? options.body.messages : [];
  let messages: readonly unknown[] = baseMessages;
  let requestBody: Readonly<Record<string, unknown>> = options.body;
  let lastResponse: unknown = options.body;
  let iterations = 0;
  let truncated = false;

  while (true) {
    if (iterations >= maxIterations) {
      // The cap stopped a model that was still calling tools on the previous
      // round-trip (otherwise the loop would have broken below).
      truncated = true;
      break;
    }
    const context: AssistantToolContext = { identity: options.identity, route: options.route, iteration: iterations };
    const response = await options.client.runCompletion(requestBody, context);
    iterations += 1;
    lastResponse = response;

    const message = messageFrom(response);
    const calls = parseToolCalls(message);
    if (calls.length === 0) break;

    const observations: unknown[] = [message];
    for (const call of calls) {
      let result: AssistantToolResult;
      try {
        result = await options.executor.execute(call, context);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        result = { callId: call.id, content: "tool execution failed: " + detail, isError: true };
      }
      observations.push({ role: "tool", tool_call_id: call.id, content: result.content });
    }
    messages = [...messages, ...observations];
    requestBody = { ...options.body, messages };
  }

  return { body: lastResponse, iterations, truncated };
}

/** The `choices[0].message` record, or `undefined` when the shape is unknown. */
function messageFrom(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!isRecord(first)) return undefined;
  return first.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
