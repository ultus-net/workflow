import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardProjection,
  boardProviderFromEnv,
  fetchBoardTasks,
  type BoardOutcome,
  type BoardReadCache,
  type BoardReadCacheEntry,
  type ExternalTask,
  type GitHubIssuePayload,
} from "../src/integrations/task-provider.js";
import { createWorkflowHubBridge } from "../src/integrations/hub-http.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { BoardView } from "../src/ui/webapp/board-view.js";
import {
  ISSUE_VIEW_STATE_KEY,
  readIssueViewState,
  saveIssueViewState,
  withColumnDensity,
  withColumnPageSize,
  type IssueViewStorage,
  type IssueViewState,
} from "../src/ui/webapp/issue-view-state.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// W163 — column convergence + volume honesty (board issue #317; the
// Paperclip borrow spec W163 section). Four behaviors, each pinned against
// the lie it catches:
//   1. the provider-owned state_reason splits closed into done/cancelled —
//      completed -> done, not_planned/duplicate -> cancelled, a closed issue
//      with a MISSING or unknown state_reason keeps the legacy closed column
//      (no authority, no split), open issues (incl. "reopened") stay open,
//      and a label NEVER guesses a column. The column set grows only as its
//      backing authority exists (a board with no state_reason anywhere keeps
//      the W161 columns, including the always-rendered legacy closed one).
//   2. a per-column render cap (paperclip 200-per-column bound — the
//      contract pinned literally here) with honest "showing N of M received"
//      bookkeeping keyed on RECEIVED counts, never the rendered count
//      (LESS-0061 lesson 3: keying truncation on filtered counts hides a
//      full page behind excluded rows).
//   3. per-column page-size/density view preferences live in a UI-local
//      IssueViewState persisted per browser — NEVER in task/board state
//      (pinned by construction: the board payload JSON carries no prefs,
//      and rendering with prefs never writes into the board outcome).
//   4. hub-side ETag conditional reads: If-None-Match from a cached etag, a
//      304 serves the cached board as a shared-read hit, overlapping reads
//      share one upstream read, the TTL is stated on the payload, and an
//      entry past the TTL is NEVER served (a failed revalidation is the
//      honest error, never a stale serve).
// Pins labeled (guard) are green at authoring by construction — they catch
// the change regressing a property that already holds.
// Focused-run discipline: node --import tsx --test test/board-columns.test.ts.
// (Template literals are deliberately absent: string concatenation keeps the
// source patchable under the guard shell classifier.)

const githubProvider = () => {
  const state = boardProviderFromEnv({ WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "t" });
  if (state.kind !== "github") throw new Error("the fixture provider must classify as github");
  return state;
};

const issue = (number: number, overrides: Partial<GitHubIssuePayload> = {}): GitHubIssuePayload => ({
  url: "https://api.github.com/repos/o/r/issues/" + String(number),
  number,
  title: "Issue " + String(number),
  state: "open",
  labels: [],
  assignee: null,
  updated_at: "2026-09-28T00:00:00Z",
  html_url: "https://github.com/o/r/issues/" + String(number),
  ...overrides,
});

const stubFetch = (status: number, body: string) => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key] = value;
    calls.push({ url: String(input), headers });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
};

/** A scripted etag fetch: each call consumes the next response (the last
 * repeats), recording the wire headers per call. */
const etagFetch = (responses: { status: number; etag?: string; body: string }[]) => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let index = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key] = value;
    calls.push({ url: String(input), headers });
    const response = responses[Math.min(index, responses.length - 1)] ?? { status: 500, body: "" };
    index += 1;
    // A 304 is a null-body status: the Response constructor rejects a body
    // (even an empty string) for one — the fixture passes null.
    return new Response(response.status === 304 ? null : response.body, {
      status: response.status,
      headers: response.etag === undefined
        ? { "content-type": "application/json" }
        : { "content-type": "application/json", etag: response.etag },
    });
  }) as typeof fetch;
  return { impl, calls };
};

const card = (key: string, state: "open" | "closed", overrides: Partial<ExternalTask> = {}): ExternalTask => ({
  provider: "github",
  key,
  title: "Issue " + key.slice(1),
  state,
  url: "https://github.com/o/r/issues/" + key.slice(1),
  labels: [],
  updatedAt: "2026-09-28T00:00:00Z",
  ...overrides,
});

const boardOutcome = (tasks: readonly ExternalTask[]): BoardOutcome => ({
  state: "ok",
  board: { provider: "github", repo: "o/r", tasks, skipped: 0, pullRequestsExcluded: 0 },
});

const cardCount = (markup: string): number => (markup.match(/class="board-card"/g) ?? []).length;

// A test-owned cache (the LESS-0062 owner-side fixture): the exact
// BoardReadCache interface fetchBoardTasks consumes, so the file loads and
// every pin runs against the unmodified module.
const duckCache = (ttlMs: number): BoardReadCache => {
  const entries = new Map<string, BoardReadCacheEntry>();
  const inflights = new Map<string, Promise<BoardOutcome>>();
  return {
    ttlMs,
    get: (repo) => entries.get(repo),
    set: (repo, entry) => void entries.set(repo, entry),
    inflight: (repo) => inflights.get(repo),
    beginInflight: (repo, read) => void inflights.set(repo, read),
    endInflight: (repo) => void inflights.delete(repo),
  };
};

const mapStorage = (): { storage: IssueViewStorage; backing: Map<string, string> } => {
  const backing = new Map<string, string>();
  return {
    backing,
    storage: {
      getItem: (key) => backing.get(key) ?? null,
      setItem: (key, value) => void backing.set(key, value),
    },
  };
};

// ── Behavior 1: the provider-owned state_reason split ──

test("W163: the shape guard carries the provider-owned state_reason verbatim — absent and unknown strings are the honest absence; a wrong-typed field degrades the row", async () => {
  const payload = JSON.stringify([
    issue(1, { state: "closed", state_reason: "completed" }),
    issue(2, { state: "closed", state_reason: "not_planned" }),
    issue(3, { state: "closed", state_reason: "duplicate" }),
    issue(4, { state: "open", state_reason: "reopened" }),
    issue(5, { state: "closed" }),
    issue(6, { state: "closed", state_reason: "migrated" }),
    issue(7, { state: "closed", state_reason: 42 }),
  ]);
  const { impl } = stubFetch(200, payload);
  const outcome = await fetchBoardTasks(githubProvider(), impl);
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(outcome.board.skipped, 1, "the wrong-typed state_reason row is skipped and counted, never coerced");
  assert.deepEqual(
    outcome.board.tasks.map((row) => row.key),
    ["#1", "#2", "#3", "#4", "#5", "#6"],
    "the #N keys are unchanged (the W171 join keys on them)",
  );
  assert.deepEqual(
    outcome.board.tasks.map((row) => row.stateReason ?? null),
    ["completed", "not_planned", "duplicate", "reopened", null, null],
    "unknown strings carry no authority — the same honest absence as missing",
  );
});

test("W163: no label guesses — a closed issue labeled done/cancelled without provider state_reason stays in the legacy closed column", async () => {
  const payload = JSON.stringify([
    issue(8, { state: "closed", labels: [{ name: "done" }, { name: "cancelled" }] }),
  ]);
  const { impl } = stubFetch(200, payload);
  const outcome = await fetchBoardTasks(githubProvider(), impl);
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(outcome.board.tasks[0]?.stateReason, undefined);
  const columns = boardProjection(outcome.board);
  assert.deepEqual(columns.closed.map((row) => row.key), ["#8"]);
  assert.deepEqual(columns.done, []);
  assert.deepEqual(columns.cancelled, []);
});

test("W163: the projection splits closed by the provider-owned state_reason — done, cancelled, legacy closed; open (incl. reopened) stays open; inputs never mutated", () => {
  const rows: ExternalTask[] = [
    card("#1", "open"),
    card("#2", "open", { stateReason: "reopened" }),
    card("#3", "closed", { stateReason: "completed" }),
    card("#4", "closed", { stateReason: "not_planned" }),
    card("#5", "closed", { stateReason: "duplicate" }),
    card("#6", "closed"),
    card("#7", "closed", { stateReason: "some-future-reason" as Exclude<ExternalTask["stateReason"], undefined> }),
  ];
  const frozen: readonly ExternalTask[] = Object.freeze([...rows]);
  const columns = boardProjection({ provider: "github", repo: "o/r", tasks: frozen, skipped: 0, pullRequestsExcluded: 0 });
  assert.deepEqual(columns.open.map((row) => row.key), ["#1", "#2"], "reopened stays open — the state field owns the column first");
  assert.deepEqual(columns.done.map((row) => row.key), ["#3"]);
  assert.deepEqual(columns.cancelled.map((row) => row.key), ["#4", "#5"]);
  assert.deepEqual(
    columns.closed.map((row) => row.key),
    ["#6", "#7"],
    "missing and unrecognized reasons keep the legacy closed column — no authority, no split",
  );
  assert.equal(columns.stateReasonAuthority, true);
  assert.deepEqual([...frozen], rows, "the projection never mutates its inputs");
  const legacy = boardProjection({
    provider: "github", repo: "o/r", tasks: [card("#6", "closed")], skipped: 0, pullRequestsExcluded: 0,
  });
  assert.equal(legacy.stateReasonAuthority, false, "no state_reason anywhere — no split authority observed");
  assert.deepEqual(legacy.closed.map((row) => row.key), ["#6"]);
});

test("W163 (view): done and cancelled render only when their authority exists — a board whose every closed issue carries a reason has no closed column", () => {
  const markup = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome([
    card("#1", "open"),
    card("#2", "closed", { stateReason: "completed" }),
    card("#3", "closed", { stateReason: "not_planned" }),
    card("#4", "closed", { stateReason: "duplicate" }),
  ]) }));
  assert.ok(markup.includes("done (1)"), "the done column renders its authority cards");
  assert.ok(markup.includes("cancelled (2)"), "not_planned and duplicate converge on cancelled");
  assert.ok(!markup.includes("closed ("), "no legacy closed column remains once the split authority covers every closed issue");
  assert.ok(markup.indexOf("open (") < markup.indexOf("done ("), "the split columns follow open");
});

test("W163 (view): a closed issue with missing state_reason keeps the legacy closed column beside the split columns", () => {
  const markup = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome([
    card("#2", "closed", { stateReason: "completed" }),
    card("#6", "closed"),
  ]) }));
  assert.ok(markup.includes("done (1)"));
  assert.ok(markup.includes("closed (1)"), "missing state_reason keeps the legacy closed column — no guessed split");
  assert.ok(!markup.includes("cancelled ("));
});

test("W163 (view): open issues with state_reason 'reopened' stay open — and the closed column disappears with split authority and no legacy closed rows", () => {
  const markup = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome([
    card("#5", "open", { stateReason: "reopened" }),
  ]) }));
  assert.ok(markup.includes("open (1)"));
  assert.ok(!markup.includes("done ("));
  assert.ok(!markup.includes("cancelled ("));
  assert.ok(!markup.includes("closed ("));
});

test("W163 (view) (guard): a board with no state_reason anywhere keeps the W161 render — closed always present, no done/cancelled columns", () => {
  const markup = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome([
    card("#1", "open"), card("#2", "closed"),
  ]) }));
  assert.ok(markup.includes("open (1)"));
  assert.ok(markup.includes("closed (1)"));
  assert.ok(!markup.includes("done ("));
  assert.ok(!markup.includes("cancelled ("));
  const empty = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome([]) }));
  assert.ok(empty.includes("closed (0)"), "no authority observed — the legacy closed column keeps its W161 always-rendered place");
});

// ── Behavior 2: the per-column render cap + honest received counts ──

test("W163 (view): the per-column render cap renders 200 of 205 and the claim keys on RECEIVED counts, never the rendered count", () => {
  const many = Array.from({ length: 205 }, (_, index) => card("#" + String(index + 1), "open"));
  const markup = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome(many) }));
  assert.equal(cardCount(markup), 200, "the render cap bounds the cards, not the payload");
  assert.ok(markup.includes("showing 200 of 205 received"), "the truncation claim names both numbers");
  assert.ok(markup.includes("open (205)"), "the header count stays the RECEIVED count");
});

test("W163 (view) (guard): an at-cap column makes no truncation claim", () => {
  const atCap = Array.from({ length: 200 }, (_, index) => card("#" + String(index + 1), "open"));
  const markup = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome(atCap) }));
  assert.ok(!markup.includes("showing"), "no false completeness claim at exactly the cap");
});

test("W163 (view): the per-column page-size preference caps the render and the claim stays keyed on the received count", () => {
  const viewState: IssueViewState = { open: { pageSize: 2 } };
  const markup = renderToStaticMarkup(createElement(BoardView, {
    board: boardOutcome([card("#1", "open"), card("#2", "open"), card("#3", "open"), card("#4", "open")]),
    viewState,
  }));
  assert.equal(cardCount(markup), 2, "the preference bounds the render");
  assert.ok(markup.includes("showing 2 of 4 received"), "N of M received — never the rendered count against itself");
  assert.ok(markup.includes("open (4)"), "the header count stays the RECEIVED count");
});

test("W163 (view): the density preference renders the column density marker and nothing when unset (the legacy render)", () => {
  const compact = renderToStaticMarkup(createElement(BoardView, {
    board: boardOutcome([card("#1", "open")]),
    viewState: { open: { density: "compact" } },
  }));
  assert.ok(compact.includes('data-density="compact"'), "the density preference is visible on the column");
  const unset = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome([card("#1", "open")]) }));
  assert.ok(!unset.includes("data-density"), "no preference, no marker — the legacy markup");
});

// ── Behavior 3: the UI-local IssueViewState ──

test("W163: IssueViewState persists per browser and guards its shape — malformed storage is the honest empty, wrong entries drop element-wise", () => {
  const { storage, backing } = mapStorage();
  assert.deepEqual(readIssueViewState(storage), {}, "absent prefs are the honest empty state");
  saveIssueViewState(storage, withColumnPageSize(withColumnDensity({}, "open", "compact"), "open", 50));
  assert.deepEqual(readIssueViewState(storage), { open: { pageSize: 50, density: "compact" } });
  backing.set(ISSUE_VIEW_STATE_KEY, "not json{");
  assert.deepEqual(readIssueViewState(storage), {}, "corrupt storage never throws and never coerces");
  backing.set(ISSUE_VIEW_STATE_KEY, JSON.stringify({
    open: { pageSize: "ten" },
    closed: { pageSize: 0 },
    done: { pageSize: 25, density: "loud" },
    cancelled: { density: "compact" },
  }));
  assert.deepEqual(
    readIssueViewState(storage),
    { cancelled: { density: "compact" }, done: { pageSize: 25 } },
    "wrong-typed pageSize (non-number, zero) and unknown density drop field-wise; the valid sibling fields survive",
  );
});

test("W163: the preference updates are pure — set, keep siblings, prune empty entries, never mutate the input", () => {
  let state: IssueViewState = {};
  state = withColumnPageSize(state, "open", 50);
  assert.deepEqual(state, { open: { pageSize: 50 } });
  state = withColumnDensity(state, "open", "compact");
  assert.deepEqual(state, { open: { pageSize: 50, density: "compact" } });
  state = withColumnPageSize(state, "open", undefined);
  assert.deepEqual(state, { open: { density: "compact" } }, "clearing the page size keeps the sibling density");
  state = withColumnDensity(state, "closed", "compact");
  state = withColumnPageSize(state, "done", 25);
  assert.deepEqual(state, {
    open: { density: "compact" },
    closed: { density: "compact" },
    done: { pageSize: 25 },
  });
  const frozen = Object.freeze({ open: { pageSize: 50 } }) as IssueViewState;
  const next = withColumnDensity(frozen, "open", "compact");
  assert.deepEqual(next, { open: { pageSize: 50, density: "compact" } });
  assert.deepEqual({ ...frozen }, { open: { pageSize: 50 } }, "the input state is never mutated");
});

test("W163 (pin by construction): the view preferences never ride any board payload — the route relays the hub board outcome only", async () => {
  const seedTask: WorkflowTask = {
    id: taskId("seed"),
    title: "seed",
    state: "READY",
    dependencies: [],
    requiredEvidence: [],
  };
  const application = new WorkflowApplication(new TaskGraph([seedTask]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const outcome = boardOutcome([card("#1", "open"), card("#2", "closed", { stateReason: "completed" })]);
  const bridge = await createWorkflowHubBridge(
    application,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { readBoardTasks: async () => outcome },
  );
  try {
    const answered = await fetch(bridge.url + "/board/tasks", {
      method: "POST",
      headers: { authorization: "Bearer " + bridge.token, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as Record<string, unknown>;
    assert.deepEqual(payload, { board: outcome });
    const wire = JSON.stringify(payload);
    assert.ok(!wire.includes("pageSize"), "no page-size preference rides the board payload");
    assert.ok(!wire.includes("density"), "no density preference rides the board payload");
    assert.ok(!wire.includes(ISSUE_VIEW_STATE_KEY), "the prefs storage key never crosses the wire");
  } finally {
    await bridge.close();
  }
});

test("W163 (pin by construction): rendering the board with view preferences consumes the payload without writing prefs into it", () => {
  const outcome = boardOutcome([card("#1", "open"), card("#2", "closed", { stateReason: "completed" })]);
  const before = JSON.stringify(outcome);
  const viewState: IssueViewState = { open: { pageSize: 1, density: "compact" }, closed: { density: "cozy" } };
  renderToStaticMarkup(createElement(BoardView, { board: outcome, viewState, onViewState: () => undefined }));
  assert.equal(JSON.stringify(outcome), before, "the board outcome is untouched by the view preference rendering");
});

// ── Behavior 4: the hub-side ETag conditional read ──

test("W163: the first cached read carries no If-None-Match and states the TTL; a read within the TTL serves the cache with NO upstream call", async () => {
  const { impl, calls } = etagFetch([{ status: 200, etag: '"abc123"', body: JSON.stringify([issue(1)]) }]);
  const cache = duckCache(50);
  const first = await fetchBoardTasks(githubProvider(), impl, cache);
  if (first.state !== "ok") return assert.fail("expected ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.headers["if-none-match"], undefined, "the first read has nothing to revalidate against");
  assert.deepEqual(first.board.cache, { ttlMs: 50, hit: false }, "the payload states the TTL and that this answer is fresh");
  const hit = await fetchBoardTasks(githubProvider(), impl, cache);
  assert.equal(calls.length, 1, "a read within the TTL shares the one upstream read — no second fetch");
  if (hit.state !== "ok") return assert.fail("expected ok");
  assert.equal(hit.board.cache?.hit, true);
  assert.equal(hit.board.cache?.ttlMs, 50);
  assert.ok(typeof hit.board.cache?.ageMs === "number" && hit.board.cache.ageMs < 50, "the cached board age is stated and inside the TTL");
  assert.deepEqual(hit.board.tasks.map((row) => row.key), ["#1"], "the cached board serves verbatim");
});

test("W163: a stale entry revalidates with If-None-Match; the 304 serves the cached board as a revalidated hit and refreshes the TTL window", async () => {
  const { impl, calls } = etagFetch([
    { status: 200, etag: '"abc123"', body: JSON.stringify([issue(1)]) },
    { status: 304, body: "" },
  ]);
  const cache = duckCache(50);
  await fetchBoardTasks(githubProvider(), impl, cache);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const revalidated = await fetchBoardTasks(githubProvider(), impl, cache);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.headers["if-none-match"], '"abc123"', "the stale entry revalidates with its etag, verbatim");
  if (revalidated.state !== "ok") return assert.fail("expected ok");
  assert.deepEqual(
    revalidated.board.cache,
    { ttlMs: 50, hit: true, revalidated: true, ageMs: 0 },
    "the 304 hit is named as a revalidation of the cached board",
  );
  assert.deepEqual(revalidated.board.tasks.map((row) => row.key), ["#1"], "the cached board serves — the provider said not modified");
  const refreshed = await fetchBoardTasks(githubProvider(), impl, cache);
  assert.equal(calls.length, 2, "the revalidation refreshed the entry — the next read inside the TTL is a pure cache hit");
  if (refreshed.state !== "ok") return assert.fail("expected ok");
  assert.equal(refreshed.board.cache?.hit, true);
  assert.equal(refreshed.board.cache?.revalidated, undefined, "a plain TTL hit is not a revalidation");
});

test("W163: an entry past the TTL is NEVER served — a failed revalidation is the honest error, never a stale serve", async () => {
  const { impl, calls } = etagFetch([{ status: 200, etag: '"abc123"', body: JSON.stringify([issue(1)]) }]);
  const cache = duckCache(50);
  await fetchBoardTasks(githubProvider(), impl, cache);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const failing = (async (): Promise<Response> => {
    throw new Error("connection refused");
  }) as typeof fetch;
  const outcome = await fetchBoardTasks(githubProvider(), failing, cache);
  assert.equal(outcome.state, "error", "the stale entry is not served past the TTL");
  assert.match(outcome.state === "error" ? outcome.reason : "", /connection refused/);
  assert.equal(calls.length, 1, "the failed revalidation never reached the wire — the seeded read remains the only wire call");
  const retry = await fetchBoardTasks(githubProvider(), impl, cache);
  assert.equal(calls.length, 2, "the next read retries upstream (the error was never cached)");
  if (retry.state !== "ok") return assert.fail("expected ok");
  assert.deepEqual(retry.board.cache, { ttlMs: 50, hit: false });
});

test("W163: the provider changed board replaces the cache — a 200 after revalidation serves fresh and the next read inside the TTL hits the NEW board", async () => {
  const { impl, calls } = etagFetch([
    { status: 200, etag: '"v1"', body: JSON.stringify([issue(1)]) },
    { status: 200, etag: '"v2"', body: JSON.stringify([issue(1), issue(2)]) },
  ]);
  const cache = duckCache(50);
  await fetchBoardTasks(githubProvider(), impl, cache);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const changed = await fetchBoardTasks(githubProvider(), impl, cache);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.headers["if-none-match"], '"v1"', "the revalidation presents the cached etag");
  if (changed.state !== "ok") return assert.fail("expected ok");
  assert.deepEqual(changed.board.cache, { ttlMs: 50, hit: false }, "a 200 after revalidation is a fresh read");
  assert.deepEqual(changed.board.tasks.map((row) => row.key), ["#1", "#2"], "the provider new board replaces the cache");
  const hit = await fetchBoardTasks(githubProvider(), impl, cache);
  assert.equal(calls.length, 2);
  if (hit.state !== "ok") return assert.fail("expected ok");
  assert.deepEqual(hit.board.tasks.map((row) => row.key), ["#1", "#2"], "the TTL hit serves the replaced board, not the old one");
});

test("W163: overlapping reads share ONE upstream read — the second caller awaits the first in-flight read", async () => {
  const calls: { url: string }[] = [];
  const slow = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push({ url: String(input) });
    await new Promise((resolve) => setTimeout(resolve, 40));
    return new Response(JSON.stringify([issue(1)]), { status: 200, headers: { "content-type": "application/json", etag: '"abc123"' } });
  }) as typeof fetch;
  const cache = duckCache(30_000);
  const [a, b] = await Promise.all([
    fetchBoardTasks(githubProvider(), slow, cache),
    fetchBoardTasks(githubProvider(), slow, cache),
  ]);
  assert.equal(calls.length, 1, "overlapping tabs share one upstream read");
  assert.deepEqual(a, b, "both callers receive the same board");
});

test("W163 (guard): errors are never cached and carry no cache bookkeeping — the next read retries upstream", async () => {
  const { impl, calls } = stubFetch(401, JSON.stringify({ message: "Bad credentials" }));
  const cache = duckCache(30_000);
  const rejected = await fetchBoardTasks(githubProvider(), impl, cache);
  assert.equal(rejected.state, "error");
  assert.match(rejected.state === "error" ? rejected.reason : "", /401/);
  assert.ok(!JSON.stringify(rejected).includes("ttlMs"), "a fault carries no cache TTL claim");
  const good = stubFetch(200, JSON.stringify([issue(1)]));
  const retry = await fetchBoardTasks(githubProvider(), good.impl, cache);
  if (retry.state !== "ok") return assert.fail("expected ok");
  assert.equal(calls.length + good.calls.length, 2, "the fault was not cached — the retry went upstream");
});

test("W163 (guard): the cache-less read is the byte-identical legacy path — no If-None-Match, no cache field", async () => {
  const { impl, calls } = stubFetch(200, JSON.stringify([issue(1)]));
  const first = await fetchBoardTasks(githubProvider(), impl);
  if (first.state !== "ok") return assert.fail("expected ok");
  assert.equal(calls[0]?.headers["if-none-match"], undefined);
  assert.ok(!("cache" in first.board), "a cache-less caller payload carries no cache metadata");
});

test("W163: createBoardReadCache is the production cache the read consumes — TTL carried, entries and single-flight stored", async () => {
  // Dynamic import keeps this file loadable against the unmodified module
  // (the red-first observation): the factory is part of the W163 surface.
  const provider = await import("../src/integrations/task-provider.js");
  const cache = provider.createBoardReadCache(1_000);
  assert.equal(cache.ttlMs, 1_000);
  assert.equal(cache.get("o/r"), undefined);
  const entry: BoardReadCacheEntry = {
    etag: '"v1"',
    board: { provider: "github", repo: "o/r", tasks: [], skipped: 0, pullRequestsExcluded: 0 },
    fetchedAt: 7,
  };
  cache.set("o/r", entry);
  assert.deepEqual(cache.get("o/r"), entry);
  assert.equal(cache.inflight("o/r"), undefined);
  const read = Promise.resolve({ state: "ok", board: entry.board } as BoardOutcome);
  cache.beginInflight("o/r", read);
  assert.equal(cache.inflight("o/r"), read);
  cache.endInflight("o/r");
  assert.equal(cache.inflight("o/r"), undefined);
  assert.equal(provider.createBoardReadCache().ttlMs, provider.BOARD_CACHE_TTL_MS, "the default TTL is the exported constant");
  assert.equal(provider.BOARD_CACHE_TTL_MS, 30_000, "the TTL is a stated constant, not magic");
});

// ── The payload cache bookkeeping renders honestly ──

test("W163 (view): the payload cache bookkeeping renders — TTL stated, hit named, age stated; no metadata, no claim", () => {
  const cached = renderToStaticMarkup(createElement(BoardView, { board: {
    state: "ok",
    board: {
      provider: "github", repo: "o/r", tasks: [card("#1", "open")], skipped: 0, pullRequestsExcluded: 0,
      cache: { ttlMs: 30_000, hit: true, ageMs: 4_000 },
    },
  } }));
  assert.ok(cached.includes("provider read cached"), "a cache hit is named");
  assert.ok(cached.includes("cache TTL 30s"), "the TTL is stated");
  assert.ok(cached.includes("4s old"), "the cached board age is stated");
  const revalidated = renderToStaticMarkup(createElement(BoardView, { board: {
    state: "ok",
    board: {
      provider: "github", repo: "o/r", tasks: [card("#1", "open")], skipped: 0, pullRequestsExcluded: 0,
      cache: { ttlMs: 30_000, hit: true, revalidated: true, ageMs: 0 },
    },
  } }));
  assert.ok(revalidated.includes("revalidated just now"), "the 304 hit names its revalidation");
  const fresh = renderToStaticMarkup(createElement(BoardView, { board: {
    state: "ok",
    board: {
      provider: "github", repo: "o/r", tasks: [card("#1", "open")], skipped: 0, pullRequestsExcluded: 0,
      cache: { ttlMs: 30_000, hit: false },
    },
  } }));
  assert.ok(fresh.includes("provider read fresh"), "a fresh read is named");
  assert.ok(!fresh.includes(" old"), "a fresh read states no age");
  const legacy = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome([card("#1", "open")]) }));
  assert.ok(!legacy.includes("provider read"), "no cache metadata, no cache claim — the legacy render");
});
