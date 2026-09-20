import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openStockWebTab } from "../src/cli/web-launch.js";
import { opencodeServerDiscoveryPath, writeOpencodeServerDiscovery } from "../src/integrations/opencode-server-discovery.js";

/**
 * W074a gap fix: the stock opencode web UI surfaces as a `workflow web` tab
 * ONLY when the server topology is already running for the workspace. No
 * daemon → no tab, no autostart, no fabricated URL; a foreign-host discovery
 * is refused (fail closed); the opened URL is the gateway's, and the client
 * (TUI) credential is what is stated — never the upstream one.
 */

const discovery = {
  protocol: 1 as const,
  pid: process.pid,
  workspace: "/tmp/wf-tab-ws",
  gatewayUrl: "http://127.0.0.1:4699",
  tuiUsername: "opencode",
  tuiPassword: "tab-test-password",
};

const healthyFetch: typeof fetch = (async (input: Parameters<typeof fetch>[0]) => {
  void input;
  return new Response(JSON.stringify({ version: "2.0.10" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

test("the stock web UI tab opens against a live loopback gateway discovery", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "wf-tab-state-"));
  try {
    const discoveryPath = opencodeServerDiscoveryPath(stateHome, discovery.workspace);
    writeOpencodeServerDiscovery(discoveryPath, discovery);
    const opened: string[] = [];
    const tab = await openStockWebTab({
      workspace: discovery.workspace,
      stateHome,
      fetchImpl: healthyFetch,
      openImpl: async (url) => { opened.push(url); return true; },
    });
    assert.notEqual(tab, undefined, "a live loopback discovery must surface the tab");
    assert.equal(tab?.url, "http://127.0.0.1:4699/");
    assert.equal(tab?.username, "opencode");
    assert.deepEqual(opened, ["http://127.0.0.1:4699/"]);
  } finally {
    rmSync(stateHome, { recursive: true, force: true });
  }
});

test("the stock web UI tab stays quiet when no daemon runs", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "wf-tab-state-"));
  try {
    const opened: string[] = [];
    const tab = await openStockWebTab({
      workspace: "/tmp/wf-tab-nowhere",
      stateHome,
      fetchImpl: healthyFetch,
      openImpl: async (url) => { opened.push(url); return true; },
    });
    assert.equal(tab, undefined, "no discovery → no tab, no fabrication");
    assert.deepEqual(opened, []);
  } finally {
    rmSync(stateHome, { recursive: true, force: true });
  }
});

test("a foreign-host gateway discovery is refused", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "wf-tab-state-"));
  try {
    const discoveryPath = opencodeServerDiscoveryPath(stateHome, discovery.workspace);
    mkdirSync(stateHome, { recursive: true });
    writeOpencodeServerDiscovery(discoveryPath, { ...discovery, gatewayUrl: "http://evil.example:4699" });
    const opened: string[] = [];
    const tab = await openStockWebTab({
      workspace: discovery.workspace,
      stateHome,
      fetchImpl: healthyFetch,
      openImpl: async (url) => { opened.push(url); return true; },
    });
    assert.equal(tab, undefined, "a non-loopback discovery must fail closed");
    assert.deepEqual(opened, []);
  } finally {
    rmSync(stateHome, { recursive: true, force: true });
  }
});
