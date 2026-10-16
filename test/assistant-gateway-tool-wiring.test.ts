import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  ASSISTANT_IDENTITY_HEADER,
  createAssistantGateway,
  type AssistantGatewayConfig,
} from "../src/integrations/assistant-gateway.js";
import type {
  AssistantCompletionClient,
  AssistantToolCall,
  AssistantToolContext,
  AssistantToolExecutor,
  AssistantToolResult,
} from "../src/integrations/assistant-tool-loop.js";

const METRICS = () => ({
  requests: 0,
  usageEvents: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  latestPromptTokens: undefined,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
});

function config(): AssistantGatewayConfig {
  return {
    version: 1,
    identities: { "user-1": "coding" },
    routes: {
      coding: { route: "coding", systemPrompt: "You are a coding assistant." },
      tutor: { route: "tutor", systemPrompt: "You are a tutor." },
      care: { route: "care", systemPrompt: "You are a care assistant." },
    },
  };
}

/** A fake metered-egress upstream: records bodies, answers via a scripted queue. */
async function fakeEgress(responses: readonly unknown[]): Promise<{
  url: string;
  seen: string[];
  close: () => Promise<void>;
}> {
  const seen: string[] = [];
  let index = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push(Buffer.concat(chunks).toString("utf8"));
      const body = responses[index] ?? { choices: [{ message: { role: "assistant", content: "done" } }] };
      index += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: "http://127.0.0.1:" + String(address.port),
    seen,
    close: () => new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
  };
}

/** A scripted completion client: one response per round-trip, records bodies. */
function scriptedClient(responses: readonly unknown[]): { client: AssistantCompletionClient; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  let index = 0;
  return {
    bodies,
    client: {
      runCompletion(body: Readonly<Record<string, unknown>>): Promise<unknown> {
        bodies.push(body as Record<string, unknown>);
        const response = responses[index] ?? { choices: [{ message: { role: "assistant", content: "done" } }] };
        index += 1;
        return Promise.resolve(response);
      },
    },
  };
}

function toolCallMessage(id: string, name: string, args: string): unknown {
  return { choices: [{ message: { role: "assistant", tool_calls: [{ id, function: { name, arguments: args } }] } }] };
}

function textMessage(content: string): unknown {
  return { choices: [{ message: { role: "assistant", content } }] };
}

/** A scripted executor: one result per call, records calls. */
function scriptedExecutor(): { executor: AssistantToolExecutor; calls: AssistantToolCall[]; contexts: AssistantToolContext[] } {
  const calls: AssistantToolCall[] = [];
  const contexts: AssistantToolContext[] = [];
  return {
    calls,
    contexts,
    executor: {
      execute(call, context): Promise<AssistantToolResult> {
        calls.push(call);
        contexts.push(context);
        return Promise.resolve({ callId: call.id, content: "ran " + call.name });
      },
    },
  };
}

test("a tools request with an executor runs the loop and returns the final JSON", async () => {
  const egress = await fakeEgress([]);
  const { client, bodies } = scriptedClient([
    toolCallMessage("call_1", "learner_profile", "{}"),
    textMessage("Here is your profile."),
  ]);
  const { executor, calls, contexts } = scriptedExecutor();
  const gateway = await createAssistantGateway({
    egressUrl: egress.url,
    egressMetrics: METRICS,
    config: config(),
    executor,
    completionClient: client,
  });
  try {
    const response = await fetch(gateway.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "user-1" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "profile?" }], tools: [{ type: "function", function: { name: "learner_profile" } }] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), textMessage("Here is your profile."), "the final loop body is returned");

    assert.equal(bodies.length, 2, "two completion round-trips");
    assert.equal(calls.length, 1, "the executor ran once");
    assert.equal(calls[0]!.name, "learner_profile");
    assert.equal(contexts[0]!.identity, "user-1", "the executor saw the identity");
    assert.equal(contexts[0]!.route, "coding", "the executor saw the route bound to the identity");

    // The second round-trip carries the original conversation with the route
    // system prompt prepended, plus the tool observation.
    const second = bodies[1]!.messages as readonly Record<string, unknown>[];
    assert.equal(second[0]!.role, "system", "the route system prompt leads");
    assert.equal(second[1]!.role, "user");
    assert.ok(second.some((message) => message.role === "tool"), "a tool observation rides the second request");

    // The loop never touched the egress: the injected client carried every round.
    assert.equal(egress.seen.length, 0, "the loop used the injected client, not the egress");
  } finally {
    await gateway.close();
    await egress.close();
  }
});

test("a tools request WITHOUT an executor stays M1 passthrough (the egress sees it)", async () => {
  const egress = await fakeEgress([{ choices: [{ message: { role: "assistant", content: "passthrough" } }] }]);
  const gateway = await createAssistantGateway({ egressUrl: egress.url, egressMetrics: METRICS, config: config() });
  try {
    const response = await fetch(gateway.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "user-1" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "x" } }] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { choices: [{ message: { role: "assistant", content: "passthrough" } }] });
    // With no executor configured the request is forwarded, tools and all.
    assert.equal(egress.seen.length, 1, "an unconfigured ingress forwards the request");
    const forwarded = JSON.parse(egress.seen[0]!) as { tools?: unknown[] };
    assert.ok(Array.isArray(forwarded.tools), "the tools array rode the passthrough untouched");
  } finally {
    await gateway.close();
    await egress.close();
  }
});

test("a no-tools request with an executor configured stays M1 passthrough", async () => {
  const { executor } = scriptedExecutor();
  const egress = await fakeEgress([{ choices: [{ message: { role: "assistant", content: "no tools" } }] }]);
  const gateway = await createAssistantGateway({
    egressUrl: egress.url,
    egressMetrics: METRICS,
    config: config(),
    executor,
  });
  try {
    const response = await fetch(gateway.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "user-1" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(egress.seen.length, 1, "no tools → the passthrough forwards to the egress");
    const forwarded = JSON.parse(egress.seen[0]!) as { messages?: readonly Record<string, unknown>[] };
    assert.equal(forwarded.messages![0]!.content, "You are a coding assistant.", "the route system prompt is injected");
  } finally {
    await gateway.close();
    await egress.close();
  }
});

test("a tools request with an executor runs the default completion client through the egress", async () => {
  // No injected client: the loop's default client is the egress. The egress
  // answers a tool call then a final message.
  const egress = await fakeEgress([
    toolCallMessage("call_1", "learner_profile", "{}"),
    textMessage("done via egress"),
  ]);
  const { executor, calls } = scriptedExecutor();
  const gateway = await createAssistantGateway({
    egressUrl: egress.url,
    egressMetrics: METRICS,
    config: config(),
    executor,
  });
  try {
    const response = await fetch(gateway.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "user-1" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "profile?" }], tools: [{ type: "function", function: { name: "learner_profile" } }] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), textMessage("done via egress"));
    assert.equal(calls.length, 1, "the executor ran once");
    assert.equal(egress.seen.length, 2, "the default client drove two egress round-trips");
  } finally {
    await gateway.close();
    await egress.close();
  }
});
