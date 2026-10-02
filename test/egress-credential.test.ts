import assert from "node:assert/strict";
import { test } from "node:test";

import { checkEgressCredential, checkCredentialEndpoint, METERED_PLACEHOLDER_KEY } from "../src/integrations/egress-credential.js";

test("checkEgressCredential allows an absent credential (the proxy supplies the real key)", () => {
  assert.deepEqual(checkEgressCredential({}), { allowed: true, kind: "absent" });
  assert.deepEqual(checkEgressCredential({ authorization: "" }), { allowed: true, kind: "absent" });
  assert.deepEqual(checkEgressCredential({ authorization: "   " }), { allowed: true, kind: "absent" });
});

test("checkEgressCredential allows the hub-provisioned placeholder in Bearer and bare forms", () => {
  const placeholder = METERED_PLACEHOLDER_KEY;
  assert.deepEqual(checkEgressCredential({ authorization: `Bearer ${placeholder}` }), { allowed: true, kind: "session-placeholder" });
  assert.deepEqual(checkEgressCredential({ authorization: `bearer ${placeholder}` }), { allowed: true, kind: "session-placeholder" });
  assert.deepEqual(checkEgressCredential({ authorization: placeholder }), { allowed: true, kind: "session-placeholder" });
  assert.deepEqual(checkEgressCredential({ "x-api-key": placeholder }), { allowed: true, kind: "session-placeholder" });
});

test("checkEgressCredential rejects attacker-supplied credentials presented under any credential header", () => {
  for (const header of ["authorization", "x-api-key", "api-key", "x-goog-api-key"] as const) {
    const decision = checkEgressCredential({ [header]: `Bearer sk-attacker-controlled` });
    assert.equal(decision.allowed, false, `${header} must be rejected`);
    assert.equal(decision.kind, "foreign");
    assert.equal(decision.header, header);
  }
});

test("checkEgressCredential rejects a foreign credential even beside the session placeholder", () => {
  const decision = checkEgressCredential({
    authorization: `Bearer ${METERED_PLACEHOLDER_KEY}`,
    "x-api-key": "sk-attacker-controlled",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.header, "x-api-key");
});

test("checkEgressCredential honors an explicitly configured placeholder", () => {
  assert.equal(checkEgressCredential({ authorization: "Bearer session-abc" }, "session-abc").allowed, true);
  assert.equal(checkEgressCredential({ authorization: "Bearer workflow-metered" }, "session-abc").allowed, false);
});

test("checkCredentialEndpoint preserves today's behavior when no binding is present (W179)", () => {
  assert.deepEqual(checkCredentialEndpoint({ host: "api.openrouter.ai", path: "/api/v1/chat/completions" }, undefined), {
    allowed: true,
    bindingPresent: false,
  });
});

test("checkCredentialEndpoint allows and indexes a covered host/port/path (W179)", () => {
  const endpoints = [{ host: "api.openrouter.ai", port: 443, pathPrefix: "/api/v1" }] as const;
  assert.deepEqual(checkCredentialEndpoint({ host: "api.openrouter.ai", port: 443, path: "/api/v1/chat/completions" }, endpoints), {
    allowed: true,
    bindingPresent: true,
    endpointIndex: 0,
  });
  // Host match is case-insensitive.
  assert.equal(checkCredentialEndpoint({ host: "API.OpenRouter.AI", port: 443, path: "/api/v1" }, endpoints).allowed, true);
});

test("checkCredentialEndpoint matches an absent port on either side as any port (W179)", () => {
  const anyPort = [{ host: "api.deepseek.com" }] as const;
  assert.equal(checkCredentialEndpoint({ host: "api.deepseek.com", port: 443, path: "/chat/completions" }, anyPort).allowed, true);
  assert.equal(checkCredentialEndpoint({ host: "api.deepseek.com", port: 8443, path: "/chat/completions" }, anyPort).allowed, true);
  const specificPort = [{ host: "api.deepseek.com", port: 443 }] as const;
  assert.equal(checkCredentialEndpoint({ host: "api.deepseek.com", port: 8443, path: "/x" }, specificPort).allowed, false);
  assert.equal(checkCredentialEndpoint({ host: "api.deepseek.com", path: "/x" }, specificPort).allowed, false);
});

test("checkCredentialEndpoint pathPrefix matches on a segment boundary only (W179)", () => {
  const endpoints = [{ host: "api.z.ai", pathPrefix: "/api/paas/v4" }] as const;
  assert.equal(checkCredentialEndpoint({ host: "api.z.ai", path: "/api/paas/v4" }, endpoints).allowed, true);
  assert.equal(checkCredentialEndpoint({ host: "api.z.ai", path: "/api/paas/v4/chat/completions" }, endpoints).allowed, true);
  assert.equal(checkCredentialEndpoint({ host: "api.z.ai", path: "/api/paas/v4beta" }, endpoints).allowed, false);
  assert.equal(checkCredentialEndpoint({ host: "api.z.ai", path: "/api/paas/v5" }, endpoints).allowed, false);
});

test("checkCredentialEndpoint fails closed on a disallowed host, port, or path (W179)", () => {
  const endpoints = [{ host: "api.openrouter.ai", port: 443, pathPrefix: "/api/v1" }] as const;
  assert.equal(checkCredentialEndpoint({ host: "api.attacker.example", port: 443, path: "/api/v1/chat/completions" }, endpoints).allowed, false);
  assert.equal(checkCredentialEndpoint({ host: "api.openrouter.ai", port: 8443, path: "/api/v1/chat/completions" }, endpoints).allowed, false);
  assert.equal(checkCredentialEndpoint({ host: "api.openrouter.ai", port: 443, path: "/api/v2/chat/completions" }, endpoints).allowed, false);
  // A present-but-empty binding covers nothing (fail closed).
  assert.deepEqual(checkCredentialEndpoint({ host: "api.openrouter.ai", path: "/api/v1" }, []), {
    allowed: false,
    bindingPresent: true,
  });
});