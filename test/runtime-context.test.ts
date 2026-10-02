import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_OPENCODE_MODEL, meteredOpencodeConfig } from "../src/integrations/opencode-agent-config.js";
import { EGRESS_POSTURES, egressPostureFromEnv, egressRuntimeContext, isEgressPosture } from "../src/integrations/runtime-context.js";

/**
 * W181 (A6, NVIDIA adoption): the runtime-context teaching projection is gated
 * on the ACTUAL egress posture. The load-bearing pin (the issue's acceptance
 * criterion): the projection must NOT assert deny-by-default before that
 * posture exists, because a claimed gate that is not real is a dishonest claim
 * reaching the agent. At this revision the proxy is pass-through, so the
 * default posture is `absent` and the projection is `undefined`.
 */

test("A6: the default environment is the absent posture and produces no teaching text", () => {
  assert.equal(egressPostureFromEnv({}), "absent", "no declared posture must never fabricate a gate");
  assert.equal(egressPostureFromEnv({ WORKFLOW_EGRESS_POSTURE: "proxy-gated" }), "advisory", "a proxy-gated claim without an enforcing policy downgrades to advisory");
  assert.equal(egressRuntimeContext("absent"), undefined);
  assert.equal(egressRuntimeContext("advisory"), undefined);
});

test("A6: the deny-by-default text appears ONLY for the enforcing proxy-gated posture", () => {
  const absent = egressRuntimeContext("absent");
  const advisory = egressRuntimeContext("advisory");
  const gated = egressRuntimeContext("proxy-gated");
  assert.equal(absent, undefined);
  assert.equal(advisory, undefined);
  assert.ok(gated !== undefined, "an enforcing posture must produce guidance");
  // The honesty pin: no deny-by-default claim anywhere except proxy-gated.
  for (const [label, text] of [["absent", absent], ["advisory", advisory]] as const) {
    assert.ok(text === undefined, `${label} must not emit any text`);
  }
  assert.match(gated, /denied by default/);
});

test("A6: a declared proxy-gated posture is honored only with an enforcing policy signal", () => {
  assert.equal(egressPostureFromEnv({ WORKFLOW_EGRESS_POSTURE: "proxy-gated", WORKFLOW_EGRESS_POLICY: "1" }), "proxy-gated");
  assert.equal(egressPostureFromEnv({ WORKFLOW_EGRESS_POSTURE: "advisory" }), "advisory");
  assert.equal(egressPostureFromEnv({ WORKFLOW_EGRESS_POSTURE: "nonsense" }), "absent");
  assert.equal(isEgressPosture("proxy-gated"), true);
  assert.equal(isEgressPosture("enforced"), false);
});

test("A6: the guidance teaches attempt-not-refuse and distinguishes policy denial from transport failures", () => {
  const text = egressRuntimeContext("proxy-gated");
  assert.ok(text !== undefined);
  assert.match(text, /Attempt the restricted endpoint/);
  assert.match(text, /policy denial parks an operator\s+approval decision/);
  assert.match(text, /DNS resolution failure/);
  assert.match(text, /timeouts/);
  assert.match(text, /TLS/);
  assert.match(text, /transport failure is not a policy denial/i);
});

test("A6: the opencode config references an instruction file only when one is supplied", () => {
  const without = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999" });
  assert.equal(without.instructions, undefined, "the absent posture must leave the instructions key out");
  const withGuidance = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999", instructions: ["/hub/config/egress-runtime-context.md"] });
  assert.deepEqual(withGuidance.instructions, ["/hub/config/egress-runtime-context.md"]);
  assert.equal(withGuidance.model, `workflow-metered/${DEFAULT_OPENCODE_MODEL}`);
});

test("A6: every declared posture is reachable and bounded", () => {
  assert.deepEqual([...EGRESS_POSTURES].sort(), ["absent", "advisory", "proxy-gated"]);
});
