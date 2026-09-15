import assert from "node:assert/strict";
import test from "node:test";

import { createCredentialControlPlane, InMemorySecretStore } from "../src/integrations/credentials.js";
import { createAdminControlPlaneServer } from "../src/ui/admin-control-plane.js";

test("admin credential API requires its distinct capability and never returns secret values", async (t) => {
  const credentials = createCredentialControlPlane(new InMemorySecretStore());
  const auditEvents: unknown[] = [];
  const server = createAdminControlPlaneServer({ credentials, adminToken: "admin-capability", audit: (event) => auditEvents.push(event) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${base}/api/admin/credentials`)).status, 401);
  const create = await fetch(`${base}/api/admin/credentials`, {
    method: "PUT",
    headers: { authorization: "Bearer admin-capability", "content-type": "application/json", origin: base },
    body: JSON.stringify({
      id: "github-pat", label: "GitHub PAT", kind: "api-key", value: "ghp_super_secret",
      allowedConsumers: ["mcp:github"], allowedPurposes: ["stdio-env:GITHUB_TOKEN"], workspace: "/work/repo",
    }),
  });
  assert.equal(create.status, 204);

  const response = await fetch(`${base}/api/admin/credentials`, {
    headers: { authorization: "Bearer admin-capability" },
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes("ghp_super_secret"), false);
  assert.equal(text.includes("github-pat"), true);

  const revoke = await fetch(`${base}/api/admin/credentials/github-pat`, {
    method: "DELETE",
    headers: { authorization: "Bearer admin-capability", origin: base },
  });
  assert.equal(revoke.status, 204);
  assert.deepEqual(auditEvents, [
    { actor: "admin", action: "set", credentialId: "github-pat", consumers: ["mcp:github"] },
    { actor: "admin", action: "revoke", credentialId: "github-pat", consumers: ["mcp:github"] },
  ]);
  assert.equal(JSON.stringify(auditEvents).includes("ghp_super_secret"), false);
});

test("admin credential mutations reject cross-origin requests", async (t) => {
  const credentials = createCredentialControlPlane(new InMemorySecretStore());
  const server = createAdminControlPlaneServer({ credentials, adminToken: "admin-capability" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${base}/api/admin/credentials`, {
    method: "PUT",
    headers: { authorization: "Bearer admin-capability", "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 403);
});
