import assert from "node:assert/strict";
import { test } from "node:test";

import { credentialBindingFingerprint, upstreamCredentialBinding, upstreamOrigin } from "../src/integrations/egress-binding.js";
import type { CredentialDefinition } from "../src/integrations/credentials.js";

/**
 * W184: the production source for the proxy's W179 gate-2 credential binding.
 * The single-origin metering proxy can only reach its own upstream, so the
 * binding is derived from the operator's credential definitions and narrowed to
 * that origin: a definition's `allowedEndpoints` that names a DIFFERENT
 * host/port is dropped (it could only refuse every request, never scope one).
 * No definitions binding the origin → an empty binding → the caller leaves the
 * proxy gate dark (byte-identical).
 */

function definition(over: Partial<CredentialDefinition>): CredentialDefinition {
  return {
    id: "cred-1",
    label: "Upstream",
    kind: "api-key",
    allowedConsumers: [],
    allowedPurposes: [],
    ...over,
  };
}

test("W184 upstreamOrigin normalizes the explicit port and the scheme default", () => {
  assert.deepEqual(upstreamOrigin("https://openrouter.ai"), { host: "openrouter.ai", port: 443 });
  assert.deepEqual(upstreamOrigin("http://localhost:8080"), { host: "localhost", port: 8080 });
  assert.deepEqual(upstreamOrigin("https://API.Example.COM"), { host: "api.example.com", port: 443 });
});

test("W184 upstreamCredentialBinding keeps only endpoints that name the proxy origin", () => {
  const binding = upstreamCredentialBinding("https://openrouter.ai", [
    definition({ allowedEndpoints: [{ host: "openrouter.ai", port: 443, pathPrefix: "/api/v1" }] }),
    definition({ allowedEndpoints: [{ host: "evil.example.com" }] }),
  ]);
  assert.deepEqual(binding, [{ host: "openrouter.ai", port: 443, pathPrefix: "/api/v1" }], "the foreign-host binding is dropped");
});

test("W184 upstreamCredentialBinding accepts a portless endpoint as any-port and honors case", () => {
  const binding = upstreamCredentialBinding("https://openrouter.ai", [
    definition({ allowedEndpoints: [{ host: "OpenRouter.AI", pathPrefix: "/v1" }] }),
  ]);
  assert.deepEqual(binding, [{ host: "OpenRouter.AI", pathPrefix: "/v1" }]);
});

test("W184 upstreamCredentialBinding is empty when no definition binds the origin (gate stays dark)", () => {
  const binding = upstreamCredentialBinding("https://openrouter.ai", [
    definition({ allowedEndpoints: [{ host: "api.example.com" }] }),
    definition({}),
  ]);
  assert.deepEqual(binding, []);
});

test("W184 upstreamCredentialBinding deduplicates identical endpoints", () => {
  const endpoint = { host: "openrouter.ai", pathPrefix: "/v1" } as const;
  const binding = upstreamCredentialBinding("https://openrouter.ai", [
    definition({ allowedEndpoints: [endpoint] }),
    definition({ allowedEndpoints: [endpoint] }),
  ]);
  assert.equal(binding.length, 1);
});

test("W184 credentialBindingFingerprint is value-free, order-stable, and changes with the bindings", () => {
  const a = definition({ allowedEndpoints: [{ host: "openrouter.ai", pathPrefix: "/v1" }] });
  const b = definition({ allowedEndpoints: [{ host: "api.example.com" }] });
  assert.equal(credentialBindingFingerprint([a, b]), credentialBindingFingerprint([b, a]), "order does not change the digest");
  assert.notEqual(credentialBindingFingerprint([a]), credentialBindingFingerprint([b]), "a binding change moves the digest");
  assert.equal(credentialBindingFingerprint([definition({})]), "", "no bindings digests to the empty string");
});
