import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OpenRouterProvider,
  resolveProviderTransport,
  type ProviderConfig,
} from "../../src/assistant/provider/openrouter.js";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const CONFIG: ProviderConfig = {
  models: ["openai/gpt-4o-mini"],
  variant: "",
  allowFallbacks: true,
};

test("gateway lane: user:pass credential is base64-encoded for Basic", () => {
  const transport = resolveProviderTransport({
    AUGUR_GATEWAY_URL: "https://gateway.example",
    AUGUR_GATEWAY_BASIC_AUTH: "user:pass",
  });
  assert.deepEqual(transport, {
    endpoint: "https://gateway.example/v1/chat/completions",
    authorization: "Basic dXNlcjpwYXNz",
    identity: "operator",
  });
});

test("gateway lane: pre-encoded credential passes through unchanged", () => {
  const transport = resolveProviderTransport({
    AUGUR_GATEWAY_URL: "https://gateway.example/",
    AUGUR_GATEWAY_BASIC_AUTH: "dXNlcjpwYXNz",
  });
  assert.equal(transport.endpoint, "https://gateway.example/v1/chat/completions");
  assert.equal(transport.authorization, "Basic dXNlcjpwYXNz");
});

test("AUGUR_IDENTITY overrides the default identity", () => {
  const transport = resolveProviderTransport({
    AUGUR_GATEWAY_URL: "https://gateway.example",
    AUGUR_GATEWAY_BASIC_AUTH: "user:pass",
    AUGUR_IDENTITY: "tutor",
  });
  assert.equal(transport.identity, "tutor");
});

test("gateway unset: OpenRouter direct with a Bearer key", () => {
  const transport = resolveProviderTransport({ OPENROUTER_API_KEY: "sk-abc" });
  assert.deepEqual(transport, {
    endpoint: OPENROUTER_ENDPOINT,
    authorization: "Bearer sk-abc",
  });
});

test("gateway lane: missing AUGUR_GATEWAY_BASIC_AUTH throws naming the var", () => {
  assert.throws(
    () => resolveProviderTransport({ AUGUR_GATEWAY_URL: "https://gateway.example" }),
    /AUGUR_GATEWAY_BASIC_AUTH/,
  );
});

test("openrouter lane: missing OPENROUTER_API_KEY throws naming the var", () => {
  assert.throws(() => resolveProviderTransport({}), /OPENROUTER_API_KEY/);
});

test("OpenRouterProvider posts to the supplied endpoint with the transport headers", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], model: "openai/gpt-4o-mini" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const transport = resolveProviderTransport({
    AUGUR_GATEWAY_URL: "https://gateway.example",
    AUGUR_GATEWAY_BASIC_AUTH: "user:pass",
    AUGUR_IDENTITY: "tutor",
  });
  const provider = new OpenRouterProvider({ ...transport, config: CONFIG, fetchImpl });
  const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(result.text, "hi");

  assert.equal(seen.length, 1);
  const captured = seen[0]!;
  assert.equal(captured.url, "https://gateway.example/v1/chat/completions");
  const headers = captured.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Basic dXNlcjpwYXNz");
  assert.equal(headers["x-workflow-user"], "tutor");
  assert.equal(headers["x-title"], "augur");
});

test("OpenRouterProvider omits x-workflow-user when no identity is set", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], model: "openai/gpt-4o-mini" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const provider = new OpenRouterProvider({
    authorization: "Bearer sk-abc",
    config: CONFIG,
    fetchImpl,
  });
  await provider.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, OPENROUTER_ENDPOINT);
  const headers = seen[0]!.init.headers as Record<string, string>;
  assert.equal("x-workflow-user" in headers, false);
});
