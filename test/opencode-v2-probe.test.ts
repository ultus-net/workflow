import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env.WORKFLOW_OPENCODE_V2_PROBE === "1";
const baseUrl = process.env.WORKFLOW_OPENCODE_V2_URL ?? "http://127.0.0.1:4096";

const describe = enabled ? test : test.skip;

describe("OpenCode v2 route qualification: server identity and session stats", async () => {
  const info = await fetch(`${baseUrl}/api/info`);
  assert.equal(info.ok, true, "v2 /api/info must be reachable through the qualified endpoint");
  const infoBody = await info.json() as Record<string, unknown>;
  assert.equal(typeof infoBody, "object");

  const stats = await fetch(`${baseUrl}/api/experimental/session/stats`);
  assert.ok(stats.status === 200 || stats.status === 400 || stats.status === 401,
    `session.stats returned an undocumented status ${stats.status}`);
  if (stats.status === 200) {
    const body = await stats.json() as Record<string, unknown>;
    assert.equal(typeof body.data, "object", "session.stats must return a data object");
  }
});

describe("OpenCode v2 route qualification: event stream is observable", async () => {
  const response = await fetch(`${baseUrl}/event`, { headers: { accept: "text/event-stream" } });
  assert.ok(response.status === 200 || response.status === 401,
    `event stream returned an undocumented status ${response.status}`);
  if (response.body !== null) await response.body.cancel();
});