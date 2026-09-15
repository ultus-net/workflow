import assert from "node:assert/strict";
import test from "node:test";

import { createCredentialBroker, InMemorySecretStore } from "../src/integrations/credentials.js";
import { materializeMcpEnvironment } from "../src/integrations/credential-mcp.js";

test("MCP environment contains only explicitly brokered credential bindings", async () => {
  const store = new InMemorySecretStore();
  await store.put("github-pat", "ghp_super_secret");
  const broker = createCredentialBroker(store, [{
    id: "github-pat",
    label: "GitHub PAT",
    kind: "api-key",
    allowedConsumers: ["mcp:github"],
    allowedPurposes: ["stdio-env:GITHUB_TOKEN"],
    workspace: "/work/repo",
  }]);

  const previous = process.env.WORKFLOW_AMBIENT_TEST_SECRET;
  process.env.WORKFLOW_AMBIENT_TEST_SECRET = "must-not-inherit";
  try {
    const env = await materializeMcpEnvironment(broker, {
      consumer: "mcp:github",
      workspace: "/work/repo",
      bindings: [{ variable: "GITHUB_TOKEN", reference: "secret://github-pat" }],
    });

    assert.equal(env["WORKFLOW_AMBIENT_TEST_SECRET"], undefined);
    assert.deepEqual(env, { GITHUB_TOKEN: "ghp_super_secret" });
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_AMBIENT_TEST_SECRET;
    else process.env.WORKFLOW_AMBIENT_TEST_SECRET = previous;
  }
});

test("MCP binding rejects unsafe environment variable names", async () => {
  const broker = createCredentialBroker(new InMemorySecretStore(), []);
  await assert.rejects(
    materializeMcpEnvironment(broker, {
      consumer: "mcp:github",
      workspace: "/work/repo",
      bindings: [{ variable: "BAD=NAME", reference: "secret://github-pat" }],
    }),
    /invalid MCP credential environment variable/,
  );
});
