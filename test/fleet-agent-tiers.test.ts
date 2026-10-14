import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fleetAgentTierPins,
  modelRefFromString,
  safeFleetAgentTierPins,
  sessionModelRefForAgent,
} from "../src/integrations/fleet-agent-tiers.js";
import { OPENCODE_V2_METERED_PROVIDER_ID } from "../src/integrations/opencode-agent-config.js";

/**
 * W185: per-agent tier pins do not resolve on the v2 runtime. The v2 session
 * runner reads `session.model` only, never the agent's `model` frontmatter, so
 * a session created for a fleet agent records the session default. This module
 * resolves each agent's tier pin for both hub-owned lanes to seed at
 * session-create. These tests pin the resolver against the SHIPPED vendored
 * assets, so a drift in either the manifest or an agent's frontmatter fails
 * here rather than silently dropping a pin.
 */

test("W185: fleetAgentTierPins resolves every vendored agent's tier, metered-id-prefixed", () => {
  const pins = fleetAgentTierPins();
  // The accepted mapping (issue #547): small = executor/retrospective/screener,
  // large = decompose/executor-strong/reviewer.
  assert.equal(pins["executor"], `${OPENCODE_V2_METERED_PROVIDER_ID}/syn:small:text`);
  assert.equal(pins["retrospective"], `${OPENCODE_V2_METERED_PROVIDER_ID}/syn:small:text`);
  assert.equal(pins["screener"], `${OPENCODE_V2_METERED_PROVIDER_ID}/syn:small:text`);
  assert.equal(pins["decompose"], `${OPENCODE_V2_METERED_PROVIDER_ID}/syn:large:text`);
  assert.equal(pins["executor-strong"], `${OPENCODE_V2_METERED_PROVIDER_ID}/syn:large:text`);
  assert.equal(pins["reviewer"], `${OPENCODE_V2_METERED_PROVIDER_ID}/syn:large:text`);
  assert.equal(Object.keys(pins).length, 6, "every vendored agent with a model pin is resolved");
  for (const [agent, ref] of Object.entries(pins)) {
    assert.ok(ref.startsWith(`${OPENCODE_V2_METERED_PROVIDER_ID}/`), `${agent} is metered-id-prefixed`);
    assert.ok(/^[^/]+\/syn:(small|large):text$/.test(ref), `${agent} carries a tier id`);
  }
});

test("W185: sessionModelRefForAgent yields the v2 Model.Ref shape, undefined for an unknown agent", () => {
  const pins = fleetAgentTierPins();
  assert.deepEqual(sessionModelRefForAgent(pins, "executor"), {
    providerID: OPENCODE_V2_METERED_PROVIDER_ID,
    id: "syn:small:text",
  });
  assert.deepEqual(sessionModelRefForAgent(pins, "reviewer"), {
    providerID: OPENCODE_V2_METERED_PROVIDER_ID,
    id: "syn:large:text",
  });
  assert.equal(sessionModelRefForAgent(pins, "build"), undefined, "an agent with no pin keeps the session default");
  assert.equal(sessionModelRefForAgent(pins, "does-not-exist"), undefined, "an unknown agent never fabricates a pin");
});

test("W185: modelRefFromString splits a ref and rejects a provider-less one", () => {
  assert.deepEqual(modelRefFromString("openrouter/syn:small:text"), { providerID: "openrouter", id: "syn:small:text" });
  assert.equal(modelRefFromString("auto"), undefined, "no provider separator");
  assert.equal(modelRefFromString("/leading"), undefined, "empty provider");
  assert.equal(modelRefFromString("trailing/"), undefined, "empty model id");
});

test("W185: safeFleetAgentTierPins fails OPEN — an unreadable assets tree yields {} and never throws", () => {
  // The load-bearing constraint: a resolve failure must never refuse the
  // daemon/runtime. A bogus root throws in the fail-closed core and is caught.
  assert.throws(() => fleetAgentTierPins({ root: "/nonexistent-w185-assets-root" }), "the core fails closed");
  assert.deepEqual(safeFleetAgentTierPins({ root: "/nonexistent-w185-assets-root" }), {}, "the safe wrapper fails open");
});
