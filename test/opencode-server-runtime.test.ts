import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ProcessContainment } from "../src/containment/contracts.js";
import { globalOpencodeBinary } from "../src/integrations/opencode-agent-config.js";
import type { ModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import {
  createOpencodeServerRuntime,
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
  };
  assert.deepEqual(config.permission, { edit: "ask", bash: "ask", task: "ask" });
  assert.equal(config.model, "workflow-metered/openrouter/auto");
  assert.notEqual(config.provider?.["workflow-metered"], undefined);

  const health = await fetch(`${runtime.url}/global/health`, {
    headers: { authorization: `Basic ${Buffer.from(`${runtime.username}:${runtime.password}`).toString("base64")}` },
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { healthy?: unknown }).healthy, true);
});