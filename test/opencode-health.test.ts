import assert from "node:assert/strict";
import test from "node:test";

import { isHealthyOpencodeBody, probeOpencodeHealth } from "../src/integrations/opencode-health.js";

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

test("opencode health: the v2 info envelope is the primary contract", async () => {
  const calls: string[] = [];
  const verdict = await probeOpencodeHealth(async (url) => {
    calls.push(String(url));
    return jsonResponse(JSON.stringify({ version: "2.0.10", pid: 42 }));
  }, "http://127.0.0.1:4096", "Basic dXNlcjpwYXNz");
  assert.deepEqual(calls, ["http://127.0.0.1:4096/api/info"], "a v2 server must be proven healthy on the first probe");
  assert.deepEqual(verdict, { version: "2.0.10" });
});

test("opencode health: a v1 server falls back to the /global/health envelope", async () => {
  const calls: string[] = [];
  const verdict = await probeOpencodeHealth(async (url) => {
    calls.push(String(url));
    return String(url).includes("/api/info")
      ? jsonResponse("not found", 404)
      : jsonResponse(JSON.stringify({ healthy: true, version: "1.18.31" }));
  }, "http://127.0.0.1:4096", "Basic dXNlcjpwYXNz");
  assert.deepEqual(calls, ["http://127.0.0.1:4096/api/info", "http://127.0.0.1:4096/global/health"]);
  assert.deepEqual(verdict, { version: "1.18.31" });
});

test("opencode health: the v2 SPA fallback HTML on /global/health is never healthy", async () => {
  const verdict = await probeOpencodeHealth(async (url) => String(url).includes("/api/info")
    ? jsonResponse("not found", 404)
    : new Response("<!doctype html><html lang=\"en\"><body>OpenCode</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
  "http://127.0.0.1:4096", "Basic dXNlcjpwYXNz");
  assert.equal(verdict, undefined, "a 200 HTML catch-all must not prove health");
});

test("opencode health: auth failures and dead servers prove nothing", async () => {
  const unauthorized = await probeOpencodeHealth(async () => jsonResponse("{ \"error\": \"unauthorized\" }", 401),
    "http://127.0.0.1:4096", "Basic d3Jvbmc6cGFzcw");
  assert.equal(unauthorized, undefined);

  const refusing = await probeOpencodeHealth(async () => {
    throw new Error("connection refused");
  }, "http://127.0.0.1:4096", undefined);
  assert.equal(refusing, undefined);
});

test("opencode health: a versionless v1 envelope still proves health", async () => {
  const verdict = await probeOpencodeHealth(async (url) => String(url).includes("/api/info")
    ? jsonResponse("not found", 404)
    : jsonResponse(JSON.stringify({ healthy: true })),
  "http://127.0.0.1:4096", "Basic dXNlcjpwYXNz");
  assert.deepEqual(verdict, {});
});

test("opencode health: body classification is path-aware", () => {
  assert.equal(isHealthyOpencodeBody("/api/info", { version: "2.0.10" }), true);
  assert.equal(isHealthyOpencodeBody("/api/info", { healthy: true }), true);
  assert.equal(isHealthyOpencodeBody("/global/health", { healthy: true, version: "1.18.31" }), true);
  assert.equal(isHealthyOpencodeBody("/global/health", { version: "2.0.10" }), false, "the v1 route needs healthy:true");
  assert.equal(isHealthyOpencodeBody("/api/info", "<!doctype html>"), false);
  assert.equal(isHealthyOpencodeBody("/api/info", undefined), false);
});
