import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadCredentialDefinitions, saveCredentialDefinitions } from "../src/integrations/credential-config.js";
import { createCredentialControlPlane, InMemorySecretStore } from "../src/integrations/credentials.js";

test("credential metadata survives restart without persisting secret values", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workflow-credentials-")), "credentials.json");
  const definitions = [{
    id: "github-pat", label: "GitHub PAT", kind: "api-key" as const,
    allowedConsumers: ["mcp:github"], allowedPurposes: ["stdio-env:GITHUB_TOKEN"], workspace: "/work/repo",
  }];
  saveCredentialDefinitions(definitions, path);

  assert.deepEqual(loadCredentialDefinitions(path), definitions);
  assert.equal(readFileSync(path, "utf8").includes("ghp_super_secret"), false);
});

test("reloaded credential policy can materialize a secret retained by the secret store", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "workflow-credentials-")), "credentials.json");
  const store = new InMemorySecretStore();
  const definitions = [{
    id: "github-pat", label: "GitHub PAT", kind: "api-key" as const,
    allowedConsumers: ["mcp:github"], allowedPurposes: ["stdio-env:GITHUB_TOKEN"], workspace: "/work/repo",
  }];
  await store.put("github-pat", "ghp_super_secret");
  saveCredentialDefinitions(definitions, path);

  const restartedControlPlane = createCredentialControlPlane(store, loadCredentialDefinitions(path));
  assert.equal(await restartedControlPlane.materialize({
    reference: "secret://github-pat",
    consumer: "mcp:github",
    purpose: "stdio-env:GITHUB_TOKEN",
    workspace: "/work/repo",
  }), "ghp_super_secret");
});

test("credential metadata fails closed on malformed persisted policy", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workflow-credentials-")), "credentials.json");
  saveCredentialDefinitions([], path);
  const malformed = [{ id: "github-pat", label: "GitHub", kind: "api-key" as const, allowedConsumers: [], allowedPurposes: [] }];
  assert.throws(() => saveCredentialDefinitions(malformed, path), /credential consumer required/);
});
