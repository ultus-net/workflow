import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env.WORKFLOW_OPENCODE_V2_PROBE === "1";
const baseUrl = process.env.WORKFLOW_OPENCODE_V2_URL ?? "http://127.0.0.1:4096";
const auth = process.env.WORKFLOW_OPENCODE_V2_PASSWORD === undefined
  ? undefined
  : `Basic ${Buffer.from(`opencode:${process.env.WORKFLOW_OPENCODE_V2_PASSWORD}`).toString("base64")}`;
const headers = auth === undefined ? {} : { authorization: auth };

const describe = enabled ? test : test.skip;

describe("OpenCode v2 route qualification: server identity and session stats", async () => {
  const info = await fetch(`${baseUrl}/api/info`, { headers });
  assert.equal(info.ok, true, "v2 /api/info must be reachable through the qualified endpoint");
  const infoBody = await info.json() as Record<string, unknown>;
  assert.equal(typeof infoBody.version, "string", "v2 probe must report a pinned server version");

  const stats = await fetch(`${baseUrl}/api/experimental/session/stats`, { headers });
  assert.equal(stats.status, 200, `authenticated session.stats returned ${stats.status}`);
  if (stats.status === 200) {
    const body = await stats.json() as Record<string, unknown>;
    assert.equal(typeof body.data, "object", "session.stats must return a data object");
  }
});

describe("OpenCode v2 route qualification: event stream is observable", async () => {
  const response = await fetch(`${baseUrl}/api/event`, { headers: { ...headers, accept: "text/event-stream" } });
  assert.equal(response.status, 200, `v2 /api/event returned ${response.status}`);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  if (response.body !== null) await response.body.cancel();
});

describe("OpenCode v2 route qualification: auth boundary covers route classes", async () => {
  for (const path of ["/api/session", "/api/experimental/session/stats", "/api/event", "/api/experimental/fs/write", "/api/session/s/permission/r/reply", "/api/mcp"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 401, `${path} must reject unauthenticated access`);
  }
  const session = await fetch(`${baseUrl}/api/session`, { headers });
  assert.equal(session.status, 200, "authenticated read session route must work");
});