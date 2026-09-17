import assert from "node:assert/strict";
import { test } from "node:test";

import {
  gooseConfigYaml,
  gooseLaunchEnvironment,
  gooseProviderKind,
  gooseWorkspaceConfigTag,
  resolveGooseLaunch,
} from "../src/integrations/goose-agent-config.js";

/**
 * W048 unit tests for the goose agent-config composition (the probes earn
 * the enforcement classification; these pin the deterministic composition
 * surface itself).
 */

test("gooseProviderKind validates the workload fork fail-closed", () => {
  assert.equal(gooseProviderKind({}), "openrouter");
  assert.equal(gooseProviderKind({ WORKFLOW_GOOSE_PROVIDER: "azure_foundry" }), "azure_foundry");
  assert.throws(() => gooseProviderKind({ WORKFLOW_GOOSE_PROVIDER: "bedrock" }), /must be "openrouter" or "azure_foundry"/);
});

test("resolveGooseLaunch: override must exist; PATH fallback; neither throws actionable", () => {
  assert.throws(() => resolveGooseLaunch({ envBinOverride: "/no/such/goose", gooseOnPath: undefined }), /WORKFLOW_GOOSE_BIN does not exist/);
  assert.throws(() => resolveGooseLaunch({ envBinOverride: undefined, gooseOnPath: undefined }), /goose is not on PATH/);
  assert.deepEqual(resolveGooseLaunch({ envBinOverride: undefined, gooseOnPath: "/usr/local/bin/goose" }), { executable: "/usr/local/bin/goose", args: ["acp"] });
});

test("gooseLaunchEnvironment composes the hub-owned approve profile for OpenRouter through the proxy", () => {
  const environment = gooseLaunchEnvironment({
    provider: "openrouter",
    configRoot: "/tmp/runtime-root",
    proxyUrl: "http://127.0.0.1:45999",
    env: { PATH: "/usr/bin", HOME: "/home/hunter" },
  });
  assert.equal(environment.GOOSE_MODE, "approve", "mutating tools must cross session/request_permission");
  assert.equal(environment.GOOSE_TELEMETRY_ENABLED, "false");
  assert.equal(environment.GOOSE_PATH_ROOT, "/tmp/runtime-root");
  assert.equal(environment.GOOSE_PROVIDER, "openrouter");
  assert.equal(environment.GOOSE_MODEL, "openrouter/auto", "the openrouter default matches the sibling metered paths");
  assert.equal(environment.OPENROUTER_HOST, "http://127.0.0.1:45999", "OPENROUTER_HOST is the provider ROOT (live-run evidence: goose appends /api/v1 itself)");
  assert.equal(environment.OPENROUTER_API_KEY, "workflow-metered", "only the placeholder credential enters the boundary");
  // An explicit operator model wins over the default.
  const explicit = gooseLaunchEnvironment({
    provider: "openrouter",
    configRoot: "/tmp/runtime-root",
    proxyUrl: "http://127.0.0.1:45999",
    env: { PATH: "/usr/bin", HOME: "/home/hunter", WORKFLOW_GOOSE_MODEL: "qwen/qwen3-coder" },
  });
  assert.equal(explicit.GOOSE_MODEL, "qwen/qwen3-coder");
});

test("gooseLaunchEnvironment composes azure_foundry direct with the required env, and refuses missing pieces", () => {
  const environment = gooseLaunchEnvironment({
    provider: "azure_foundry",
    configRoot: "/tmp/runtime-root",
    proxyUrl: undefined,
    env: {
      PATH: "/usr/bin",
      HOME: "/home/hunter",
      AZURE_FOUNDRY_ENDPOINT: "https://foundry.example/api/projects/p",
      AZURE_FOUNDRY_API_KEY: "probe-key",
      AZURE_FOUNDRY_MODEL: "gpt-test",
    },
  });
  assert.equal(environment.GOOSE_PROVIDER, "azure_foundry");
  assert.equal(environment.AZURE_FOUNDRY_ENDPOINT, "https://foundry.example/api/projects/p");
  assert.equal(environment.AZURE_FOUNDRY_API_KEY, "probe-key");
  assert.equal(environment.AZURE_FOUNDRY_MODEL, "gpt-test");
  assert.equal(environment.GOOSE_MODEL, "gpt-test", "the azure model carries goose's model resolution");
  assert.equal("OPENROUTER_HOST" in environment, false, "the azure path never composes the OpenRouter proxy");
  assert.throws(
    () => gooseLaunchEnvironment({ provider: "azure_foundry", configRoot: "/r", proxyUrl: undefined, env: { PATH: "/usr/bin", HOME: "/h", AZURE_FOUNDRY_API_KEY: "k", AZURE_FOUNDRY_MODEL: "m" } }),
    /requires AZURE_FOUNDRY_ENDPOINT/,
  );
  assert.throws(
    () => gooseLaunchEnvironment({ provider: "azure_foundry", configRoot: "/r", proxyUrl: undefined, env: { PATH: "/usr/bin", HOME: "/h", AZURE_FOUNDRY_ENDPOINT: "https://e", AZURE_FOUNDRY_MODEL: "m" } }),
    /requires AZURE_FOUNDRY_API_KEY/,
  );
  assert.throws(
    () => gooseLaunchEnvironment({ provider: "azure_foundry", configRoot: "/r", proxyUrl: undefined, env: { PATH: "/usr/bin", HOME: "/h", AZURE_FOUNDRY_ENDPOINT: "https://e", AZURE_FOUNDRY_API_KEY: "k" } }),
    /requires a model/,
  );
});

test("gooseConfigYaml: no mount without both skills surfaces; the documented map-shaped extension schema", () => {
  assert.equal(gooseConfigYaml({}), undefined);
  assert.equal(gooseConfigYaml({ skillsServerScript: "/only/server.js" }), undefined);
  const configYaml = gooseConfigYaml({ skillsServerScript: "/toolbox/server.js", skillsDir: "/skills" });
  assert.ok(configYaml !== undefined);
  assert.match(configYaml, /extensions:\n[ ]{2}skills-mcp:/, "extensions is a map keyed by name (the documented schema)");
  assert.match(configYaml, /type: stdio/);
  assert.match(configYaml, /enabled: true/);
  assert.match(configYaml, /name: skills-mcp/);
  assert.match(configYaml, /cmd: "/);
  assert.match(configYaml, /args: \["\/toolbox\/server.js"\]/);
  assert.match(configYaml, /SKILLS_MCP_DIR/);
});

test("gooseWorkspaceConfigTag: stable per workspace, distinct across workspaces, pruner-escaping shape (W049)", () => {
  const tag = gooseWorkspaceConfigTag("/home/hunter/Workflow");
  assert.equal(tag, gooseWorkspaceConfigTag("/home/hunter/Workflow"), "the same workspace must compose the same config root across restarts (goose's session store lives under GOOSE_PATH_ROOT)");
  assert.notEqual(tag, gooseWorkspaceConfigTag("/home/hunter/other-repo"), "different workspaces must not share a session store");
  assert.match(tag, /^ws-[0-9a-f]{12}$/);
  assert.doesNotMatch(tag, /^config\.\d+/, "the tag must escape the stale-runtime pruner's config.<pid> shape so a live session store is never swept");
});
