import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_OPEN_SOURCE_POOL,
  closedModelOverride,
  findOpenModel,
  isOpenSourceModel,
  openSourceModelIds,
  openSourcePoolFromEnv,
  resolveModelSelection,
  resolveOpenModelRoute,
  type OpenModelDefinition,
} from "../src/integrations/open-source-pool.js";

/**
 * W070a: the open-source default pool and direct-first routing with a verified
 * OpenRouter fallback. Every id/endpoint was live-verified on 2026-09-19.
 */

test("default pool is the four live-verified open-source models", () => {
  assert.deepEqual(openSourceModelIds(), ["deepseek-flash", "glm-5.3", "glm-5.3-flash", "kimi-k3"]);
  const deepseek = findOpenModel("deepseek-flash");
  assert.equal(deepseek?.model, "deepseek-flash");
  assert.equal(deepseek?.endpoint, "https://api.deepseek.com");
  assert.equal(deepseek?.family, "deepseek");
  const glm = findOpenModel("glm-5.3");
  assert.equal(glm?.endpoint, "https://api.z.ai/api/paas/v4");
  assert.equal(glm?.family, "glm");
  const kimi = findOpenModel("kimi-k3");
  assert.equal(kimi?.endpoint, "https://api.moonshot.ai/v1");
  assert.equal(kimi?.family, "kimi");
});

test("every default entry carries a verified OpenRouter fallback and provenance", () => {
  const expectedFallbacks: Record<string, string> = {
    "deepseek-flash": "deepseek/deepseek-v4.1-flash",
    "glm-5.3": "z-ai/glm-5.3",
    "glm-5.3-flash": "z-ai/glm-5.3-flash",
    "kimi-k3": "moonshotai/kimi-k3",
  };
  for (const entry of DEFAULT_OPEN_SOURCE_POOL) {
    assert.equal(entry.fallback?.provider, "openrouter", `${entry.id} needs a fallback`);
    assert.equal(entry.fallback?.model, expectedFallbacks[entry.id], `${entry.id} fallback id must match the live catalog`);
    assert.equal(entry.verifiedOn, "2026-09-19");
    assert.ok(entry.verifiedSource.length > 0, `${entry.id} must cite its verification source`);
  }
});

test("openSourcePoolFromEnv selects an ordered subset and rejects unknown ids", () => {
  assert.deepEqual(openSourceModelIds(openSourcePoolFromEnv({})), openSourceModelIds());
  const subset = openSourcePoolFromEnv({ WORKFLOW_OPEN_MODEL_POOL: "kimi-k3, glm-5.3" });
  assert.deepEqual(openSourceModelIds(subset), ["kimi-k3", "glm-5.3"]);
  assert.throws(() => openSourcePoolFromEnv({ WORKFLOW_OPEN_MODEL_POOL: "gpt-9" }), /unknown open-source model/);
});

test("resolveOpenModelRoute prefers direct and falls back only when unavailable", () => {
  const deepseek = findOpenModel("deepseek-flash")!;
  const direct = resolveOpenModelRoute(deepseek);
  assert.deepEqual(direct, { kind: "direct", model: "deepseek-flash", endpoint: "https://api.deepseek.com", provider: "deepseek" });

  const fallback = resolveOpenModelRoute(deepseek, { directAvailable: false });
  assert.equal(fallback.kind, "openrouter");
  assert.equal(fallback.model, "deepseek/deepseek-v4.1-flash");
  assert.equal(fallback.provider, "openrouter");
});

test("a model with no verified fallback fails loudly rather than guessing an id", () => {
  const bare: OpenModelDefinition = {
    id: "mystery",
    label: "Mystery",
    family: "deepseek",
    model: "mystery-1",
    endpoint: "https://api.deepseek.com",
    wire: "openai",
    thinking: "opt-in",
    verifiedOn: "2026-09-19",
    verifiedSource: "test fixture",
  };
  assert.throws(() => resolveOpenModelRoute(bare, { directAvailable: false }), /no verified OpenRouter fallback/);
});

test("closed models stay available via explicit operator override", () => {
  assert.equal(closedModelOverride("anthropic/claude-sonnet-4"), "anthropic/claude-sonnet-4");
  assert.equal(closedModelOverride("glm-5.3"), undefined, "pool models are not overrides");
  assert.equal(closedModelOverride("  "), undefined);
  assert.equal(closedModelOverride(undefined), undefined);

  const selection = resolveModelSelection({ override: "openrouter/auto" });
  assert.deepEqual(selection, { model: "openrouter/auto", source: "override", closed: true });
  const poolDefault = resolveModelSelection();
  assert.deepEqual(poolDefault, { model: "deepseek-flash", source: "pool", closed: false });
  assert.equal(isOpenSourceModel("kimi-k3"), true);
  assert.equal(isOpenSourceModel("openrouter/auto"), false);
});
