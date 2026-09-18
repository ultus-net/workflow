import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_WEB_AGENT, isWebAgentId, listWebAgents } from "../src/ui/web-agents.js";

// The registry is the composable-agent seam for the web UI: every agent the
// browser can pick is declared here with an honest containment posture, and
// unknown ids are rejected before a launch is ever attempted. OpenCode is the
// lead/default (the operator's coding agent, per docs/ACP_DECISION.md); Cline
// stays reachable as the vendored fallback.
describe("web agent registry", () => {
  it("declares the composable agents with their containment posture, default first", () => {
    const agents = listWebAgents();
    const ids = agents.map((agent) => agent.id);
    assert.deepEqual(ids, ["opencode", "goose", "cline"]);
    assert.equal(agents.find((a) => a.id === "cline")?.containment, "contained");
    assert.equal(agents.find((a) => a.id === "opencode")?.containment, "advisory");
    assert.equal(agents.find((a) => a.id === "goose")?.containment, "contained");
    assert.equal(agents.find((a) => a.id === "cline")?.name, "Cline");
    assert.equal(agents.find((a) => a.id === "opencode")?.name, "OpenCode");
    assert.equal(agents.find((a) => a.id === "goose")?.name, "Goose");
  });

  it("defaults to OpenCode, the documented coding lead", () => {
    assert.equal(DEFAULT_WEB_AGENT, "opencode");
    assert.equal(listWebAgents()[0]?.id, DEFAULT_WEB_AGENT);
  });

  it("reports availability for every declared agent, with a reason when unavailable", () => {
    for (const agent of listWebAgents()) {
      assert.equal(typeof agent.available, "boolean");
      if (!agent.available) {
        assert.ok(agent.reason !== undefined && agent.reason.length > 0);
      }
    }
  });

  it("accepts declared ids and rejects everything else", () => {
    assert.equal(isWebAgentId("cline"), true);
    assert.equal(isWebAgentId("opencode"), true);
    assert.equal(isWebAgentId("goose"), true);
    assert.equal(isWebAgentId("unknown-agent"), false);
    assert.equal(isWebAgentId(""), false);
  });
});
