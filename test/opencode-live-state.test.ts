import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchLiveMcp } from "../src/integrations/opencode-live-state.js";
import { opencodeServerDiscoveryPath, writeOpencodeServerDiscovery } from "../src/integrations/opencode-server-discovery.js";

/**
 * W074 follow-up — the live MCP data lane. Honest states only: a running
 * loopback gateway answers with the documented `{ data: Mcp.Server[] }`
 * envelope; everything else (no daemon, dead gateway, foreign host, bad
 * shape) is an explicit unavailable reason, never a fabricated connection.
 */

const discovery = {
  protocol: 1 as const,
  pid: process.pid,
  workspace: "/tmp/wf-live-ws",
  gatewayUrl: "http://127.0.0.1:4699",
  tuiUsername: "opencode",
  tuiPassword: "live-mcp-password",
};

function stubFetch(responses: Readonly<Record<string, unknown>>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    const body = responses[path];
    if (body === undefined) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("live MCP read: a live loopback gateway returns the server's own state", async (t) => {
  const stateHome = mkdtempSync(join(tmpdir(), "wf-live-state-"));
  t.after(() => rmSync(stateHome, { recursive: true, force: true }));
  writeOpencodeServerDiscovery(opencodeServerDiscoveryPath(stateHome, discovery.workspace), discovery);
  const fetchImpl = stubFetch({
    "/api/info": { version: "2.0.10" },
    "/api/mcp": { location: { directory: discovery.workspace }, data: [
      { name: "guard", status: { type: "connected" } },
      { name: "skills-mcp", status: "failed" },
    ] },
  });
  const state = await fetchLiveMcp({ workspace: discovery.workspace, stateHome, fetchImpl });
  assert.equal(state.live, true);
  assert.equal(state.live ? state.gatewayUrl : undefined, "http://127.0.0.1:4699");
  if (state.live) {
    assert.deepEqual(state.servers, [
      { name: "guard", status: "connected" },
      { name: "skills-mcp", status: "failed" },
    ], "object-form statuses map to their type; string statuses pass through");
  }
});

test("live MCP read: no daemon is an honest unavailable state, not a fabricated list", async (t) => {
  const stateHome = mkdtempSync(join(tmpdir(), "wf-live-state-"));
  t.after(() => rmSync(stateHome, { recursive: true, force: true }));
  const state = await fetchLiveMcp({ workspace: "/tmp/wf-live-nowhere", stateHome, fetchImpl: stubFetch({}) });
  assert.equal(state.live, false);
  if (!state.live) assert.match(state.reason, /no server topology daemon/);
});

test("live MCP read: a dead gateway and a foreign host fail closed with reasons", async (t) => {
  const stateHome = mkdtempSync(join(tmpdir(), "wf-live-state-"));
  t.after(() => rmSync(stateHome, { recursive: true, force: true }));
  // Dead gateway: discovery exists, the probe fails.
  writeOpencodeServerDiscovery(opencodeServerDiscoveryPath(stateHome, discovery.workspace), discovery);
  const dead = await fetchLiveMcp({ workspace: discovery.workspace, stateHome, fetchImpl: stubFetch({}) });
  assert.equal(dead.live, false);
  if (!dead.live) assert.match(dead.reason, /did not answer/);
  // Foreign host: refused before any request.
  const foreign = mkdtempSync(join(tmpdir(), "wf-live-state-"));
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  writeOpencodeServerDiscovery(opencodeServerDiscoveryPath(foreign, discovery.workspace), {
    ...discovery,
    gatewayUrl: "http://evil.example:4699",
  });
  const refused = await fetchLiveMcp({ workspace: discovery.workspace, stateHome: foreign, fetchImpl: stubFetch({ "/api/info": { version: "2.0.10" } }) });
  assert.equal(refused.live, false);
  if (!refused.live) assert.match(refused.reason, /not loopback/);
});
