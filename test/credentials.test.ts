import assert from "node:assert/strict";
import test from "node:test";

import {
  createCredentialBroker,
  createCredentialControlPlane,
  InMemorySecretStore,
  type CredentialDefinition,
} from "../src/integrations/credentials.js";

const githubCredential: CredentialDefinition = {
  id: "github-pat",
  label: "GitHub PAT",
  kind: "api-key",
  allowedConsumers: ["mcp:github"],
  allowedPurposes: ["stdio-env:GITHUB_TOKEN"],
  workspace: "/work/repo",
};

test("credential broker materializes a secret only for an allowed consumer and workspace", async () => {
  const store = new InMemorySecretStore();
  await store.put("github-pat", "ghp_super_secret");
  const broker = createCredentialBroker(store, [githubCredential]);

  assert.equal(
    await broker.materialize({
      reference: "secret://github-pat",
      consumer: "mcp:github",
      purpose: "stdio-env:GITHUB_TOKEN",
      workspace: "/work/repo",
    }),
    "ghp_super_secret",
  );
  await assert.rejects(
    broker.materialize({
      reference: "secret://github-pat",
      consumer: "mcp:filesystem",
      purpose: "stdio-env:GITHUB_TOKEN",
      workspace: "/work/repo",
    }),
    /credential unavailable/,
  );
  await assert.rejects(
    broker.materialize({
      reference: "secret://github-pat",
      consumer: "mcp:github",
      purpose: "stdio-env:OTHER_TOKEN",
      workspace: "/work/repo",
    }),
    /credential unavailable/,
  );
  await assert.rejects(
    broker.materialize({
      reference: "secret://github-pat",
      consumer: "mcp:github",
      purpose: "stdio-env:GITHUB_TOKEN",
      workspace: "/work/other",
    }),
    /credential unavailable/,
  );
});

test("credential metadata never exposes stored secret material", async () => {
  const store = new InMemorySecretStore();
  await store.put("github-pat", "ghp_super_secret");
  const broker = createCredentialBroker(store, [githubCredential]);

  const metadata = await broker.list();
  assert.deepEqual(metadata, [{ ...githubCredential, configured: true }]);
  assert.equal(JSON.stringify(metadata).includes("ghp_super_secret"), false);
});

test("credential broker fails closed when a referenced secret is absent or reference is invalid", async () => {
  const broker = createCredentialBroker(new InMemorySecretStore(), [githubCredential]);
  const request = {
    consumer: "mcp:github",
    purpose: "stdio-env:GITHUB_TOKEN",
    workspace: "/work/repo",
  } as const;

  await assert.rejects(broker.materialize({ ...request, reference: "secret://github-pat" }), /credential unavailable/);
  await assert.rejects(broker.materialize({ ...request, reference: "github-pat" }), /credential unavailable/);
  await assert.rejects(broker.materialize({ ...request, reference: "secret://unknown" }), /credential unavailable/);
});

test("credential control plane rolls back set when metadata persistence fails", async () => {
  const store = new InMemorySecretStore();
  await store.put("github-pat", "old-secret");
  const controlPlane = createCredentialControlPlane(store, [githubCredential], async () => {
    throw new Error("metadata write failed");
  });
  const changed = { ...githubCredential, label: "Changed GitHub PAT" };

  await assert.rejects(controlPlane.set(changed, "new-secret"), /metadata write failed/);
  assert.deepEqual(await controlPlane.list(), [{ ...githubCredential, configured: true }]);
  assert.equal(await controlPlane.materialize({
    reference: "secret://github-pat",
    consumer: "mcp:github",
    purpose: "stdio-env:GITHUB_TOKEN",
    workspace: "/work/repo",
  }), "old-secret");
});

test("credential control plane rolls back revoke when metadata persistence fails", async () => {
  const store = new InMemorySecretStore();
  await store.put("github-pat", "old-secret");
  const controlPlane = createCredentialControlPlane(store, [githubCredential], async () => {
    throw new Error("metadata write failed");
  });

  await assert.rejects(controlPlane.revoke("github-pat"), /metadata write failed/);
  assert.deepEqual(await controlPlane.list(), [{ ...githubCredential, configured: true }]);
  assert.equal(await controlPlane.materialize({
    reference: "secret://github-pat",
    consumer: "mcp:github",
    purpose: "stdio-env:GITHUB_TOKEN",
    workspace: "/work/repo",
  }), "old-secret");
});
