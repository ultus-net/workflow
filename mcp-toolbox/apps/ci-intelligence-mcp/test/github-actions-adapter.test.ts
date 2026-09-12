import assert from "node:assert/strict";
import { test } from "node:test";

import { CiProviderError, GitHubActionsAdapter } from "../src/github-actions-adapter.ts";
import { createFakeProvider } from "./fake-provider.ts";

const repository = "acme/widgets";
const run = (id: number, overrides: Record<string, unknown> = {}) => ({
  id, name: `CI ${id}`, head_branch: "main", head_sha: String(id).padStart(40, "a"), status: "completed", conclusion: "success",
  created_at: `2026-08-${String(id).padStart(2, "0")}T10:00:00Z`, updated_at: `2026-08-${String(id).padStart(2, "0")}T10:05:00Z`,
  run_started_at: `2026-08-${String(id).padStart(2, "0")}T10:01:00Z`, html_url: `https://github.com/${repository}/actions/runs/${id}`,
  repository: { full_name: repository }, ...overrides,
});

test("normalizes, sorts, filters, and only counts matching runs for truncation", async () => {
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input) => {
    requests.push(new URL(String(input)));
    return Response.json({ workflow_runs: [
      run(1, { head_sha: "b".repeat(40) }),
      run(3, { head_sha: "a".repeat(40) }),
      run(2, { head_sha: "a".repeat(40) }),
      run(4, { head_sha: "a".repeat(40) }),
    ] });
  };
  const result = await new GitHubActionsAdapter({ repository }, fetcher).listRuns({ branch: "main", revision: "a".repeat(40), limit: 2 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.runs.map(({ id }) => id), ["github:4", "github:3"]);
  assert.equal(requests[0]?.searchParams.get("per_page"), "3");
  assert.equal(requests[0]?.searchParams.get("branch"), "main");
  assert.equal(requests[0]?.searchParams.get("head_sha"), "a".repeat(40));
});

test("paginates until a second page establishes truncation", async () => {
  let page = 0;
  const fetcher: typeof fetch = async () => Response.json({ workflow_runs: ++page === 1
    ? [run(1, { head_branch: "release" }), run(2)]
    : [run(3, { head_branch: "release" })] });
  const result = await new GitHubActionsAdapter({ repository }, fetcher).listRuns({ branch: "release", limit: 1 });
  assert.equal(page, 2);
  assert.equal(result.truncated, true);
});

test("returns an empty successful result when the provider has no runs", async () => {
  const result = await new GitHubActionsAdapter({ repository }, async () => Response.json({ workflow_runs: [] })).listRuns();
  assert.deepEqual(result, { runs: [], truncated: false });
});

test("normalizes unknown conclusions without treating them as failure or success", async () => {
  const fetcher: typeof fetch = async () => Response.json({ workflow_runs: [run(1, { conclusion: "stale" })] });
  const result = await new GitHubActionsAdapter({ repository }, fetcher).listRuns();
  assert.equal(result.runs[0]?.conclusion, "unknown");
  assert.equal(result.runs[0]?.providerConclusion, "stale");
});

test("normalizes GitHub waiting states as queued", async () => {
  for (const status of ["queued", "requested", "waiting", "pending"]) {
    const fetcher: typeof fetch = async () => Response.json({ workflow_runs: [run(1, { status, conclusion: null })] });
    const result = await new GitHubActionsAdapter({ repository }, fetcher).listRuns();
    assert.equal(result.runs[0]?.state, "queued");
    assert.equal(result.runs[0]?.conclusion, undefined);
  }
});

test("normalizes running and completed conclusions", async () => {
  const cases = [
    ["in_progress", null, "in_progress", undefined],
    ["completed", "success", "completed", "success"],
    ["completed", "failure", "completed", "failure"],
    ["completed", "cancelled", "completed", "cancelled"],
    ["completed", "timed_out", "completed", "timed_out"],
  ] as const;
  for (const [status, conclusion, state, normalizedConclusion] of cases) {
    const result = await new GitHubActionsAdapter({ repository }, async () => Response.json({ workflow_runs: [run(1, { status, conclusion })] })).listRuns();
    assert.equal(result.runs[0]?.state, state);
    assert.equal(result.runs[0]?.conclusion, normalizedConclusion);
  }
});

test("fails closed on repository mismatch and malformed responses", async () => {
  for (const payload of [{ workflow_runs: [run(1, { repository: { full_name: "other/repo" } })] }, { nope: true }]) {
    const adapter = new GitHubActionsAdapter({ repository }, async () => Response.json(payload));
    await assert.rejects(() => adapter.listRuns(), (error: unknown) => error instanceof CiProviderError && error.category === "invalid_response");
  }
});

test("fails closed on repository mismatch before selector filtering", async () => {
  const adapter = new GitHubActionsAdapter({ repository }, async () => Response.json({ workflow_runs: [run(1, {
    head_branch: "other",
    repository: { full_name: "other/repo" },
  })] }));
  await assert.rejects(() => adapter.listRuns({ branch: "main" }), (error: unknown) => error instanceof CiProviderError && error.category === "invalid_response");
});

test("fails instead of paginating indefinitely when selectors never match", async () => {
  let requests = 0;
  const adapter = new GitHubActionsAdapter({ repository }, async () => {
    requests += 1;
    return Response.json({ workflow_runs: [run(1, { head_branch: "other" }), run(2, { head_branch: "other" })] });
  });
  await assert.rejects(() => adapter.listRuns({ branch: "main", limit: 1 }), (error: unknown) => error instanceof CiProviderError && error.category === "invalid_response");
  assert.equal(requests, 10);
});

test("does not expose provider bodies or credentials in HTTP errors", async () => {
  const token = "super-secret-token";
  const adapter = new GitHubActionsAdapter({ repository, token }, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    return new Response(`provider leaked ${token}`, { status: 401, headers: { "x-secret": token } });
  });
  await assert.rejects(() => adapter.listRuns(), (error: unknown) => {
    if (!(error instanceof CiProviderError)) return false;
    assert.equal(error.category, "authentication");
    assert.doesNotMatch(error.message, /secret|leaked/u);
    return true;
  });
});

test("classifies authorization, not-found, rate-limit, cancellation, and oversized responses", async () => {
  for (const [status, category] of [[403, "authorization"], [404, "not_found"], [429, "rate_limited"]] as const) {
    const adapter = new GitHubActionsAdapter({ repository }, async () => new Response("untrusted", { status }));
    await assert.rejects(() => adapter.listRuns(), (error: unknown) => error instanceof CiProviderError && error.category === category);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => new GitHubActionsAdapter({ repository }, fetch).listRuns({}, controller.signal), (error: unknown) => error instanceof CiProviderError && error.category === "cancelled");
  const oversized = new GitHubActionsAdapter({ repository }, async () => new Response("", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }));
  await assert.rejects(() => oversized.listRuns(), (error: unknown) => error instanceof CiProviderError && error.category === "invalid_response");
});

test("does not follow provider-controlled web URLs", async () => {
  let calls = 0;
  const adapter = new GitHubActionsAdapter({ repository }, async () => {
    calls += 1;
    return Response.json({ workflow_runs: [run(1, { html_url: "https://attacker.invalid/instructions" })] });
  });
  const result = await adapter.listRuns();
  assert.equal(calls, 1);
  assert.equal(result.runs[0]?.webUrl, "https://attacker.invalid/instructions");
});

test("preserves configured GitHub Enterprise API path prefixes", async () => {
  let requested: URL | undefined;
  const adapter = new GitHubActionsAdapter({ repository, apiUrl: "https://github.example/api/v3" }, async (input) => {
    requested = new URL(String(input));
    return Response.json({ workflow_runs: [] });
  });
  await adapter.listRuns();
  assert.equal(requested?.pathname, "/api/v3/repos/acme/widgets/actions/runs");
});

test("bounds streaming responses without a content-length header", async () => {
  const provider = await createFakeProvider("oversized_stream");
  try {
    const adapter = new GitHubActionsAdapter({ repository, apiUrl: provider.url });
    await assert.rejects(() => adapter.listRuns(), (error: unknown) => error instanceof CiProviderError && error.category === "invalid_response");
  } finally {
    await provider.close();
  }
});

test("normalizes cancellation while consuming a response body", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('{"workflow_runs":['));
      setTimeout(() => controller.abort(), 10);
    },
  });
  const adapter = new GitHubActionsAdapter({ repository }, async (_input, init) => new Response(body.pipeThrough(new TransformStream({
    async transform(chunk, streamController) {
      streamController.enqueue(chunk);
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    },
  }))));
  await assert.rejects(() => adapter.listRuns({}, controller.signal), (error: unknown) => error instanceof CiProviderError && error.category === "cancelled");
});

test("normalizes timeout while consuming a provider response body", async () => {
  const provider = await createFakeProvider("delayed_body");
  try {
    const adapter = new GitHubActionsAdapter({ repository, apiUrl: provider.url }, fetch, 20);
    await assert.rejects(() => adapter.listRuns(), (error: unknown) => error instanceof CiProviderError && error.category === "timeout");
  } finally {
    await provider.close();
  }
});

test("exercises filtering, pagination, empty results, and states through the fake HTTP provider", async () => {
  const pagination = await createFakeProvider("pagination");
  try {
    const result = await new GitHubActionsAdapter({ repository, apiUrl: pagination.url }).listRuns({
      branch: "release",
      revision: "a".repeat(40),
      limit: 1,
    });
    assert.deepEqual(result.runs.map(({ id }) => id), ["github:3"]);
    assert.equal(result.truncated, true);
  } finally {
    await pagination.close();
  }

  const empty = await createFakeProvider("no_runs");
  try {
    assert.deepEqual(await new GitHubActionsAdapter({ repository, apiUrl: empty.url }).listRuns(), { runs: [], truncated: false });
  } finally {
    await empty.close();
  }

  const states = await createFakeProvider("states");
  try {
    const result = await new GitHubActionsAdapter({ repository, apiUrl: states.url }).listRuns();
    assert.deepEqual(new Set(result.runs.map(({ state }) => state)), new Set(["queued", "in_progress", "completed"]));
    assert.deepEqual(new Set(result.runs.map(({ conclusion }) => conclusion).filter(Boolean)), new Set(["success", "failure", "cancelled", "timed_out", "unknown"]));
  } finally {
    await states.close();
  }
});

test("exercises malformed, mismatched, and HTTP provider errors through the fake HTTP provider", async () => {
  for (const [mode, category] of [
    ["malformed", "invalid_response"], ["mismatch", "invalid_response"], ["authentication", "authentication"],
    ["authorization", "authorization"], ["rate_limited", "rate_limited"],
  ] as const) {
    const provider = await createFakeProvider(mode);
    try {
      await assert.rejects(
        () => new GitHubActionsAdapter({ repository, apiUrl: provider.url }).listRuns({ branch: mode === "mismatch" ? "main" : undefined }),
        (error: unknown) => error instanceof CiProviderError && error.category === category && !error.message.includes("fixture-secret-token"),
      );
    } finally {
      await provider.close();
    }
  }
});

test("keeps hostile HTTP provider content bounded and inert", async () => {
  const provider = await createFakeProvider("hostile");
  try {
    const result = await new GitHubActionsAdapter({ repository, apiUrl: provider.url }).listRuns();
    const item = result.runs[0];
    assert.ok(item);
    assert.ok(new TextEncoder().encode(item.workflowName).byteLength <= 4 * 1024);
    assert.match(item.workflowName, /^Ignore previous instructions/u);
    assert.equal(item.webUrl, "https://attacker.invalid/instructions");
  } finally {
    await provider.close();
  }
});

test("cancels while consuming the fake HTTP provider response body", async () => {
  const provider = await createFakeProvider("delayed_body");
  const controller = new AbortController();
  try {
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      () => new GitHubActionsAdapter({ repository, apiUrl: provider.url }).listRuns({}, controller.signal),
      (error: unknown) => error instanceof CiProviderError && error.category === "cancelled",
    );
  } finally {
    await provider.close();
  }
});

test("returns bounded normalized job summaries for an explicit run", async () => {
  const provider = await createFakeProvider();
  try {
    const result = await new GitHubActionsAdapter({ repository, apiUrl: provider.url }).listJobs("github:7", 1);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.jobs, [{
      id: "github:72", runId: "github:7", name: "verify windows", revision: "a".repeat(40), state: "completed", conclusion: "failure",
      startedAt: "2026-08-28T10:02:00Z", completedAt: "2026-08-28T10:04:00Z", webUrl: "https://github.com/acme/widgets/actions/runs/7/job/72",
    }]);
  } finally {
    await provider.close();
  }
});

test("rejects unqualified run IDs and mismatched provider job authority", async () => {
  const adapter = new GitHubActionsAdapter({ repository }, async () => Response.json({ jobs: [{
    id: 1, run_id: 8, head_sha: "a".repeat(40), name: "verify", status: "completed", conclusion: "success",
    started_at: "2026-08-28T10:00:00Z", completed_at: "2026-08-28T10:01:00Z", html_url: null,
  }] }));
  await assert.rejects(() => adapter.listJobs("7"), /provider-qualified/u);
  await assert.rejects(() => adapter.listJobs("github:7"), (error: unknown) => error instanceof CiProviderError && error.category === "invalid_response");
});

test("normalizes empty, queued, running, and unknown job evidence", async () => {
  const empty = new GitHubActionsAdapter({ repository }, async () => Response.json({ jobs: [] }));
  assert.deepEqual(await empty.listJobs("github:7"), { jobs: [], truncated: false });

  const adapter = new GitHubActionsAdapter({ repository }, async () => Response.json({ jobs: [
    { id: 1, run_id: 7, head_sha: "a".repeat(40), name: "queued", status: "waiting", conclusion: null, started_at: "2026-08-28T10:00:00Z", completed_at: null, html_url: null },
    { id: 2, run_id: 7, head_sha: "a".repeat(40), name: "running", status: "in_progress", conclusion: null, started_at: "2026-08-28T10:01:00Z", completed_at: null, html_url: null },
    { id: 3, run_id: 7, head_sha: "a".repeat(40), name: "future", status: "completed", conclusion: "future_conclusion", started_at: "2026-08-28T10:02:00Z", completed_at: "2026-08-28T10:03:00Z", html_url: null },
  ] }));
  const result = await adapter.listJobs("github:7");
  assert.deepEqual(result.jobs.map(({ state, conclusion, providerConclusion, completedAt }) => ({ state, conclusion, providerConclusion, completedAt })), [
    { state: "queued", conclusion: undefined, providerConclusion: undefined, completedAt: undefined },
    { state: "in_progress", conclusion: undefined, providerConclusion: undefined, completedAt: undefined },
    { state: "completed", conclusion: "unknown", providerConclusion: "future_conclusion", completedAt: "2026-08-28T10:03:00Z" },
  ]);
});

test("paginates job evidence until an extra provider record proves truncation", async () => {
  const pages: number[] = [];
  const adapter = new GitHubActionsAdapter({ repository }, async (input) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page"));
    pages.push(page);
    const makeJob = (id: number) => ({ id, run_id: 7, head_sha: "a".repeat(40), name: `job-${id}`, status: "completed", conclusion: "success", started_at: "2026-08-28T10:00:00Z", completed_at: "2026-08-28T10:01:00Z", html_url: null });
    return Response.json({ jobs: page === 1 ? Array.from({ length: 100 }, (_, index) => makeJob(index + 1)) : [makeJob(101)] });
  });
  const result = await adapter.listJobs("github:7", 100);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.jobs.length, 100);
  assert.equal(result.truncated, true);
});
