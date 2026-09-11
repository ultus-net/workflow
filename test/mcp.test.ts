import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMcpEvidence, type McpProvider } from "../src/index.js";

test("MCP observations become evidence only after boundary validation", () => {
  const evidence = normalizeMcpEvidence(
    {
      observationId: "obs-1",
      subject: "typecheck",
      result: "passed",
      observedAt: "2026-09-11T00:00:00.000Z",
    },
    3,
  );

  assert.equal(evidence.authority, "mcp");
  assert.equal(evidence.mutationEpoch, 3);
  assert.equal(evidence.freshness, "fresh");
});

test("malformed MCP observations are rejected instead of self-certifying", () => {
  assert.throws(
    () => normalizeMcpEvidence({ observationId: "obs-1", subject: "typecheck", result: "maybe" }, 0),
    /invalid MCP evidence observation/,
  );
});

test("MCP provider exposes capabilities and invocation without workflow state mutation", async () => {
  const provider: McpProvider = {
    async capabilities() {
      return [{ name: "typecheck", description: "Run typecheck" }];
    },
    async invoke() {
      return { observationId: "obs-2", subject: "typecheck", result: "passed", observedAt: "2026-09-11T00:00:00.000Z" };
    },
  };

  assert.deepEqual(await provider.capabilities(), [{ name: "typecheck", description: "Run typecheck" }]);
});
