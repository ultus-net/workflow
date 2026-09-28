import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardProviderFromEnv,
  fetchIssueCrossReferences,
  fetchWorkProductState,
  workProductStates,
  type BoardProviderState,
  type BoardTasks,
  type ExternalTask,
  type WorkProductCardState,
  type WorkProductStateOutcome,
} from "../src/integrations/task-provider.js";
import { createWorkflowHubBridge } from "../src/integrations/hub-http.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";
import type { WorkflowRunController } from "../src/integrations/run-controller.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { BoardView } from "../src/ui/webapp/board-view.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// W165 — work products and the in_review column (board issue #321; the
// Paperclip borrow spec's W165). Registered pins:
//   1. the run→PR work-product linkage is a bounded registry map recorded
//      HUB-SIDE (the W153/W162 pattern mirrored exactly): the delegate flow
//      records it from its OWN provider read at the same begin that records
//      the origin; /run/begin still accepts none — a client-supplied link is
//      refused/ignored, and the view never computes the linkage;
//   2. the provider-owned PR state is a read-only provider read (bounded 5s
//      fetch, per-row shape guard, honest errors) whose state renders
//      VERBATIM (open/closed, the draft flag when the payload carries one)
//      with the read's as-of liveness stated;
//   3. the in_review column appears ONLY when its authority exists (the
//      hub's own work-product payload, amendment 3): a card lands there when
//      the registry-sourced linkage names its issue AND the provider state
//      reads "open"; linked cards in any other provider state keep their
//      state-owned column with the state verbatim; cards without linkage
//      render the honest "unlinked" state.
// Focused-run discipline: node --import tsx --test
// test/work-product-linkage.test.ts.

const seedTask: WorkflowTask = {
  id: taskId("seed"),
  title: "seed",
  state: "READY",
  dependencies: [],
  requiredEvidence: [],
};

const application = (): WorkflowApplication =>
  new WorkflowApplication(new TaskGraph([seedTask]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));

const githubProvider = (env: Record<string, string | undefined> = { WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "t" }): BoardProviderState => {
  const state = boardProviderFromEnv(env);
  assert.equal(state.kind, "github");
  return state as BoardProviderState & { kind: "github" };
};

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

const pr = (number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  url: `https://api.github.com/repos/o/r/issues/${number}`,
  number,
  title: `PR ${number}`,
  state: "open",
  draft: false,
  labels: [],
  assignee: null,
  updated_at: "2026-09-28T00:00:00Z",
  html_url: `https://github.com/o/r/pull/${number}`,
  pull_request: { url: `https://api.github.com/repos/o/r/pulls/${number}` },
  ...overrides,
});

const plainIssue = (number: number): Record<string, unknown> => ({
  url: `https://api.github.com/repos/o/r/issues/${number}`,
  number,
  title: `Issue ${number}`,
  state: "open",
  labels: [],
  assignee: null,
  updated_at: "2026-09-28T00:00:00Z",
  html_url: `https://github.com/o/r/issues/${number}`,
});

const boardTask = (number: number, state: "open" | "closed" = "open"): ExternalTask => ({
  provider: "github",
  key: `#${number}`,
  title: `Issue ${number}`,
  state,
  url: `https://github.com/o/r/issues/${number}`,
  labels: [],
  updatedAt: "2026-09-28T00:00:00Z",
});

const board: BoardTasks = {
  provider: "github",
  repo: "o/r",
  tasks: [boardTask(12), boardTask(13), boardTask(14, "closed"), boardTask(15)],
  skipped: 0,
  pullRequestsExcluded: 0,
};

test("W165: the registry records the delegate flow's work-product link at begin — hub-side only; /run/begin still accepts none", async () => {
  const registry = createRunRegistry(application(), new TaskGraph([seedTask]));
  const link = { provider: "github" as const, key: "#12", url: "https://github.com/o/r/issues/12" };
  await registry.controller.begin({
    runId: "board:github:12:aa",
    title: "#12 Fix the flaky test",
    workProductLink: link,
  });
  assert.deepEqual(registry.workProductLinks().get("board:github:12:aa"), link, "the link is recorded from the begin input");
  const links = registry.controller.gateObservability?.().workProductLinks ?? new Map();
  assert.deepEqual(links.get("board:github:12:aa"), link, "the gate map relays the recorded link (the W153 pin pattern)");
  // The direct accessor mirrors recordRunOrigin.
  registry.recordWorkProductLink({ runId: "board:github:12:bb", link: { provider: "github", key: "#13", url: "https://github.com/o/r/issues/13" } });
  assert.equal(registry.workProductLinks().get("board:github:12:bb")?.key, "#13");
  // A begin without a link records none — linkage is never inferred.
  await registry.controller.begin({ runId: "agent-run", title: "plain" });
  assert.equal(registry.workProductLinks().has("agent-run"), false);

  // The client lane (/run/begin) never forwards a work-product link: only a
  // hub-side lane records the linkage (the W153 principle).
  const begins: Parameters<WorkflowRunController["begin"]>[0][] = [];
  const spy: WorkflowRunController = {
    async begin(input) {
      begins.push(input);
    },
    async finish() {},
    async review() {
      return { recorded: false };
    },
    hiddenSnapshotTaskIds() {
      return [];
    },
  };
  const bridge = await createWorkflowHubBridge(
    application(), undefined, spy, undefined, undefined, undefined, undefined, undefined,
  );
  try {
    const response = await fetch(`${bridge.url}/run/begin`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ runId: "client-run", title: "t", workProductLink: link }),
    });
    assert.equal(response.status, 200);
    assert.equal(begins.length, 1);
    assert.equal(begins[0]?.workProductLink, undefined, "a client-supplied work-product link must never reach begin");
  } finally {
    await bridge.close();
  }
});

test("W165: the work-product link map is bounded at 64 like the other gate maps — the oldest link is evicted first", () => {
  const registry = createRunRegistry(application(), new TaskGraph([seedTask]));
  for (let index = 0; index < 70; index += 1) {
    registry.recordWorkProductLink({
      runId: `link-${index}`,
      link: { provider: "github", key: `#${index}`, url: `https://github.com/o/r/pull/${index}` },
    });
  }
  assert.equal(registry.workProductLinks().size, 64, "the map is bounded at 64 like the other gate maps");
  assert.equal(registry.workProductLinks().has("link-0"), false, "the oldest link is evicted first");
  assert.equal(registry.workProductLinks().has("link-69"), true, "the freshest link survives");
});

test("W165: the provider PR-state read maps the linked reference's state verbatim — open/closed, draft when carried, as-of liveness, credential-free", async () => {
  // Distinctive on purpose: the no-leak assertion searches for the VALUE.
  const provider = githubProvider({ WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "tok-sup3r-secret-value-9f2c" });
  const { impl, calls } = stubFetch(200, JSON.stringify(pr(34, { draft: true })));
  const outcome = await fetchWorkProductState(provider, 34, impl);
  assert.equal(outcome.state, "ok");
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.deepEqual(
    { key: outcome.product.key, url: outcome.product.url, state: outcome.product.state, draft: outcome.product.draft },
    { key: "#34", url: "https://github.com/o/r/pull/34", state: "open", draft: true },
    "the provider's own fields map verbatim",
  );
  assert.match(outcome.product.asOf, /^\d{4}-\d{2}-\d{2}T/, "the read states its as-of liveness");
  assert.ok(!JSON.stringify(outcome).includes("tok-sup3r-secret-value-9f2c"), "the credential never rides the outcome");
  assert.equal(calls.length, 1, "one bounded, explicitly addressed request");
  assert.equal(calls[0]?.url, "https://api.github.com/repos/o/r/issues/34");
  assert.equal(calls[0]?.headers.authorization, "Bearer tok-sup3r-secret-value-9f2c");

  // A draft:false payload carries the flag verbatim (present, false).
  const notDraft = await fetchWorkProductState(provider, 35, stubFetch(200, JSON.stringify(pr(35, { draft: false }))).impl);
  assert.equal(notDraft.state === "ok" ? notDraft.product.draft : "sentinel", false);
  // A payload without a draft field maps the honest absence.
  const noDraft = await fetchWorkProductState(provider, 36, stubFetch(200, JSON.stringify(pr(36, { draft: undefined }))).impl);
  assert.equal(noDraft.state === "ok" ? noDraft.product.draft : "sentinel", undefined);
  // The provider's own closed state maps verbatim.
  const closed = await fetchWorkProductState(provider, 37, stubFetch(200, JSON.stringify(pr(37, { state: "closed" }))).impl);
  assert.equal(closed.state === "ok" ? closed.product.state : "sentinel", "closed");
});

test("W165: the provider PR-state read fails closed — unconfigured, provider faults, non-PR references, and malformed rows are honest errors", async () => {
  const provider = githubProvider();
  const notConfigured = await fetchWorkProductState(
    boardProviderFromEnv({ WORKFLOW_GITHUB_REPO: undefined, WORKFLOW_GITHUB_TOKEN: undefined }),
    34,
    stubFetch(200, "{}").impl,
  );
  assert.equal(notConfigured.state, "unconfigured");
  const rejected = await fetchWorkProductState(provider, 34, stubFetch(401, JSON.stringify({ message: "Bad credentials" })).impl);
  assert.equal(rejected.state, "error");
  assert.match(rejected.state === "error" ? rejected.reason : "", /401/);
  const failing = (async (): Promise<Response> => {
    throw new Error("connection refused");
  }) as typeof fetch;
  const unreachable = await fetchWorkProductState(provider, 34, failing);
  assert.equal(unreachable.state, "error");
  assert.match(unreachable.state === "error" ? unreachable.reason : "", /connection refused/);
  // The linked reference holds a plain issue (no pull_request marker): the
  // honest "no pull request at this reference" error — never a guessed state.
  const notAPullRequest = await fetchWorkProductState(provider, 12, stubFetch(200, JSON.stringify(plainIssue(12))).impl);
  assert.equal(notAPullRequest.state, "error");
  assert.match(notAPullRequest.state === "error" ? notAPullRequest.reason : "", /not a pull request/);
  // A row outside the provider's open/closed contract is an error, never a
  // coerced guess.
  const malformedState = await fetchWorkProductState(provider, 38, stubFetch(200, JSON.stringify(pr(38, { state: "merged" }))).impl);
  assert.equal(malformedState.state, "error");
  const malformedShape = await fetchWorkProductState(provider, 39, stubFetch(200, JSON.stringify({ pull_request: {} })).impl);
  assert.equal(malformedShape.state, "error");
  // A javascript: href can never ride the payload as the PR url.
  const hostile = await fetchWorkProductState(provider, 40, stubFetch(200, JSON.stringify(pr(40, { html_url: "javascript:alert(1)" }))).impl);
  assert.equal(hostile.state, "error");
});

test("W165: the hub-side join states each card's work product — unlinked without linkage, linked/unreadable from the hub's own reads", async () => {
  const links = new Map([
    ["board:github:12:r1", { provider: "github" as const, key: "#12", url: "https://github.com/o/r/issues/12" }],
    ["board:github:12:r4", { provider: "github" as const, key: "#12", url: "https://github.com/o/r/issues/12" }],
    ["board:github:13:r2", { provider: "github" as const, key: "#13", url: "https://github.com/o/r/issues/13" }],
    ["board:github:14:r3", { provider: "github" as const, key: "#14", url: "https://github.com/o/r/issues/14" }],
  ]);
  const reads = new Map<string, WorkProductStateOutcome>([
    ["#12", { state: "ok", product: { provider: "github", key: "#12", url: "https://github.com/o/r/pull/34", state: "open", draft: true, asOf: "2026-09-28T01:00:00Z" } }],
    ["#13", { state: "ok", product: { provider: "github", key: "#13", url: "https://github.com/o/r/pull/35", state: "closed", asOf: "2026-09-28T01:00:00Z" } }],
    ["#14", { state: "error", reason: "the provider answered 404" }],
  ]);
  const joined = await workProductStates(board, links, async (issueNumber) => reads.get(`#${issueNumber}`) ?? { state: "error", reason: "unexpected read" });
  assert.deepEqual(joined["#12"], {
    state: "linked",
    runId: "board:github:12:r4",
    product: { provider: "github", key: "#12", url: "https://github.com/o/r/pull/34", state: "open", draft: true, asOf: "2026-09-28T01:00:00Z" },
  }, "the most recently recorded link per reference wins");
  assert.deepEqual(joined["#13"], {
    state: "linked",
    runId: "board:github:13:r2",
    product: { provider: "github", key: "#13", url: "https://github.com/o/r/pull/35", state: "closed", asOf: "2026-09-28T01:00:00Z" },
  });
  assert.deepEqual(joined["#14"], { state: "unreadable", runId: "board:github:14:r3", reason: "the provider answered 404" }, "an unreadable hub read is the honest unreadable state");
  assert.deepEqual(joined["#15"], { state: "unlinked" }, "a card without linkage renders the honest unlinked state");
});

test("W165: /board/tasks carries the work-product states computed from the hub's own reads; absent authorities carry none", async () => {
  const boardOutcome = { state: "ok", board } as const;
  const reads = new Map<string, WorkProductStateOutcome>([
    ["#12", { state: "ok", product: { provider: "github", key: "#12", url: "https://github.com/o/r/pull/34", state: "open", asOf: "2026-09-28T01:00:00Z" } }],
  ]);
  const spy: WorkflowRunController = {
    async begin() {},
    async finish() {},
    async review() {
      return { recorded: false };
    },
    hiddenSnapshotTaskIds() {
      return [];
    },
    gateObservability() {
      return {
        reviewOutcomes: new Map(),
        blockingReasons: new Map(),
        completionClaims: new Map(),
        workProductLinks: new Map([["board:github:12:r1", { provider: "github", key: "#12", url: "https://github.com/o/r/issues/12" }]]),
      };
    },
  };
  const bridge = await createWorkflowHubBridge(
    application(), undefined, spy, undefined, undefined, undefined, undefined, undefined,
    {
      readBoardTasks: async () => boardOutcome,
      readWorkProductState: async (issueNumber: number) => reads.get(`#${issueNumber}`) ?? { state: "error", reason: "unexpected read" },
    },
  );
  try {
    const answered = await fetch(`${bridge.url}/board/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as { board?: unknown; workProducts?: Record<string, WorkProductCardState> };
    assert.deepEqual(payload.workProducts?.["#12"], {
      state: "linked",
      runId: "board:github:12:r1",
      product: { provider: "github", key: "#12", url: "https://github.com/o/r/pull/34", state: "open", asOf: "2026-09-28T01:00:00Z" },
    });
    assert.deepEqual(payload.workProducts?.["#15"], { state: "unlinked" }, "the hub's own join answers for every card");
  } finally {
    await bridge.close();
  }

  // A hub without the PR-state read capability (or without the registry's
  // link map) carries no work-product states — the honest subset; the column
  // does not appear from fabricated data.
  const bareBridge = await createWorkflowHubBridge(
    application(), undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { readBoardTasks: async () => boardOutcome },
  );
  try {
    const answered = await fetch(`${bareBridge.url}/board/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${bareBridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as { board?: unknown; workProducts?: unknown };
    assert.equal(payload.workProducts, undefined, "the authority does not exist on this hub — no fabricated join");
  } finally {
    await bareBridge.close();
  }
});

test("W165: the board renders the in_review column only when its hub payload exists — linked+open cards land there; other linked states keep their column verbatim; unlinked renders honestly", () => {
  const boardOutcome = { state: "ok", board } as const;
  const workProducts: Record<string, WorkProductCardState> = {
    "#12": { state: "linked", runId: "r1", product: { provider: "github", key: "#34", url: "https://github.com/o/r/pull/34", state: "open", draft: true, asOf: "2026-09-28T01:00:00Z" } },
    "#13": { state: "linked", runId: "r2", product: { provider: "github", key: "#35", url: "https://github.com/o/r/pull/35", state: "closed", asOf: "2026-09-28T01:00:00Z" } },
    "#14": { state: "unreadable", runId: "r3", reason: "the provider answered 404" },
    "#15": { state: "unlinked" },
  };
  const markup = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome, workProducts }));
  // The in_review column appears with its payload, between open and closed.
  assert.ok(markup.includes("in_review ("), "the column appears when the hub's work-product payload rides");
  const openChunk = markup.slice(markup.indexOf("open ("), markup.indexOf("in_review ("));
  const inReviewChunk = markup.slice(markup.indexOf("in_review ("), markup.indexOf("closed ("));
  const closedChunk = markup.slice(markup.indexOf("closed ("));
  // The linked+open card lands in in_review — and nowhere else.
  assert.ok(inReviewChunk.includes("Issue 12"), "the linked+open card lands in in_review");
  assert.ok(!openChunk.includes("Issue 12"), "it left the open column");
  assert.equal((markup.match(/Issue 12/g) ?? []).length, 1, "the card renders exactly once");
  // A linked PR in any other provider state keeps the card in its
  // state-owned column and renders the PR state verbatim.
  assert.ok(openChunk.includes("Issue 13"), "the linked closed-PR card keeps the open column");
  assert.ok(openChunk.includes(">#35<") && openChunk.includes("closed"), "the provider PR state renders verbatim");
  assert.ok(openChunk.includes("draft") === false, "a draft:false payload renders no draft label");
  assert.ok(inReviewChunk.includes(">#34<") && inReviewChunk.includes("draft"), "the draft flag renders verbatim");
  assert.ok(markup.includes("as of 2026-09-28T01:00:00Z"), "the read's as-of liveness is stated");
  // The unreadable read renders its reason verbatim.
  assert.ok(closedChunk.includes("Issue 14"), "the unreadable card keeps its state-owned column");
  assert.ok(markup.includes("the provider answered 404"));
  // The unlinked card renders the honest unlinked state.
  assert.ok(openChunk.includes("Issue 15") && markup.includes("unlinked"));
  // Without the payload (a hub predating the slice) the column does not
  // appear — the honest subset (amendment 3).
  const without = renderToStaticMarkup(createElement(BoardView, { board: boardOutcome }));
  assert.ok(!without.includes("in_review"), "no authority, no column");
});

test("W165: the delegate flow records the work-product linkage at begin — from the hub's own provider read, never the client's claim", async () => {
  const begins: Parameters<WorkflowRunController["begin"]>[0][] = [];
  const spy: WorkflowRunController = {
    async begin(input) {
      begins.push(input);
    },
    async finish() {},
    async review() {
      return { recorded: false };
    },
    hiddenSnapshotTaskIds() {
      return [];
    },
  };
  const okTask: ExternalTask = {
    provider: "github", key: "#12", title: "Fix the flaky test", state: "open",
    url: "https://github.com/o/r/issues/12", labels: [], updatedAt: "2026-09-28T00:00:00Z",
  };
  const bridge = await createWorkflowHubBridge(
    application(), undefined, spy, undefined, undefined, undefined, undefined, undefined,
    { delegateBoardTask: async () => ({ state: "ok", task: okTask }) },
  );
  try {
    const response = await fetch(`${bridge.url}/board/delegate`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ issue: 12, workProductLink: { provider: "github", key: "#99", url: "https://github.com/o/r/pull/99" } }),
    });
    assert.equal(response.status, 200);
    assert.equal(begins.length, 1);
    assert.deepEqual(
      begins[0]?.workProductLink,
      { provider: "github", key: "#12", url: "https://github.com/o/r/issues/12" },
      "the linkage comes from the hub's OWN provider read — a client-supplied link in the body is ignored",
    );
  } finally {
    await bridge.close();
  }
});

// W171 — provider-owned PR discovery (the linked+open in_review state is
// unreachable while the only producer records the delegated board ISSUE's
// reference): the issue timeline's cross-referenced PR is discovered
// PROVIDER-SIDE, reported hub-side through the route's onDiscovered, and the
// PR's own state decides the card. Zero or multiple cross-references stay
// honestly unreadable naming the ambiguity — never a guess.
// Focused-run discipline: node --import tsx --test
// test/work-product-linkage.test.ts.

const crossReference = (number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: "cross-referenced",
  source: {
    type: "issue",
    issue: {
      number,
      html_url: `https://github.com/o/r/pull/${number}`,
      pull_request: { url: `https://api.github.com/repos/o/r/pulls/${number}` },
    },
  },
  ...overrides,
});

// A URL-routed stub: the discovery lane reads the board issue, the issue's
// timeline, and the discovered PR through one bounded fetch (the stubFetch
// pattern, routed per URL).
const routingFetch = (routes: Record<string, string>) => {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
};

test("W171: the not-a-pull-request read error carries the machine marker the discovery lane keys on — every other error site omits it", async () => {
  const provider = githubProvider();
  const notAPullRequest = await fetchWorkProductState(provider, 12, stubFetch(200, JSON.stringify(plainIssue(12))).impl);
  assert.equal(notAPullRequest.state, "error");
  if (notAPullRequest.state !== "error") return assert.fail("expected the not-a-pull-request error");
  assert.equal(notAPullRequest.reason, "#12 is not a pull request");
  assert.equal(notAPullRequest.notPullRequest, true, "the marker rides ONLY the not-a-pull-request error site");
  // Every other error site omits the marker — the discovery join keys on it.
  const rejected = await fetchWorkProductState(provider, 12, stubFetch(401, "{}").impl);
  if (rejected.state !== "error") return assert.fail("expected the provider-fault error");
  assert.equal(rejected.notPullRequest, undefined, "a provider fault carries no marker");
  const malformed = await fetchWorkProductState(provider, 12, stubFetch(200, JSON.stringify({ pull_request: {} })).impl);
  if (malformed.state !== "error") return assert.fail("expected the malformed-shape error");
  assert.equal(malformed.notPullRequest, undefined, "a malformed row carries no marker");
});

test("W171: fetchIssueCrossReferences reads the timeline's cross-referenced PRs — guarded rows, skipped counted, honest faults", async () => {
  // Distinctive on purpose: the no-leak assertion searches for the VALUE.
  const provider = githubProvider({ WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "tok-sup3r-secret-value-9f2c" });
  const timeline = JSON.stringify([
    crossReference(34),
    { event: "closed" },
    crossReference(35, { source: { type: "issue", issue: { number: 35, html_url: "https://github.com/o/r/pull/35" } } }),
    crossReference(36, { source: { type: "issue", issue: { number: 36, html_url: "javascript:alert(1)", pull_request: {} } } }),
    "junk",
    crossReference(37, { source: { type: "issue", issue: { number: "37", html_url: "https://github.com/o/r/pull/37", pull_request: {} } } }),
  ]);
  const { impl, calls } = stubFetch(200, timeline);
  const outcome = await fetchIssueCrossReferences(provider, 12, impl);
  assert.equal(outcome.state, "ok");
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.deepEqual(outcome.refs, [{ key: "#34", url: "https://github.com/o/r/pull/34" }], "exactly the guarded cross-references");
  assert.equal(outcome.skipped, 5, "malformed rows are skipped and COUNTED, never rendered");
  assert.equal(calls.length, 1, "one bounded, explicitly addressed request");
  assert.equal(calls[0]?.url, "https://api.github.com/repos/o/r/issues/12/timeline");
  assert.equal(calls[0]?.headers.accept, "application/vnd.github+json", "the timeline accepts the same header");
  assert.ok(!JSON.stringify(outcome).includes("tok-sup3r-secret-value-9f2c"), "the credential never rides the outcome");

  // The azure_devops-configured hub mirrors the work-product read's arm:
  // unconfigured NAMING the GitHub declaration — never a fabricated
  // discovery through the wrong lane.
  const ado = await fetchIssueCrossReferences({ kind: "azure_devops", org: "o", project: "p", token: "t" }, 12, impl);
  assert.deepEqual(
    ado,
    { state: "unconfigured", missing: ["WORKFLOW_GITHUB_REPO (the cross-reference read is GitHub-only; the azure_devops lane serves no cross-reference read)"] },
  );
  const unconfigured = await fetchIssueCrossReferences(boardProviderFromEnv({}), 12, impl);
  assert.equal(unconfigured.state, "unconfigured");

  const rejected = await fetchIssueCrossReferences(provider, 12, stubFetch(401, "{}").impl);
  assert.equal(rejected.state, "error");
  assert.match(rejected.state === "error" ? rejected.reason : "", /401/);
  const failing = (async (): Promise<Response> => {
    throw new Error("connection refused");
  }) as typeof fetch;
  const unreachable = await fetchIssueCrossReferences(provider, 12, failing);
  assert.equal(unreachable.state, "error");
  assert.match(unreachable.state === "error" ? unreachable.reason : "", /connection refused/);
  const notJson = await fetchIssueCrossReferences(provider, 12, stubFetch(200, "not json").impl);
  assert.equal(notJson.state, "error");
  const notList = await fetchIssueCrossReferences(provider, 12, stubFetch(200, "{}").impl);
  assert.equal(notList.state, "error");
});

test("W171: the join discovers the linked board issue's actual PR from the provider timeline — exactly one cross-referenced PR lands the linked card state via the PR's own read", async () => {
  const provider = githubProvider();
  const { impl, calls } = routingFetch({
    "https://api.github.com/repos/o/r/issues/12": JSON.stringify(plainIssue(12)),
    "https://api.github.com/repos/o/r/issues/12/timeline": JSON.stringify([crossReference(34)]),
    "https://api.github.com/repos/o/r/issues/34": JSON.stringify(pr(34, { draft: true })),
  });
  const links = new Map([["board:github:12:r1", { provider: "github" as const, key: "#12", url: "https://github.com/o/r/issues/12" }]]);
  const reported: { runId: string; key: string; url: string }[] = [];
  const joined = await workProductStates(
    board,
    links,
    (issueNumber) => fetchWorkProductState(provider, issueNumber, impl),
    (issueNumber) => fetchIssueCrossReferences(provider, issueNumber, impl),
    (runId, ref) => {
      reported.push({ runId, key: ref.key, url: ref.url });
    },
  );
  // The exact shape the W165 render test pins for card #12 → product #34,
  // now produced by the pipeline from a timeline fixture.
  if (joined["#12"]?.state !== "linked") return assert.fail("expected the discovered linked state");
  assert.equal(joined["#12"].runId, "board:github:12:r1");
  assert.deepEqual(
    { key: joined["#12"].product.key, url: joined["#12"].product.url, state: joined["#12"].product.state, draft: joined["#12"].product.draft },
    { key: "#34", url: "https://github.com/o/r/pull/34", state: "open", draft: true },
    "the PR's own state decides the card",
  );
  assert.match(joined["#12"].product.asOf, /^\d{4}-\d{2}-\d{2}T/, "the read's as-of liveness rides the discovered product");
  assert.deepEqual(
    calls,
    [
      "https://api.github.com/repos/o/r/issues/12",
      "https://api.github.com/repos/o/r/issues/12/timeline",
      "https://api.github.com/repos/o/r/issues/34",
    ],
    "the discovery pipeline: the issue read, the timeline read, the PR's own read",
  );
  assert.deepEqual(
    reported,
    [{ runId: "board:github:12:r1", key: "#34", url: "https://github.com/o/r/pull/34" }],
    "the join REPORTS the discovered reference — the recording is the route's onDiscovered",
  );
});

test("W171: the join stays honestly unreadable when discovery is ambiguous, empty, faulted, or unconfigured", async () => {
  const links = new Map([["board:github:12:r1", { provider: "github" as const, key: "#12", url: "https://github.com/o/r/issues/12" }]]);
  const read = async (): Promise<WorkProductStateOutcome> => ({ state: "error", reason: "#12 is not a pull request", notPullRequest: true });

  // Two cross-referenced PRs — the ambiguity is NAMED with its count, never
  // a guess between them.
  const ambiguous = await workProductStates(
    board,
    links,
    read,
    async () => ({
      state: "ok",
      refs: [
        { key: "#34", url: "https://github.com/o/r/pull/34" },
        { key: "#35", url: "https://github.com/o/r/pull/35" },
      ],
      skipped: 0,
    }),
  );
  assert.deepEqual(
    ambiguous["#12"],
    { state: "unreadable", runId: "board:github:12:r1", reason: "the issue's timeline cross-references 2 pull requests; the work product is ambiguous" },
  );

  // Zero cross-referenced PRs — the unchanged not-a-pull-request reason.
  const empty = await workProductStates(board, links, read, async () => ({ state: "ok", refs: [], skipped: 0 }));
  assert.deepEqual(empty["#12"], { state: "unreadable", runId: "board:github:12:r1", reason: "#12 is not a pull request" });

  // A faulted discovery rides its verbatim reason.
  const faulted = await workProductStates(board, links, read, async () => ({ state: "error", reason: "the provider answered 502" }));
  assert.deepEqual(faulted["#12"], { state: "unreadable", runId: "board:github:12:r1", reason: "the provider answered 502" });

  // An unconfigured discovery names the missing declaration.
  const unconfigured = await workProductStates(board, links, read, async () => ({ state: "unconfigured", missing: ["WORKFLOW_GITHUB_REPO"] }));
  assert.deepEqual(unconfigured["#12"], { state: "unreadable", runId: "board:github:12:r1", reason: "the provider is not configured (WORKFLOW_GITHUB_REPO)" });
});

test("W171: discover absent keeps today's join behavior — the not-a-pull-request reason rides unreadable unchanged (green-by-construction)", async () => {
  // The W165 join pin above stays the byte-identical proof; this pin states
  // the degrade contract explicitly: without the discovery capability the
  // join performs one read per linked card and never invents a discovery.
  const links = new Map([["board:github:12:r1", { provider: "github" as const, key: "#12", url: "https://github.com/o/r/issues/12" }]]);
  let reads = 0;
  const joined = await workProductStates(board, links, async (issueNumber) => {
    reads += 1;
    return { state: "error", reason: `#${issueNumber} is not a pull request`, notPullRequest: true };
  });
  assert.deepEqual(joined["#12"], { state: "unreadable", runId: "board:github:12:r1", reason: "#12 is not a pull request" });
  assert.equal(reads, 1, "one read per linked card — no discovery lane exists");
});

test("W171: /board/tasks records the discovered PR through the controller — the registry map gains the cross-referenced reference", async () => {
  const registry = createRunRegistry(application(), new TaskGraph([seedTask]));
  registry.recordWorkProductLink({ runId: "board:github:12:r1", link: { provider: "github", key: "#12", url: "https://github.com/o/r/issues/12" } });
  const provider = githubProvider();
  const { impl } = routingFetch({
    "https://api.github.com/repos/o/r/issues/12": JSON.stringify(plainIssue(12)),
    "https://api.github.com/repos/o/r/issues/12/timeline": JSON.stringify([crossReference(34)]),
    "https://api.github.com/repos/o/r/issues/34": JSON.stringify(pr(34, { draft: true })),
  });
  const boardOutcome = { state: "ok", board } as const;
  const bridge = await createWorkflowHubBridge(
    application(), undefined, registry.controller, undefined, undefined, undefined, undefined, undefined,
    {
      readBoardTasks: async () => boardOutcome,
      readWorkProductState: (issueNumber: number) => fetchWorkProductState(provider, issueNumber, impl),
      discoverIssueCrossReferences: (issueNumber: number) => fetchIssueCrossReferences(provider, issueNumber, impl),
    },
  );
  try {
    const answered = await fetch(`${bridge.url}/board/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as { workProducts?: Record<string, WorkProductCardState> };
    if (payload.workProducts?.["#12"]?.state !== "linked") return assert.fail("expected the discovered linked state on the route payload");
    assert.equal(payload.workProducts["#12"]?.runId, "board:github:12:r1");
    assert.equal(payload.workProducts["#12"]?.product.key, "#34");
    // The recording is registry-backed through the controller's OPTIONAL
    // method: the NEXT read composes from the discovered reference directly.
    assert.deepEqual(
      registry.workProductLinks().get("board:github:12:r1"),
      { provider: "github", key: "#34", url: "https://github.com/o/r/pull/34" },
      "the registry map gains the discovered reference — hub-side bookkeeping, never client-supplied",
    );
  } finally {
    await bridge.close();
  }
});
