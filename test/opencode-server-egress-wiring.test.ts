import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createOpencodeServerRuntime,
  type OpencodeServerProxyInput,
} from "../src/integrations/opencode-server-runtime.js";
import type { EgressDenialEvent, EgressObservation, ProxyPayloadPolicy } from "../src/integrations/model-usage-proxy.js";
import type { CredentialEndpoint } from "../src/integrations/credentials.js";

/**
 * W184: the W129 opencode-server lane previously composed its metering proxy
 * with only the model-routing seams, silently bypassing the W179 gate-2 binding,
 * the W180 path/function policy tier, and the W181/W182 observation/denial
 * sinks. These pins capture the exact input the runtime hands its proxy factory
 * and assert every egress seam is forwarded — and that an unconfigured lane
 * forwards none of them (byte-identical default).
 */

async function captureProxyInput(options: {
  credentialEndpoints?: readonly CredentialEndpoint[];
  payloadPolicy?: ProxyPayloadPolicy;
  onEgressObservation?: (observation: EgressObservation) => void;
  onEgressDenied?: (event: EgressDenialEvent) => void;
}): Promise<OpencodeServerProxyInput> {
  let captured: OpencodeServerProxyInput | undefined;
  await assert.rejects(
    createOpencodeServerRuntime({
      workspace: "/tmp/w184-server-egress-ws",
      stateHome: "/tmp/w184-server-egress-state",
      upstream: "https://openrouter.ai",
      apiKey: "test-key-not-used",
      ...options,
      createProxy: async (input) => {
        captured = input;
        throw new Error("captured: stop before launch");
      },
    }),
    /captured: stop before launch/,
  );
  assert.ok(captured !== undefined, "the runtime must compose a proxy input");
  return captured;
}

test("W184: the server lane forwards the gate-2 binding, policy tier, and both sinks to its proxy", async () => {
  const credentialEndpoints: CredentialEndpoint[] = [{ host: "openrouter.ai", pathPrefix: "/api/v1" }];
  const payloadPolicy: ProxyPayloadPolicy = { egressPolicy: { rules: [{ id: "r", host: "openrouter.ai", mode: "enforce" }] } };
  const onEgressObservation = (): void => undefined;
  const onEgressDenied = (): void => undefined;
  const input = await captureProxyInput({ credentialEndpoints, payloadPolicy, onEgressObservation, onEgressDenied });
  assert.deepEqual(input.credentialEndpoints, credentialEndpoints, "gate 2 is threaded");
  assert.equal(input.payloadPolicy, payloadPolicy, "the W180 policy tier is threaded");
  assert.equal(input.onEgressObservation, onEgressObservation, "the W181 observation sink is threaded");
  assert.equal(input.onEgressDenied, onEgressDenied, "the W182 denial sink is threaded");
});

test("W184: an unconfigured server lane forwards no egress seam (dark by default)", async () => {
  const input = await captureProxyInput({});
  assert.equal(input.credentialEndpoints, undefined, "no binding → gate 2 stays inactive");
  assert.equal(input.payloadPolicy, undefined, "no policy → the tier stays dark");
  assert.equal(input.onEgressObservation, undefined);
  assert.equal(input.onEgressDenied, undefined);
});
