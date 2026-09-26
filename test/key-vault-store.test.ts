import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSecretStore, secretStoreBackend } from "../src/integrations/secret-store.js";
import { createKeyVaultSecretStore } from "../src/integrations/key-vault.js";

test("W156: the selection seam defaults to keyring and validates backend names", () => {
  assert.equal(secretStoreBackend({}), "keyring");
  assert.equal(secretStoreBackend({ WORKFLOW_SECRET_STORE: "keyring" }), "keyring");
  assert.equal(secretStoreBackend({ WORKFLOW_SECRET_STORE: "azure-kv" }), "azure-kv");
  assert.throws(() => secretStoreBackend({ WORKFLOW_SECRET_STORE: "consul" }), /not a known backend/);
  assert.throws(() => resolveSecretStore({ WORKFLOW_SECRET_STORE: "consul" }), /not a known backend/);
});

test("W156: azure-kv without a vault name fails closed at startup (never falls back to the keyring)", () => {
  assert.throws(() => resolveSecretStore({ WORKFLOW_SECRET_STORE: "azure-kv" }), /WORKFLOW_KEYVAULT_NAME/);
  assert.throws(
    () => resolveSecretStore({ WORKFLOW_SECRET_STORE: "azure-kv", WORKFLOW_KEYVAULT_NAME: "" }),
    /WORKFLOW_KEYVAULT_NAME/,
  );
  // A vault URI outside the vault.azure.net shape is refused too (the
  // canonical endpoint form pins the surface — no arbitrary hosts).
  assert.throws(
    () => resolveSecretStore({ WORKFLOW_SECRET_STORE: "azure-kv", WORKFLOW_KEYVAULT_NAME: "kv", WORKFLOW_KEYVAULT_URI: "http://evil.example" }),
    /invalid vault name|WORKFLOW_KEYVAULT_NAME/,
  );
});

test("W156: KeyVaultSecretStore speaks the SecretStore port against the vault REST shape", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses: Record<string, { status: number; body?: unknown }> = {
    "GET https://kv-test.vault.azure.net/secrets/w156-a?api-version=7.4": { status: 200, body: { value: "alpha" } },
    "GET https://kv-test.vault.azure.net/secrets/w156-missing?api-version=7.4": { status: 404 },
  };
  const store = createKeyVaultSecretStore({
    vaultName: "kv-test",
    getToken: async () => "test-token",
    fetcher: async (url, init) => {
      calls.push(init === undefined ? { url } : { url, init });
      const hit = responses[`${init?.method ?? "GET"} ${url}`];
      // Unmatched writes (PUT/DELETE in this test) succeed — the point is the
      // request SHAPE and the auth header, not the vault's write path.
      return new Response(
        hit?.body === undefined ? null : JSON.stringify(hit.body),
        { status: hit?.status ?? (init?.method === "GET" ? 500 : 204) },
      );
    },
  });

  assert.equal(await store.get("w156-a"), "alpha");
  assert.equal(await store.has("w156-a"), true);
  assert.equal(await store.has("w156-missing"), false);
  assert.equal(await store.get("w156-missing"), undefined);

  await store.put("w156-b", "beta");
  const put = calls.find((call) => call.init?.method === "PUT");
  assert.ok(put, "PUT issued");
  assert.equal(put.url, "https://kv-test.vault.azure.net/secrets/w156-b?api-version=7.4");
  assert.equal((JSON.parse(String(put.init?.body)) as { value: string }).value, "beta");
  assert.match(String(put.init?.headers && (put.init.headers as Record<string, string>).Authorization), /^Bearer test-token$/);

  await store.delete("w156-b");
  assert.ok(calls.some((call) => call.init?.method === "DELETE"), "DELETE issued");

  // The auth header rides every request (managed identity's token).
  assert.ok(calls.every((call) => String((call.init?.headers as Record<string, string>)?.Authorization ?? "").startsWith("Bearer ")));
});

test("W156: vault API errors surface as credential-service-unavailable, never as partial state", async () => {
  const store = createKeyVaultSecretStore({
    vaultName: "kv-test",
    getToken: async () => "test-token",
    fetcher: async () => new Response(null, { status: 403 }),
  });
  await assert.rejects(store.get("w156-x"), /credential service unavailable/);
  await assert.rejects(store.put("w156-x", "v"), /credential service unavailable/);
  await assert.rejects(store.delete("w156-x"), /credential service unavailable/);
});
