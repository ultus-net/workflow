import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenRouterAnalytics,
  usageTimeRange,
  type AnalyticsMeta,
} from "../src/integrations/openrouter-analytics.js";

// The analytics client is the Usage page's data path. Pins: the meta endpoint
// gates which metrics get queried (nothing is fabricated), the query bodies
// carry seconds-precision ISO ranges, and credits degrade to absent on
// scope errors instead of failing the page.

function fakeFetch(routes: Map<string, unknown>): { readonly fetchImpl: typeof fetch; readonly calls: { readonly url: string; readonly init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, "");
    calls.push({ url: String(url), init });
    const body = routes.get(path);
    if (body === undefined) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const META: AnalyticsMeta = {
  metrics: [
    { name: "request_count", display_label: "Request Count", is_rate: false, display_format: "number" },
    { name: "cost", display_label: "Cost", is_rate: false, display_format: "currency" },
    { name: "prompt_tokens", display_label: "Input Tokens", is_rate: false, display_format: "number" },
    { name: "completion_tokens", display_label: "Output", is_rate: false, display_format: "number" },
  ],
  dimensions: [
    { name: "model", display_label: "Model" },
    { name: "provider", display_label: "Provider" },
  ],
  granularities: [{ name: "day", display_label: "Day" }],
};

test("usageTimeRange stamps seconds precision that OpenRouter accepts", () => {
  const { startIso, endIso } = usageTimeRange(7, () => new Date(1789700000000));
  assert.match(startIso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  assert.match(endIso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  assert.equal(new Date(endIso).getTime() - new Date(startIso).getTime(), 7 * 24 * 60 * 60 * 1000);
});

test("queryByModel asks only for advertised metrics and orders by spend", async () => {
  const { fetchImpl, calls } = fakeFetch(new Map([
    ["/analytics/meta", { data: META }],
    ["/analytics/query", { data: { data: [], metadata: {} } }],
  ]));
  const analytics = createOpenRouterAnalytics({ key: "mgmt-key", fetchImpl, baseUrl: "https://openrouter.test/api/v1" });
  const result = await analytics.queryByModel("2026-09-11T00:00:00.000Z", "2026-09-18T00:00:00.000Z");
  assert.deepEqual(result.rows, []);

  const queryCall = calls.find((call) => call.url.endsWith("/analytics/query"));
  assert.ok(queryCall !== undefined, "the query endpoint was called");
  const body = JSON.parse(String(queryCall.init?.body)) as { metrics: string[]; dimensions: string[]; order_by?: { field: string; direction: string }; time_range: { start: string; end: string } };
  assert.deepEqual(body.metrics, ["cost", "prompt_tokens", "completion_tokens", "request_count"]);
  assert.deepEqual(body.dimensions, ["model", "provider"]);
  assert.deepEqual(body.order_by, { field: "cost", direction: "desc" });
  assert.deepEqual(body.time_range, { start: "2026-09-11T00:00:00.000Z", end: "2026-09-18T00:00:00.000Z" });
});

test("daily series degrades to empty rows when day granularity is absent", async () => {
  const noDayMeta: AnalyticsMeta = {
    ...META,
    granularities: [{ name: "hour", display_label: "Hour" }],
  };
  const { fetchImpl, calls } = fakeFetch(new Map([
    ["/analytics/meta", { data: noDayMeta }],
  ]));
  const analytics = createOpenRouterAnalytics({ key: "mgmt-key", fetchImpl, baseUrl: "https://openrouter.test/api/v1" });
  const result = await analytics.queryDaily("2026-09-11T00:00:00.000Z", "2026-09-18T00:00:00.000Z");
  assert.deepEqual(result.rows, []);
  assert.equal(calls.filter((call) => call.url.endsWith("/analytics/query")).length, 0, "no query is issued without day granularity");
});

test("credits degrade to undefined on scope errors", async () => {
  const failing = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/credits")) {
      return new Response(JSON.stringify({ error: { message: "insufficient scope" } }), { status: 403 });
    }
    return new Response(JSON.stringify({ data: META }), { status: 200 });
  }) as unknown as typeof fetch;
  const analytics = createOpenRouterAnalytics({ key: "mgmt-key", fetchImpl: failing as unknown as typeof fetch, baseUrl: "https://openrouter.test/api/v1" });
  assert.deepEqual(await analytics.credits(), undefined, "a credits failure never fails the page");
});

test("errors carry OpenRouter's message, not a bare status", async () => {
  const failing = (async () => new Response(JSON.stringify({ error: { message: "Only management keys can perform this operation" } }), { status: 403 })) as unknown as typeof fetch;
  const analytics = createOpenRouterAnalytics({ key: "plain-key", fetchImpl: failing, baseUrl: "https://openrouter.test/api/v1" });
  await assert.rejects(analytics.meta(), /management key/i);
});