import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ProcessContainment } from "../src/containment/contracts.js";
import {
  DEFAULT_OPENCODE_MODEL,
  globalOpencodeBinary,
  OPENCODE_METERED_PROVIDER_ID,
  OPENCODE_V2_METERED_PROVIDER_ID,
} from "../src/integrations/opencode-agent-config.js";
import { opencodeMajorVersion } from "../src/integrations/acp-runtime.js";
import { planeLspConfig } from "../src/integrations/plane-lsp.js";
import { loadFleetManifest } from "../src/integrations/fleet-payload.js";
import type { ModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import {
  createOpencodeServerRuntime,
  installVendoredFleet,
  opencodeServerArgs,
  opencodeServerStateDir,
  opencodeServerWorkspaceTag,
  parseListeningUrl,
} from "../src/integrations/opencode-server-runtime.js";

/**
 * W071 — the Workflow-owned OpenCode server runtime.
 *
 * Pure helpers run everywhere; the launch test injects a boundary that runs
 * the real `opencode serve` directly (so it needs no Bubblewrap and no model
 * key) and asserts the hub-written config is the ruleset that was promised.
 */

const binary = globalOpencodeBinary();

test("W071 runtime: workspace tag is stable and workspace-specific", () => {
  const a = opencodeServerWorkspaceTag("/tmp/alpha");
  assert.equal(a, opencodeServerWorkspaceTag("/tmp/alpha"));
  assert.notEqual(a, opencodeServerWorkspaceTag("/tmp/beta"));
  assert.match(a, /^ws-[0-9a-f]{12}$/);
});

test("W071 runtime: state dir and serve args", () => {
  assert.equal(opencodeServerStateDir("/state", "/tmp/alpha"), join("/state", opencodeServerWorkspaceTag("/tmp/alpha")));
  assert.deepEqual(opencodeServerArgs(4096), ["serve", "--hostname", "127.0.0.1", "--port", "4096"]);
});

test("W071 runtime: parseListeningUrl extracts the bound URL", () => {
  assert.equal(parseListeningUrl("opencode server listening on http://127.0.0.1:4123\n"), "http://127.0.0.1:4123");
  assert.equal(parseListeningUrl("nothing here"), undefined);
});

test("runtime: installVendoredFleet deploys the vendored agents/commands into the hub-owned config dir (never docs)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "wf-fleet-cfg-"));
  try {
    const results = installVendoredFleet(configDir);
    const manifest = loadFleetManifest();
    const agents = manifest.entries.filter((entry) => entry.kind === "agent");
    const commands = manifest.entries.filter((entry) => entry.kind === "command");
    assert.ok(agents.length >= 4, "the vendored fleet carries its agents");
    assert.ok(commands.length >= 4, "the vendored fleet carries its commands");
    assert.equal(results.length, agents.length + commands.length, "only agent/command kinds install");
    for (const entry of [...agents, ...commands]) {
      const flat = entry.kind === "agent" ? "agents" : "commands";
      assert.ok(
        existsSync(join(configDir, "opencode", flat, entry.file)),
        `${entry.id} landed under the OpenCode config dir`,
      );
    }
    // The docs bundle is workspace-owned and must never land in the config dir.
    assert.ok(!existsSync(join(configDir, "opencode", "docs")), "docs are never written into the config dir");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("W071 runtime: launches through an injected boundary and writes the pinned ask ruleset", { skip: binary === undefined, timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-run-ws-"));
  const stateHome = mkdtempSync(join(tmpdir(), "wf-run-state-"));
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(stateHome, { recursive: true, force: true }); });

  const boundary: ProcessContainment = {
    isolation: "enforced",
    async execute() { throw new Error("not used"); },
    spawn(request) {
      // Test double: runs the executable directly (no bwrap), applying the
      // boundary's environment exactly as the real backend would.
      return spawn(request.executable, [...request.args], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        env: { ...process.env, ...request.environment },
      });
    },
  };
  const proxy = {
    url: "http://127.0.0.1:9/api/v1",
    metrics: () => ({ requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 }),
    close: async () => undefined,
  } as unknown as ModelUsageProxy;

  const runtime = await createOpencodeServerRuntime({
    workspace,
    stateHome,
    containment: boundary,
    apiKey: "test-key-not-used",
    createProxy: async () => proxy,
    model: "openrouter/auto",
    healthTimeoutMs: 30_000,
    // The plane LSP wire: the config composes the image-backed TypeScript
    // server. This launch proves the pinned opencode accepts the block (a bad
    // `lsp` shape hard-fails startup), and the assertion below pins the write.
    lsp: planeLspConfig(),
  });
  t.after(() => runtime.dispose());

  assert.match(runtime.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(runtime.workspace, workspace);
  // The generated client credential must never equal the upstream credential.
  assert.notEqual(runtime.password, "");

  const config = JSON.parse(readFileSync(join(runtime.stateDir, "config", "opencode", "opencode.json"), "utf8")) as {
    permission?: Record<string, string>;
    model?: string;
    provider?: Record<string, unknown>;
    providers?: Record<string, unknown>;
    lsp?: Record<string, { command?: readonly string[] }>;
  };
  assert.deepEqual(config.permission, { edit: "ask", bash: "ask", task: "ask", skill: "deny" });
  // LSP wire: the composed `lsp` block survives into the config opencode read
  // (and the daemon accepted it — the server reached healthy above).
  assert.deepEqual(config.lsp, planeLspConfig(), "the lsp block must ride the hub-written config");
  // Deploy-time fleet install: the vendored agents/commands land in the
  // isolated hub-owned config dir (the plane's `opencode serve` reads
  // `$XDG_CONFIG_HOME/opencode`, which is this dir — not the operator's home).
  assert.ok(
    existsSync(join(runtime.stateDir, "config", "opencode", "agents", "reviewer.md")),
    "the vendored reviewer agent is installed into the hub-owned config dir",
  );
  assert.ok(
    existsSync(join(runtime.stateDir, "config", "opencode", "commands", "review-diff.md")),
    "the vendored review-diff command is installed into the hub-owned config dir",
  );
  // Version-aware (mirrors the ACP lane, PR #427): v1 keeps the historical
  // provider/npm/options shape; v2 emits providers/package|settings reusing the
  // built-in `openrouter` provider, because a config-defined custom provider is
  // not registered into the v2 model catalog.
  const major = binary === undefined ? undefined : await opencodeMajorVersion(binary);
  const v2 = major !== undefined && major >= 2;
  if (v2) {
    assert.equal(config.model, `${OPENCODE_V2_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`);
    assert.equal(config.provider, undefined);
    assert.notEqual(config.providers?.[OPENCODE_V2_METERED_PROVIDER_ID], undefined);
  } else {
    assert.equal(config.model, `${OPENCODE_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`);
    assert.notEqual(config.provider?.[OPENCODE_METERED_PROVIDER_ID], undefined);
  }

  // Health contract is version-tolerant (2026-09-20): v1.x answers
  // `/global/health` with JSON `{ healthy: true }`; v2.x serves the SPA on
  // bare paths and the JSON API under `/api/*`, where `/api/info` is the
  // health signal. Either shape proves the server is up under auth.
  const authHeaders = { authorization: `Basic ${Buffer.from(`${runtime.username}:${runtime.password}`).toString("base64")}` };
  const legacyHealth = await fetch(`${runtime.url}/global/health`, { headers: authHeaders });
  assert.equal(legacyHealth.status, 200);
  const legacyBody = await legacyHealth.text();
  let healthy: boolean;
  try {
    healthy = (JSON.parse(legacyBody) as { healthy?: unknown }).healthy === true;
  } catch {
    healthy = false; // SPA fallback HTML — the v2 shape, checked next.
  }
  if (!healthy) {
    const info = await fetch(`${runtime.url}/api/info`, { headers: authHeaders });
    assert.equal(info.status, 200, "neither health contract answered: server is not healthy");
    assert.match((await info.json() as { version?: unknown }).version as string, /^\d/, "the v2 info payload must carry a version");
  }
});

test("W-c1 runtime: mountFullToolbox + settings wire the whole toolbox and operator MCP servers into the hub-written config", { skip: binary === undefined, timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-run-ws-"));
  const stateHome = mkdtempSync(join(tmpdir(), "wf-run-state-"));
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(stateHome, { recursive: true, force: true }); });

  const boundary: ProcessContainment = {
    isolation: "enforced",
    async execute() { throw new Error("not used"); },
    spawn(request) {
      return spawn(request.executable, [...request.args], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        env: { ...process.env, ...request.environment },
      });
    },
  };
  const proxy = {
    url: "http://127.0.0.1:9/api/v1",
    metrics: () => ({ requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 }),
    close: async () => undefined,
  } as unknown as ModelUsageProxy;

  const runtime = await createOpencodeServerRuntime({
    workspace,
    stateHome,
    containment: boundary,
    apiKey: "test-key-not-used",
    createProxy: async () => proxy,
    model: "openrouter/auto",
    healthTimeoutMs: 30_000,
    mountFullToolbox: true,
    settings: {
      version: 1,
      agents: {},
      mcpServers: [
        { name: "operator-server", enabled: true, transport: "stdio", command: "node", args: ["/tmp/op.js"] },
        { name: "disabled-server", enabled: false, transport: "stdio", command: "node" },
      ],
    },
  });
  t.after(() => runtime.dispose());

  const config = JSON.parse(readFileSync(join(runtime.stateDir, "config", "opencode", "opencode.json"), "utf8")) as {
    mcp?: Record<string, { command?: readonly string[]; type?: string }>;
  };
  const mcp = config.mcp ?? {};
  // The full built toolbox is mounted (spec §11), not just the declared floor.
  assert.equal(mcp["workflow-guard-mcp"]?.type, "local", "guard connector must be mounted");
  assert.equal(mcp["git-intelligence-mcp"]?.type, "local", "the full toolbox must mount beyond the declared floor");
  assert.equal(mcp["project-memory-mcp"]?.type, "local", "the full toolbox must mount beyond the declared floor");
  // Operator-enabled servers ride the same config; disabled ones never do.
  assert.deepEqual(mcp["operator-server"]?.command, ["node", "/tmp/op.js"]);
  assert.equal(mcp["disabled-server"], undefined, "an operator-disabled server must never reach the config");
});

// NOTE: this test's discriminating power assumes the toolbox `dist` builds are
// present (as they are in this repo after `npm run toolbox:build`/`toolbox:verify`,
// which the sibling mountFullToolbox test also relies on). The negative
// assertions would pass vacuously on an unbuilt tree; the positive sibling test
// is what pins the builds are there.
test("runtime: the default lane composes NO toolbox connectors when no skills store resolves (parity with before the option)", { skip: binary === undefined, timeout: 60_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-run-ws-"));
  const stateHome = mkdtempSync(join(tmpdir(), "wf-run-state-"));
  const absentSkillsDir = join(mkdtempSync(join(tmpdir(), "wf-run-nostore-")), "does-not-exist");
  const priorSkillsDir = process.env.SKILLS_MCP_DIR;
  process.env.SKILLS_MCP_DIR = absentSkillsDir;
  t.after(() => {
    if (priorSkillsDir === undefined) delete process.env.SKILLS_MCP_DIR;
    else process.env.SKILLS_MCP_DIR = priorSkillsDir;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
  });

  const boundary: ProcessContainment = {
    isolation: "enforced",
    async execute() { throw new Error("not used"); },
    spawn(request) {
      return spawn(request.executable, [...request.args], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        env: { ...process.env, ...request.environment },
      });
    },
  };
  const proxy = {
    url: "http://127.0.0.1:9/api/v1",
    metrics: () => ({ requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 }),
    close: async () => undefined,
  } as unknown as ModelUsageProxy;

  const runtime = await createOpencodeServerRuntime({
    workspace,
    stateHome,
    containment: boundary,
    apiKey: "test-key-not-used",
    createProxy: async () => proxy,
    model: "openrouter/auto",
    healthTimeoutMs: 30_000,
  });
  t.after(() => runtime.dispose());

  const config = JSON.parse(readFileSync(join(runtime.stateDir, "config", "opencode", "opencode.json"), "utf8")) as {
    mcp?: Record<string, unknown>;
    skills?: unknown;
  };
  const mcp = config.mcp ?? {};
  // No skills store → no skills mount → no declared-floor connectors and no
  // full-toolbox mounts: the pre-option behavior, pinned.
  assert.equal(mcp["workflow-guard-mcp"], undefined, "the declared floor must not mount without a skills store on the default lane");
  assert.equal(mcp["git-intelligence-mcp"], undefined, "the full toolbox must not mount on the default lane");
  assert.equal(config.skills, undefined, "no skills mount is composed without a store");
});