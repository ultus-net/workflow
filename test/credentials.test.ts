import assert from "node:assert/strict";
import test from "node:test";

import {
  createCredentialBroker,
  createCredentialControlPlane,
  InMemorySecretStore,
  type CredentialDefinition,
  type CredentialRequest,
  type SecretStore,
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

/** Store wrapper whose next delete/put can be scripted to fail, to exercise rollback-op failure. */
class FlakySecretStore implements SecretStore {
  readonly #backing: InMemorySecretStore;
  #failDeleteOnce = false;
  #failPutOnce = false;

  constructor(backing: InMemorySecretStore) {
    this.#backing = backing;
  }

  failNextDelete(): void {
    this.#failDeleteOnce = true;
  }

  failNextPut(): void {
    this.#failPutOnce = true;
  }

  async has(id: string): Promise<boolean> {
    return this.#backing.has(id);
  }

  async get(id: string): Promise<string | undefined> {
    return this.#backing.get(id);
  }

  async put(id: string, value: string): Promise<void> {
    if (this.#failPutOnce) {
      this.#failPutOnce = false;
      throw new Error("store put failed");
    }
    return this.#backing.put(id, value);
  }

  async delete(id: string): Promise<void> {
    if (this.#failDeleteOnce) {
      this.#failDeleteOnce = false;
      throw new Error("store delete failed");
    }
    return this.#backing.delete(id);
  }
}

const materializeGithubPat = (controlPlane: { materialize(request: CredentialRequest): Promise<string> }) =>
  controlPlane.materialize({
    reference: "secret://github-pat",
    consumer: "mcp:github",
    purpose: "stdio-env:GITHUB_TOKEN",
    workspace: "/work/repo",
  });

test("set rollback that cannot restore the previous value fails closed", async () => {
  const backing = new InMemorySecretStore();
  await backing.put("github-pat", "old-secret");
  const store = new FlakySecretStore(backing);
  const controlPlane = createCredentialControlPlane(store, [githubCredential], async () => {
    // The compensating restore put fails; the fallback delete succeeds.
    store.failNextPut();
    throw new Error("metadata write failed");
  });

  await assert.rejects(
    controlPlane.set({ ...githubCredential, label: "Changed GitHub PAT" }, "new-secret"),
    (error: unknown) => {
      const message = (error as Error).message;
      return /metadata write failed/.test(message)
        && /store put failed/.test(message)
        && /unavailable \(fail-closed\) — re-set it/.test(message);
    },
  );
  assert.equal(await backing.get("github-pat"), undefined, "the new value must not stay servable under the old contract");
  await assert.rejects(materializeGithubPat(controlPlane), /credential unavailable/);
  assert.deepEqual(await controlPlane.list(), [{ ...githubCredential, configured: false }]);
});

test("set rollback where every compensating op fails reports divergence and fails the live plane closed", async () => {
  const backing = new InMemorySecretStore();
  await backing.put("github-pat", "old-secret");
  const store = new FlakySecretStore(backing);
  const controlPlane = createCredentialControlPlane(store, [githubCredential], async () => {
    store.failNextPut();
    store.failNextDelete();
    throw new Error("metadata write failed");
  });

  await assert.rejects(
    controlPlane.set({ ...githubCredential, label: "Changed GitHub PAT" }, "new-secret"),
    (error: unknown) => {
      const failure = error as Error;
      return /state diverged/.test(failure.message)
        && /metadata write failed/.test(failure.message)
        && /store put failed/.test(failure.message)
        && /re-set the credential/.test(failure.message)
        && failure.cause instanceof Error
        && /store put failed/.test((failure.cause as Error).message);
    },
  );
  assert.equal(await backing.get("github-pat"), "new-secret", "the store keeps the value; remediation is a re-set");
  await assert.rejects(materializeGithubPat(controlPlane), /credential unavailable/, "live materialization must fail closed");
  assert.deepEqual(await controlPlane.list(), [], "the rolled-back definition is dropped from the live plane");
});

test("set rollback for a brand-new credential whose cleanup delete fails reports divergence", async () => {
  const backing = new InMemorySecretStore();
  const store = new FlakySecretStore(backing);
  const controlPlane = createCredentialControlPlane(store, [], async () => {
    store.failNextDelete();
    throw new Error("metadata write failed");
  });

  await assert.rejects(
    controlPlane.set(githubCredential, "new-secret"),
    (error: unknown) => {
      const failure = error as Error;
      return /state diverged/.test(failure.message) && failure.cause instanceof Error;
    },
  );
  assert.equal(await backing.get("github-pat"), "new-secret");
  await assert.rejects(materializeGithubPat(controlPlane), /credential unavailable/);
  assert.deepEqual(await controlPlane.list(), []);
});

test("revoke rollback that cannot restore the previous secret reports fail-closed unavailability", async () => {
  const backing = new InMemorySecretStore();
  await backing.put("github-pat", "old-secret");
  const store = new FlakySecretStore(backing);
  const controlPlane = createCredentialControlPlane(store, [githubCredential], async () => {
    store.failNextPut();
    throw new Error("metadata write failed");
  });

  await assert.rejects(
    controlPlane.revoke("github-pat"),
    (error: unknown) => {
      const failure = error as Error;
      return /metadata write failed/.test(failure.message)
        && /unavailable \(fail-closed\) — re-set it/.test(failure.message)
        && failure.cause instanceof Error;
    },
  );
  assert.equal(await backing.get("github-pat"), undefined, "the secret stays deleted: fail-closed, not wrong-value");
  await assert.rejects(materializeGithubPat(controlPlane), /credential unavailable/);
  assert.deepEqual(await controlPlane.list(), [{ ...githubCredential, configured: false }], "metadata is rolled back");
});
