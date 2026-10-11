import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemorySecretStore, type SecretStore } from "../src/integrations/credentials.js";
import {
  PROVIDER_TOKEN_ENV_NAMES,
  PROVIDER_TOKEN_SECRET_NAMES,
  providerEnvWithStoredTokens,
} from "../src/integrations/provider-token.js";

// W-custody: the board provider PATs (GitHub + Azure DevOps) used to ride the
// hub's process environment. On the plane the hub shares one uid with every
// agent tool process, so a PAT there is readable at /proc/<pid>/environ. The
// provider-token seam sources the PATs from the secret store (authoritative)
// and scrubs the ambient token vars. These tests pin the custody discipline;
// the doctor pins the exposure warning. Presence only — a value is never
// echoed anywhere the check reads.

test("provider-token seam: unset FROM is byte-identical to the ambient env", async () => {
  const env: NodeJS.ProcessEnv = { WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "t" };
  const effective = await providerEnvWithStoredTokens({
    env,
    // The store must NOT be consulted when the seam is unset.
    storeFor: () => { throw new Error("store must not be consulted when the seam is unset"); },
  });
  assert.equal(effective, env, "returns the SAME object reference when unset");
  assert.equal(effective.WORKFLOW_GITHUB_TOKEN, "t");
});

test("provider-token seam: a set FROM sources the PATs from the store", async () => {
  const store = new InMemorySecretStore();
  await store.put(PROVIDER_TOKEN_SECRET_NAMES.github, "vault-gh");
  await store.put(PROVIDER_TOKEN_SECRET_NAMES.azure_devops, "vault-ado");
  const effective = await providerEnvWithStoredTokens({
    env: { WORKFLOW_BOARD_TOKEN_FROM: "azure-kv", WORKFLOW_GITHUB_REPO: "o/r" },
    storeFor: (backend) => {
      assert.equal(backend, "azure-kv");
      return store;
    },
  });
  assert.equal(effective.WORKFLOW_GITHUB_TOKEN, "vault-gh");
  assert.equal(effective.WORKFLOW_AZURE_DEVOPS_TOKEN, "vault-ado");
  // Non-secret declaration vars are carried through untouched.
  assert.equal(effective.WORKFLOW_GITHUB_REPO, "o/r");
});

test("provider-token seam: the store is AUTHORITATIVE — a lingering ambient token never wins", async () => {
  // The uid-shared leak the seam exists to close: with FROM set, an ambient
  // token must NOT short-circuit the store (that would silently defeat the
  // scrubbing).
  const store = new InMemorySecretStore();
  await store.put(PROVIDER_TOKEN_SECRET_NAMES.github, "vault-gh");
  const effective = await providerEnvWithStoredTokens({
    env: {
      WORKFLOW_BOARD_TOKEN_FROM: "azure-kv",
      WORKFLOW_GITHUB_TOKEN: "ambient-leak",
      WORKFLOW_AZURE_DEVOPS_TOKEN: "ambient-ado-leak",
    },
    storeFor: () => store,
  });
  assert.equal(effective.WORKFLOW_GITHUB_TOKEN, "vault-gh", "stored token replaces the ambient one");
  // The ADO lane has no stored secret: the ambient ADO token is SCRUBBED, so
  // the lane is unconfigured (fail closed) rather than falling back to a
  // uid-shared env.
  assert.equal(effective.WORKFLOW_AZURE_DEVOPS_TOKEN, undefined);
});

test("provider-token seam: an unknown FROM backend fails closed at parse", async () => {
  await assert.rejects(
    () => providerEnvWithStoredTokens({
      env: { WORKFLOW_BOARD_TOKEN_FROM: "sneaky-vault" },
      storeFor: () => { throw new Error("store must not be constructed for an unknown backend"); },
    }),
    /not a known backend/,
  );
});

test("provider-token seam: the token env names map to the documented secret names", () => {
  assert.equal(PROVIDER_TOKEN_ENV_NAMES.github, "WORKFLOW_GITHUB_TOKEN");
  assert.equal(PROVIDER_TOKEN_ENV_NAMES.azure_devops, "WORKFLOW_AZURE_DEVOPS_TOKEN");
  assert.equal(PROVIDER_TOKEN_SECRET_NAMES.github, "workflow-github-token");
  assert.equal(PROVIDER_TOKEN_SECRET_NAMES.azure_devops, "workflow-azure-devops-token");
});

/** A SecretStore that records which ids were read, to prove no read when unset. */
function recordingStore(): { store: SecretStore; reads: string[] } {
  const reads: string[] = [];
  const store: SecretStore = {
    has: async () => false,
    get: async (id) => { reads.push(id); return undefined; },
    put: async () => undefined,
    delete: async () => undefined,
  };
  return { store, reads };
}

test("provider-token seam: the store is read for both lanes, by their documented names", async () => {
  const { store, reads } = recordingStore();
  await providerEnvWithStoredTokens({ env: { WORKFLOW_BOARD_TOKEN_FROM: "keyring" }, storeFor: () => store });
  assert.deepEqual([...reads].sort(), [PROVIDER_TOKEN_SECRET_NAMES.azure_devops, PROVIDER_TOKEN_SECRET_NAMES.github].sort());
});
