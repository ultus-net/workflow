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
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
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

test("SessionChannel.usage falls back to ACP usage_update for unmetered runtimes (OpenCode parity)", () => {
  const driver = {
    ...fakeDriver(undefined),
    acpUsageSnapshot: () => ({ used: 32_900, size: 200_000, costUsd: 0.4182 }),
  };
  // No metering proxy at all: the channel must still serve context and cost.
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, undefined);
  const usage = channel.usage();
  assert.equal(usage?.latestPromptTokens, 32_900);
  assert.equal(usage?.contextWindowTokens, 200_000);
  assert.equal(usage?.costUsd, 0.4182);
  // Token counters the agent never reported stay absent — unknown is not zero.
  assert.equal(usage?.promptTokens, undefined);
  assert.equal(usage?.completionTokens, undefined);
});

test("SessionChannel.usage prefers the driver-reported window over the ACP snapshot size", () => {
  const driver = {
    ...fakeDriver(256_000),
    acpUsageSnapshot: () => ({ used: 100, size: 200_000, costUsd: 0.01 }),
  };
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, undefined);
  assert.equal(channel.usage()?.contextWindowTokens, 256_000);
});

test("SessionChannel.usage omits cost when the agent reports usage without cost", () => {
  const driver = {
    ...fakeDriver(undefined),
    acpUsageSnapshot: () => ({ used: 5000, size: 128_000 }),
  };
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, undefined);
  const usage = channel.usage();
  assert.equal(usage?.latestPromptTokens, 5000);
  // No fabricated $0.00: an unreported cost stays absent, never zero.
  assert.equal(usage?.costUsd, undefined);
});

test("SessionChannel.usage stays undefined when the agent reports neither usage nor cost", () => {
  const driver = {
    ...fakeDriver(undefined),
    acpUsageSnapshot: () => ({}),
  };
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, undefined);
  assert.equal(channel.usage(), undefined);
});

test("SessionChannel.usage serves the prompt-response token split for unmetered runtimes", () => {
  const driver = {
    ...fakeDriver(128_000),
    acpUsageSnapshot: () => ({ used: 5000, size: 128_000, costUsd: 0.01 }),
    turnTokenTotals: () => ({ input: 7000, output: 42, turns: 2 }),
  };
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, undefined);
  const usage = channel.usage();
  assert.equal(usage?.source, "agent");
  assert.equal(usage?.promptTokens, 7000);
  assert.equal(usage?.completionTokens, 42);
  assert.equal(usage?.requests, 2);
  assert.equal(usage?.costUsd, 0.01);
});

/* Baseline-merge rules (restart continuity): per-process counters sum with the
 * persisted baseline; point-in-time fields prefer live; agent-reported cost
 * supersedes only when both sides come from the agent's own store. */

const BASELINE = {
  source: "agent" as const,
  requests: 3,
  promptTokens: 10_000,
  completionTokens: 500,
  totalTokens: 10_500,
  latestPromptTokens: 9000,
  costUsd: 0.02,
  contextWindowTokens: 128_000,
};

test("SessionChannel.usage merges metered live counters with the persisted baseline (sum)", () => {
  const driver = fakeDriver(200_000);
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, () => metrics, undefined, undefined, undefined, {
    source: "metered" as const,
    requests: 4,
    usageEvents: 4,
    promptTokens: 1000,
    completionTokens: 100,
    totalTokens: 1100,
    costUsd: 0.01,
  });
  const usage = channel.usage();
  assert.equal(usage?.promptTokens, 1100);
  assert.equal(usage?.requests, 5);
  assert.equal(usage?.costUsd, 0.011);
  assert.equal(usage?.contextWindowTokens, 200_000);
});

test("SessionChannel.usage: agent-reported cost supersedes an agent baseline (no double count)", () => {
  const driver = {
    ...fakeDriver(undefined),
    acpUsageSnapshot: () => ({ used: 6000, size: 128_000, costUsd: 0.033 }),
    turnTokenTotals: () => ({ input: 1200, output: 30, turns: 1 }),
  };
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, undefined, undefined, undefined, undefined, BASELINE);
  const usage = channel.usage();
  // The agent's store is session-cumulative: the live cost replaces the
  // baseline rather than adding to it.
  assert.equal(usage?.costUsd, 0.033);
  // Per-process token deltas still sum with history.
  assert.equal(usage?.promptTokens, 11_200);
  assert.equal(usage?.requests, 4);
  // Point-in-time context prefers the live report.
  assert.equal(usage?.latestPromptTokens, 6000);
});

test("SessionChannel.usage sums cost when the sources differ (session moved between agents)", () => {
  const driver = {
    ...fakeDriver(undefined),
    acpUsageSnapshot: () => ({ used: 6000, size: 128_000, costUsd: 0.033 }),
  };
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, undefined, undefined, undefined, undefined, {
    source: "metered" as const,
    costUsd: 0.02,
  });
  const cost = channel.usage()?.costUsd ?? 0;
  assert.ok(Math.abs(cost - 0.053) < 1e-9, `disjoint spend sums (got ${cost})`);
});

test("SessionChannel.usage serves the baseline alone when nothing has been reported this process", () => {
  const driver = fakeDriver(undefined);
  const channel = new SessionChannel(new WorkflowCodingSession(driver), driver, undefined, undefined, undefined, undefined, BASELINE);
  assert.deepEqual(channel.usage(), BASELINE);
});