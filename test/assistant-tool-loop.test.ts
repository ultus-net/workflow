import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AssistantCompletionClient,
  AssistantToolCall,
  AssistantToolContext,
  AssistantToolExecutor,
  AssistantToolResult,
} from "../src/integrations/assistant-tool-loop.js";
import { hasTools, parseToolCalls, runAssistantToolLoop } from "../src/integrations/assistant-tool-loop.js";

/** A scripted completion client: records every body it is asked to send. */
class FakeCompletionClient implements AssistantCompletionClient {
  readonly bodies: Readonly<Record<string, unknown>>[] = [];
  readonly iterations: number[] = [];
  #queue: unknown[];

  constructor(...responses: readonly unknown[]) {
    this.#queue = [...responses];
  }

  async runCompletion(body: Readonly<Record<string, unknown>>, context: AssistantToolContext): Promise<unknown> {
    this.bodies.push(body);
    this.iterations.push(context.iteration);
    if (this.#queue.length === 0) throw new Error("fake completion client ran out of scripted responses");
    return this.#queue.shift();
  }
}

/** A scripted executor: each entry is either a result or a thrown error. */
class FakeExecutor implements AssistantToolExecutor {
  readonly calls: { readonly call: AssistantToolCall; readonly context: AssistantToolContext }[] = [];
  #queue: ({ readonly result: AssistantToolResult } | { readonly throws: string })[];

  constructor(...entries: readonly ({ readonly result: AssistantToolResult } | { readonly throws: string })[]) {
    this.#queue = [...entries];
  }

  async execute(call: AssistantToolCall, context: AssistantToolContext): Promise<AssistantToolResult> {
    this.calls.push({ call, context });
    const entry = this.#queue.shift();
    if (entry === undefined) return { callId: call.id, content: "default result" };
    if ("throws" in entry) throw new Error(entry.throws);
    return entry.result;
  }
}

function assistantToolCallMessage(id: string, name: string, args: string): unknown {
  return { choices: [{ message: { role: "assistant", tool_calls: [{ id, function: { name, arguments: args } }] } }] };
}

function assistantTextMessage(content: string): unknown {
  return { choices: [{ message: { role: "assistant", content } }] };
}

function messagesOf(body: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const messages = body.messages;
  assert.ok(Array.isArray(messages), "body carries a messages array");
  return messages as readonly Record<string, unknown>[];
}

test("two rounds: the model calls one tool then stops", async () => {
  const client = new FakeCompletionClient(
    assistantToolCallMessage("call_1", "some_tool", '{"foo":"bar"}'),
    assistantTextMessage("I did the thing"),
  );
  const executor = new FakeExecutor({ result: { callId: "call_1", content: "tool completed" } });
  const body = { model: "gpt-4", messages: [{ role: "user", content: "Help me" }] } as const;

  const result = await runAssistantToolLoop({ body, identity: "user-1", route: "coding", client, executor });

  assert.equal(client.bodies.length, 2, "two completion round-trips");
  assert.equal(executor.calls.length, 1, "the executor ran exactly once");
  assert.equal(result.iterations, 2, "two iterations");
  assert.equal(result.truncated, false, "the model stopped on its own");

  const first = executor.calls[0]!;
  assert.deepEqual(first.call, { id: "call_1", name: "some_tool", arguments: '{"foo":"bar"}' }, "the executor saw the parsed call");
  assert.equal(first.context.identity, "user-1", "the executor saw the identity");
  assert.equal(first.context.route, "coding", "the executor saw the route");
  assert.equal(first.context.iteration, 0, "the executor saw the first iteration");

  const secondMessages = messagesOf(client.bodies[1]!);
  assert.deepEqual(secondMessages[0], { role: "user", content: "Help me" }, "the original conversation leads the second request");
  assert.equal(secondMessages[1]!.role, "assistant", "the assistant message follows");
  assert.ok(Array.isArray(secondMessages[1]!.tool_calls), "the assistant message keeps its tool_calls");
  assert.deepEqual(
    secondMessages[2],
    { role: "tool", tool_call_id: "call_1", content: "tool completed" },
    "one role:tool observation follows, carrying the call id",
  );
});

test("the iteration cap truncates a model that keeps calling tools", async () => {
  const client = new FakeCompletionClient(
    assistantToolCallMessage("call_1", "a", "{}"),
    assistantToolCallMessage("call_2", "b", "{}"),
    assistantToolCallMessage("call_3", "c", "{}"),
    assistantToolCallMessage("call_4", "d", "{}"),
  );
  const executor = new FakeExecutor(
    { result: { callId: "call_1", content: "1" } },
    { result: { callId: "call_2", content: "2" } },
    { result: { callId: "call_3", content: "3" } },
  );

  const result = await runAssistantToolLoop({
    body: { model: "gpt-4", messages: [] },
    identity: "user-2",
    route: "tutor",
    client,
    executor,
    maxIterations: 3,
  });

  assert.equal(client.bodies.length, 3, "three completion round-trips");
  assert.equal(executor.calls.length, 3, "three tool executions");
  assert.equal(result.iterations, 3, "three iterations spent");
  assert.equal(result.truncated, true, "the cap stopped a still-calling model");
});

test("a throwing executor becomes an error observation, not a loop abort", async () => {
  const client = new FakeCompletionClient(
    assistantToolCallMessage("call_1", "failing_tool", "{}"),
    assistantTextMessage("done despite the failure"),
  );
  const executor = new FakeExecutor({ throws: "my tool crashed" });

  const result = await runAssistantToolLoop({
    body: { model: "gpt-4", messages: [] },
    identity: "user-3",
    route: "care",
    client,
    executor,
  });

  assert.equal(client.bodies.length, 2, "the loop re-issued after the failure");
  assert.equal(result.truncated, false, "a tool failure is not truncation");
  const observed = messagesOf(client.bodies[1]!).find((message) => message.role === "tool");
  assert.ok(observed !== undefined, "a role:tool observation was appended");
  assert.equal(observed.tool_call_id, "call_1", "the observation carries the failing call id");
  assert.match(String(observed.content), /tool execution failed/, "the content names the failure");
  assert.match(String(observed.content), /my tool crashed/, "the content carries the original error");
});

test("parseToolCalls skips malformed entries and never throws", () => {
  assert.deepEqual(parseToolCalls({}), [], "no tool_calls");
  assert.deepEqual(parseToolCalls({ tool_calls: "nope" }), [], "a non-array tool_calls");
  assert.deepEqual(parseToolCalls({ tool_calls: [1, 2] }), [], "non-record entries are skipped");
  assert.deepEqual(parseToolCalls({ tool_calls: [{ id: 7, function: { name: "x" } }] }), [], "a numeric id is skipped");
  assert.deepEqual(parseToolCalls({ tool_calls: [{ id: "a", function: "nope" }] }), [], "a non-record function is skipped");
  assert.deepEqual(parseToolCalls({ tool_calls: [{ id: "a", function: { name: 7 } }] }), [], "a non-string name is skipped");

  const parsed = parseToolCalls({
    tool_calls: [
      { id: "keep", function: { name: "keep", arguments: "{}" } },
      { id: "no-args", function: { name: "no-args" } },
    ],
  });
  assert.deepEqual(parsed, [
    { id: "keep", name: "keep", arguments: "{}" },
    { id: "no-args", name: "no-args", arguments: "" },
  ], "missing arguments string becomes empty, never undefined");
});

test("hasTools is true only for a non-empty tools array", () => {
  assert.equal(hasTools({}), false, "no tools key");
  assert.equal(hasTools({ tools: [] }), false, "an empty tools array");
  assert.equal(hasTools({ tools: "nope" }), false, "a non-array tools value");
  assert.equal(hasTools({ tools: [{}] }), true, "a non-empty tools array");
});

test("the caller's original messages array is never mutated", async () => {
  const client = new FakeCompletionClient(
    assistantToolCallMessage("call_1", "test", "{}"),
    assistantTextMessage("done"),
  );
  const executor = new FakeExecutor({ result: { callId: "call_1", content: "ok" } });
  const originalMessages = [{ role: "system", content: "You are helpful" }];
  const body = { model: "gpt-4", messages: originalMessages };

  await runAssistantToolLoop({ body, identity: "user-4", route: "coding", client, executor });

  assert.equal(originalMessages.length, 1, "the original array kept its length");
  assert.deepEqual(originalMessages[0], { role: "system", content: "You are helpful" }, "the original message is unchanged");
  assert.notEqual(client.bodies[1]!.messages, originalMessages, "the second request carries a NEW messages array");
});
