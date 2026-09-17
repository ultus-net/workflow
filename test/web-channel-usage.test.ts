import assert from "node:assert/strict";
import test from "node:test";

import { WorkflowCodingSession } from "../src/application/coding-session.js";
import type { ModelUsageMetrics } from "../src/integrations/model-usage-proxy.js";
import { SessionChannel } from "../src/ui/web-session-channel.js";

const metrics: ModelUsageMetrics = {
  requests: 1,
  usageEvents: 1,
  promptTokens: 100,
  completionTokens: 10,
  totalTokens: 110,
  costUsd: 0.001,
  latestPromptTokens: 90,
};

function fakeDriver(contextWindow: number | undefined) {
  return {
    start: async () => {},
    cancel: async () => {},
    config: () => undefined,
    setConfigOption: async () => ({ configOptions: [] }),
    ...(contextWindow === undefined ? {} : { contextWindowTokens: () => contextWindow }),
  };
}

test("SessionChannel.usage merges the agent-reported context window", () => {
  const driver = fakeDriver(200_000);
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, () => metrics);
  const usage = channel.usage();
  assert.equal(usage?.contextWindowTokens, 200_000);
  assert.equal(usage?.latestPromptTokens, 90);
});

test("SessionChannel.usage omits the window when the agent does not report it", () => {
  const driver = fakeDriver(undefined);
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, () => metrics);
  const usage = channel.usage();
  assert.equal(usage?.contextWindowTokens, undefined);
  assert.equal(usage?.latestPromptTokens, 90);
});

test("SessionChannel.usage stays undefined when the session is unmetered", () => {
  const driver = fakeDriver(200_000);
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, () => undefined);
  assert.equal(channel.usage(), undefined);
});