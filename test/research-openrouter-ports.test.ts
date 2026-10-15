import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenRouterProvider, type ChatOptions } from "../src/assistant/provider/openrouter.js";
import { createFileArtifactStore } from "../src/assistant/research/types.js";
import { runResearch } from "../src/assistant/research/conductor.js";
import { openRouterConductorPorts } from "../src/assistant/research/openrouter-ports.js";

/**
 * The OpenRouter binding of the conductor ports. Proves the two properties that
 * make the conductor "tier the roles" control real at the wire level: the
 * frontier model is asked for planning/synthesis, the cheap model for workers,
 * and each worker body lands in the artifact store rather than the conductor's
 * context.
 *
 * The provider is driven through a fake `fetchImpl`, so this is offline and
 * deterministic.
 */

interface CapturedCall {
  readonly model: string;
  readonly body: Record<string, unknown>;
}

function fakeProvider(calls: CapturedCall[]): OpenRouterProvider {
  let counter = 0;
  const fetchImpl = (async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ model: String(body.model), body });
    counter += 1;
    // First call is the plan; the rest are workers/synthesis. Shape the reply to
    // the request so the binding exercises its parse paths.
    const isPlan = Array.isArray(body.response_format) === false && String(body.temperature) === "0";
    const content = isPlan
      ? JSON.stringify({ subQuestions: [{ subQuestion: "q1" }, { subQuestion: "q2" }] })
      : `# finding ${counter}\n\nbody ${counter}\n`;
    return new Response(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, server_tool_use: { web_search_requests: 1 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return new OpenRouterProvider({
    authorization: "Bearer test",
    config: { models: ["default/model"], variant: "", allowFallbacks: true },
    fetchImpl,
  });
}

test("the conductor tiers roles: frontier plans/synthesizes, cheap model runs workers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-or-ports-"));
  try {
    const calls: CapturedCall[] = [];
    const store = createFileArtifactStore(dir);
    const ports = openRouterConductorPorts({
      provider: fakeProvider(calls),
      store,
      lang: "en",
      conductorModels: ["frontier/model"],
      workerModels: ["cheap/model"],
    });
    const outcome = await runResearch(
      {
        runId: "r1",
        question: "the question",
        complexity: "comparison",
        budget: { maxSubagents: 4, maxToolCalls: 60, maxCostUsd: 10 },
        store,
      },
      ports,
    );

    // The first call (plan) and the last call (synthesis) are frontier; the two
    // worker calls are cheap.
    assert.equal(calls[0]!.model, "frontier/model", "plan uses the frontier tier");
    assert.equal(calls.at(-1)!.model, "frontier/model", "synthesis uses the frontier tier");
    assert.deepEqual(
      calls.slice(1, -1).map((c) => c.model),
      ["cheap/model", "cheap/model"],
      "workers use the cheap tier",
    );

    // Workers got the web search tool; the conductor calls did not.
    assert.equal(calls[1]!.body.tools !== undefined, true, "workers carry the search tool");
    assert.equal(calls[0]!.body.tools, undefined, "the planner does not search");

    assert.match(outcome.answer, /finding/);
    // Bodies went to the artifact store, not through the conductor.
    assert.ok(store.read("findings/search.subquestion.1.md") !== undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed plan degrades to a single-question plan rather than crashing", async () => {
  const fetchImpl = (async (): Promise<Response> =>
    new Response(JSON.stringify({ model: "x", choices: [{ message: { content: "not json" } }], usage: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const provider = new OpenRouterProvider({ authorization: "Bearer t", config: { models: ["x"], variant: "", allowFallbacks: true }, fetchImpl });
  const dir = mkdtempSync(join(tmpdir(), "wf-or-degrade-"));
  try {
    const store = createFileArtifactStore(dir);
    const ports = openRouterConductorPorts({ provider, store, lang: "en" });
    const tasks = await ports.plan({ question: "the only question", complexity: "simple", maxSubagents: 1 });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.subQuestion, "the only question");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ChatOptions.model overrides the configured model priority for one call", () => {
  const calls: CapturedCall[] = [];
  const provider = fakeProvider(calls);
  void provider.chat({ messages: [{ role: "user", content: "hi" }], model: "override/model" } as ChatOptions);
  assert.equal(calls[0]!.model, "override/model");
});
