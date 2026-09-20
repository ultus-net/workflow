import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compactSession, fetchLiveMcp, fetchSessionStats } from "../src/integrations/opencode-live-state.js";
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

test("session stats: the documented aggregate maps defensively to the live state", async (t) => {
  const stateHome = mkdtempSync(join(tmpdir(), "wf-live-state-"));
  t.after(() => rmSync(stateHome, { recursive: true, force: true }));
  writeOpencodeServerDiscovery(opencodeServerDiscoveryPath(stateHome, discovery.workspace), discovery);
  // The recon-verified v2.0.10 aggregate shape, plus junk the mapper must not trust.
  const fetchImpl = stubFetch({
    "/api/info": { version: "2.0.10" },
    "/api/experimental/session/stats": { data: {
      range: { from: 1, to: 2 },
      sessions: 3,
      subagents: 2,
      prompts: 7,
      steps: 12,
      tokens: { input: 1000, output: 2000, reasoning: 300, cache: { read: 50, write: 60 } },
      cost: 0.1234,
      tools: { mode: "summary", totals: { calls: 9, succeeded: 7, failed: 1, unfinished: 1 } },
      activeDays: 2,
      notANumber: "garbage",
    } },
  });
  const state = await fetchSessionStats({ workspace: discovery.workspace, stateHome, fetchImpl });
  assert.equal(state.live, true);
  if (state.live) {
    assert.equal(state.gatewayUrl, "http://127.0.0.1:4699");
    assert.deepEqual(state.stats, {
      sessions: 3,
      prompts: 7,
      steps: 12,
      tokens: { input: 1000, output: 2000, reasoning: 300, cacheRead: 50, cacheWrite: 60 },
      cost: 0.1234,
      tools: { calls: 9, succeeded: 7, failed: 1, unfinished: 1 },
    });
  }
});

test("session stats: unavailable without a daemon, and the reason is the value", async (t) => {
  const stateHome = mkdtempSync(join(tmpdir(), "wf-live-state-"));
  t.after(() => rmSync(stateHome, { recursive: true, force: true }));
  const state = await fetchSessionStats({ workspace: "/tmp/wf-live-nowhere", stateHome, fetchImpl: stubFetch({}) });
  assert.equal(state.live, false);
  if (!state.live) assert.match(state.reason, /no server topology daemon.*session stats/s);
});

// W082: the operator-triggered manual compaction (documented
// POST /api/session/{sessionID}/compact). Per the documented contract the
// route durably ADMITS the request — { data: Session.Inbox.Compaction } — so
// a 200 is honestly "queued", never "summarized now".
test("compaction: a live gateway admits the request and reports the inbox id", async (t) => {
  const stateHome = mkdtempSync(join(tmpdir(), "wf-live-state-"));
  t.after(() => rmSync(stateHome, { recursive: true, force: true }));
  writeOpencodeServerDiscovery(opencodeServerDiscoveryPath(stateHome, discovery.workspace), discovery);
  const fetchImpl = stubFetch({
    "/api/info": { version: "2.0.10" },
    "/api/session/ses_probe_1/compact": { data: { id: "msg_c1", sessionID: "ses_probe_1", type: "compaction", time: { created: 1 }, payload: {}, delivery: "next" } },
  });
  const state = await compactSession({ workspace: discovery.workspace, stateHome, sessionId: "ses_probe_1", fetchImpl });
  assert.equal(state.compacted, true);
  if (state.compacted) assert.equal(state.inboxId, "msg_c1");
});

test("compaction: honest failures — unavailable message, gateway refusal, no daemon, malformed id", async (t) => {
  const stateHome = mkdtempSync(join(tmpdir(), "wf-live-state-"));
  t.after(() => rmSync(stateHome, { recursive: true, force: true }));
  writeOpencodeServerDiscovery(opencodeServerDiscoveryPath(stateHome, discovery.workspace), discovery);
  // The server's own message surfaces verbatim (documented compaction.unavailable).
  const refused = (async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/info") return new Response(JSON.stringify({ version: "2.0.10" }), { status: 200, headers: { "content-type": "application/json" } });
    if (path.endsWith("/compact")) {
      return new Response(JSON.stringify({ data: { code: "COMPACTION_UNAVAILABLE", message: "Nothing to compact yet" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const unavailable = await compactSession({ workspace: discovery.workspace, stateHome, sessionId: "ses_probe_1", fetchImpl: refused });
  assert.equal(unavailable.compacted, false);
  if (!unavailable.compacted) assert.match(unavailable.reason, /Nothing to compact yet/);

  const hardFail = await compactSession({ workspace: discovery.workspace, stateHome, sessionId: "ses_probe_1", fetchImpl: stubFetch({ "/api/info": { version: "2.0.10" } }) });
  assert.equal(hardFail.compacted, false);
  if (!hardFail.compacted) assert.match(hardFail.reason, /refused the compaction request/);

  const noDaemon = await compactSession({ workspace: "/tmp/wf-live-nowhere", stateHome, sessionId: "ses_probe_1", fetchImpl: stubFetch({}) });
  assert.equal(noDaemon.compacted, false);
  if (!noDaemon.compacted) assert.match(noDaemon.reason, /no server topology daemon.*compaction/s);

  const malformed = await compactSession({ workspace: discovery.workspace, stateHome, sessionId: "no-agent-session", fetchImpl: stubFetch({}) });
  assert.equal(malformed.compacted, false);
  if (!malformed.compacted) assert.match(malformed.reason, /no agent session id/);
});
