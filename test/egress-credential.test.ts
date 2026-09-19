import assert from "node:assert/strict";
import { test } from "node:test";

import { checkEgressCredential, METERED_PLACEHOLDER_KEY } from "../src/integrations/egress-credential.js";

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