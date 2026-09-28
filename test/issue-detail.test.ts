import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  boardProviderFromEnv,
  fetchBoardTasks,
  type GitHubBoardProviderState,
  type GitHubIssuePayload,
} from "../src/integrations/task-provider.js";
import {
  classifyProviderRead,
  createProviderReadLedger,
  fetchIssueDetail,
  recordProviderReads,
  type IssueDetailOutcome,
} from "../src/integrations/issue-detail.js";
import { BOARD_LIVENESS_TTL_MS, boardLinkLiveness } from "../src/ui/webapp/presenters.js";
import { BoardIssueDetailView, BoardView, isIssueDetailOutcome, type IssueDetailAnswer } from "../src/ui/webapp/board-view.js";
import { createWorkflowHubBridge } from "../src/integrations/hub-http.js";
import { createWorkflowHub } from "../src/integrations/workflow-hub.js";
import { createWorkflowWebServer } from "../src/ui/web.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";

// W167 — issue detail + external-reference liveness (Paperclip borrow,
// board issue #319). The registered pins:
//   1. the hub-side issue-detail provider read (description + comment
//      thread) reuses the shared provider discipline: injectable fetch,
//      bounded requests, a per-row shape guard that skips and COUNTS
//      malformed rows, honest unconfigured/error states, and the credential
//      never in any payload (pinned by VALUE);
//   2. the liveness pills derive ONLY from the hub-recorded provider read
//      state (Fresh within the TTL / Stale beyond it / Requires-auth for a
//      401/403-class answer / Unreachable for transport failures and 5xx) —
//      a hub with no record renders NO pill, never a claimed freshness;
//   3. NOT-fresh renders dashed (the distinct honest style);
//   4. no attribution the records do not carry: a skipped comment row is
//      never replaced by a synthesized author, timestamp, or count;
//   5. operator-authored comments are NOT taken (the proposal decision):
//      there is no write path; the amendment-1 dispatch class is its own
//      iteration.
// Scope cut (registered): no comment composition, no checkout locks.

const provider = (env: Record<string, string | undefined> = { WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "t" }): GitHubBoardProviderState => {
  const state = boardProviderFromEnv(env);
  assert.equal(state.kind, "github");
  return state as GitHubBoardProviderState & { kind: "github" };
};

/** A fetch stub routed by URL fragment — the detail read makes TWO provider
 * calls (the issue, then its comments), so the stub serves both. More
 * specific fragments must come first ("issues/12/comments" before
 * "issues/12"). */
const routeFetch = (routes: Record<string, { status: number; body: string }>) => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key] = value;
    const url = String(input);
    calls.push({ url, headers });
    const route = Object.entries(routes).find(([fragment]) => url.includes(fragment))?.[1];
    if (route === undefined) return new Response("{}", { status: 404 });
    return new Response(route.body, { status: route.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
};

const issuePayload = (overrides: Partial<GitHubIssuePayload> & { readonly body?: unknown } = {}): GitHubIssuePayload & { readonly body?: unknown } => ({
  url: "https://api.github.com/repos/o/r/issues/12",
  number: 12,
  title: "Fix the flaky test",
  state: "open",
  labels: [],
  assignee: null,
  updated_at: "2026-09-27T00:00:00Z",
  html_url: "https://github.com/o/r/issues/12",
  ...overrides,
});

const commentPayload = (login: string, body: string, createdAt: string): unknown => ({
  user: { login },
  body,
  created_at: createdAt,
});

const seedTask: WorkflowTask = {
  id: taskId("seed"),
  title: "seed",
  state: "READY",
  dependencies: [],
  requiredEvidence: [],
};

const application = () => new WorkflowApplication(new TaskGraph([seedTask]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));

const boardOutcome = {
  state: "ok",
  board: {
    provider: "github",
    repo: "o/r",
    tasks: [{
      provider: "github", key: "#12", title: "a task", state: "open",
      url: "https://github.com/o/r/issues/12", labels: [], updatedAt: "2026-09-27T00:00:00Z",
    }],
    skipped: 0,
    pullRequestsExcluded: 0,
  },
} as const;

// ── 1. The provider read: description + thread, verbatim, credential-free ──

test("W167: the issue-detail read maps the description and thread verbatim, makes two bounded provider calls, and never leaks the credential", async () => {
  const routes = {
    "issues/12/comments": {
      status: 200,
      body: JSON.stringify([
        commentPayload("hunter", "reproduced on 3.0.62", "2026-09-27T10:00:00Z"),
        commentPayload("model", "delegation run started", "2026-09-27T11:00:00Z"),
      ]),
    },
    "issues/12": { status: 200, body: JSON.stringify(issuePayload({ body: "Step 1: repro\nStep 2: fix" })) },
  };
  const { impl, calls } = routeFetch(routes);
  // Distinctive on purpose: the no-leak assertion searches for the VALUE.
  const p = provider({ WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "tok-sup3r-secret-value-9f2c" });
  const outcome = await fetchIssueDetail(p, 12, impl);
  assert.equal(outcome.state, "ok");
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(outcome.detail.key, "#12");
  assert.equal(outcome.detail.title, "Fix the flaky test");
  assert.equal(outcome.detail.description, "Step 1: repro\nStep 2: fix");
  assert.deepEqual(outcome.detail.comments, [
    { author: "hunter", body: "reproduced on 3.0.62", createdAt: "2026-09-27T10:00:00Z" },
    { author: "model", body: "delegation run started", createdAt: "2026-09-27T11:00:00Z" },
  ]);
  assert.equal(outcome.detail.commentsSkipped, 0);
  // The credential never rides the mapped outcome — searched by VALUE.
  assert.ok(!JSON.stringify(outcome).includes("tok-sup3r-secret-value-9f2c"));
  // Two bounded, explicitly addressed provider calls.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://api.github.com/repos/o/r/issues/12");
  assert.equal(calls[1]?.url, "https://api.github.com/repos/o/r/issues/12/comments?per_page=100");
  assert.equal(calls[0]?.headers.authorization, "Bearer tok-sup3r-secret-value-9f2c");
  assert.equal(calls[1]?.headers.authorization, "Bearer tok-sup3r-secret-value-9f2c");
  assert.equal(calls[0]?.headers.accept, "application/vnd.github+json");
});

test("W167: the thread shape guard skips and counts malformed comment rows — never a throw, never a synthesized author, timestamp, or body", async () => {
  const routes = {
    "issues/12/comments": {
      status: 200,
      body: JSON.stringify([
        commentPayload("hunter", "kept", "2026-09-27T10:00:00Z"),
        { body: "no author", created_at: "2026-09-27T10:01:00Z" }, // no user: skipped
        { user: { login: 42 }, body: "wrong-typed author", created_at: "2026-09-27T10:02:00Z" }, // skipped
        { user: { login: "model" }, body: 42, created_at: "2026-09-27T10:03:00Z" }, // skipped
        { user: { login: "model" }, body: "no timestamp" }, // skipped
        { user: null, body: "null author", created_at: "2026-09-27T10:04:00Z" }, // skipped
        "a bare string row", // skipped
      ]),
    },
    "issues/12": { status: 200, body: JSON.stringify(issuePayload()) },
  };
  const { impl } = routeFetch(routes);
  const outcome = await fetchIssueDetail(provider(), 12, impl);
  assert.equal(outcome.state, "ok");
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(outcome.detail.commentsSkipped, 6);
  assert.deepEqual(outcome.detail.comments, [
    { author: "hunter", body: "kept", createdAt: "2026-09-27T10:00:00Z" },
  ]);
});

test("W167: an absent description stays absent — a null or empty provider body is never coerced into a description", async () => {
  for (const body of [null, ""]) {
    const { impl } = routeFetch({
      "issues/12/comments": { status: 200, body: JSON.stringify([]) },
      "issues/12": { status: 200, body: JSON.stringify(issuePayload({ body })) },
    });
    const outcome = await fetchIssueDetail(provider(), 12, impl);
    assert.equal(outcome.state, "ok");
    if (outcome.state !== "ok") return assert.fail("expected ok");
    assert.equal(outcome.detail.description, undefined, `a ${JSON.stringify(body)} body must stay absent`);
  }
});

test("W167: the detail read fails closed — unconfigured env, PR keys, malformed payloads, and provider faults stay honest errors", async () => {
  const unconfigured = await fetchIssueDetail(
    boardProviderFromEnv({ WORKFLOW_GITHUB_REPO: undefined, WORKFLOW_GITHUB_TOKEN: undefined }),
    12,
    routeFetch({}).impl,
  );
  assert.equal(unconfigured.state, "unconfigured");
  assert.deepEqual(unconfigured.state === "unconfigured" ? unconfigured.missing : [], ["WORKFLOW_GITHUB_REPO", "WORKFLOW_GITHUB_TOKEN"]);
  const p = provider();
  // The provider's refusal carries its machine-readable status — the liveness
  // record classifies the 401/403 class from it (the reason string is never
  // parsed).
  const notFound = await fetchIssueDetail(p, 404, routeFetch({ "issues/404": { status: 404, body: JSON.stringify({ message: "Not Found" }) } }).impl);
  assert.equal(notFound.state, "error");
  assert.match(notFound.state === "error" ? notFound.reason : "", /404/);
  assert.equal(notFound.state === "error" ? notFound.status : 0, 404);
  const pullRequest = await fetchIssueDetail(p, 3, routeFetch({
    "issues/3": { status: 200, body: JSON.stringify(issuePayload({ number: 3, pull_request: { url: "https://api.github.com/repos/o/r/pulls/3" } })) },
  }).impl);
  assert.equal(pullRequest.state, "error");
  assert.match(pullRequest.state === "error" ? pullRequest.reason : "", /pull request/);
  const malformed = await fetchIssueDetail(p, 9, routeFetch({
    "issues/9": { status: 200, body: JSON.stringify({ number: "nine" }) },
  }).impl);
  assert.equal(malformed.state, "error");
  // A href-unsafe html_url is malformed — the same javascript:/data: pin the
  // board's row guard carries.
  const unsafeHref = await fetchIssueDetail(p, 5, routeFetch({
    "issues/5": { status: 200, body: JSON.stringify(issuePayload({ number: 5, html_url: "javascript:alert(1)" })) },
  }).impl);
  assert.equal(unsafeHref.state, "error");
  // A transport failure is an honest error with NO machine status (there was
  // no provider answer to classify).
  const failing = (async (): Promise<Response> => {
    throw new Error("connection refused");
  }) as typeof fetch;
  const unreachable = await fetchIssueDetail(p, 12, failing);
  assert.equal(unreachable.state, "error");
  assert.match(unreachable.state === "error" ? unreachable.reason : "", /connection refused/);
  assert.equal(unreachable.state === "error" ? unreachable.status : 0, undefined);
  // A thread read that fails after a good issue read errs the WHOLE read —
  // never a half detail with a fabricated empty thread.
  const halfFailed = await fetchIssueDetail(p, 12, routeFetch({
    "issues/12/comments": { status: 500, body: "boom" },
    "issues/12": { status: 200, body: JSON.stringify(issuePayload()) },
  }).impl);
  assert.equal(halfFailed.state, "error");
  assert.match(halfFailed.state === "error" ? halfFailed.reason : "", /500/);
});

test("W167: a full first comment page is flagged truncated — the thread states its bound instead of implying completeness", async () => {
  const page = Array.from({ length: 100 }, (_, index) => commentPayload(`user-${index}`, "row", "2026-09-27T10:00:00Z"));
  const { impl } = routeFetch({
    "issues/12/comments": { status: 200, body: JSON.stringify(page) },
    "issues/12": { status: 200, body: JSON.stringify(issuePayload()) },
  });
  const outcome = await fetchIssueDetail(provider(), 12, impl);
  assert.equal(outcome.state, "ok");
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(outcome.detail.commentsTruncated, true);
  assert.equal(outcome.detail.comments.length, 100);
});

// ── 2. The hub-recorded read state: the ONLY source the pills derive from ──

test("W167: the ledger records the provider read's machine class at read time — ok, requires-auth (401/403), unreachable (transport/5xx) — and never fabricates a record for an unconfigured hub", () => {
  const fixed = createProviderReadLedger(() => new Date(1_700_000_000_000));
  // No provider read yet: NO record exists (nothing may claim freshness).
  assert.equal(fixed.current(), undefined);
  // An unconfigured hub never contacted the provider: still no record.
  fixed.record({ state: "unconfigured", missing: ["WORKFLOW_GITHUB_TOKEN"] });
  assert.equal(fixed.current(), undefined);
  fixed.record({ state: "ok" });
  assert.deepEqual(fixed.current(), { at: new Date(1_700_000_000_000).toISOString(), outcome: "ok" });
  fixed.record({ state: "error", reason: "the provider answered 401: Bad credentials", status: 401 });
  assert.deepEqual(fixed.current(), {
    at: new Date(1_700_000_000_000).toISOString(),
    outcome: "requires-auth",
    reason: "the provider answered 401: Bad credentials",
  });
  fixed.record({ state: "error", reason: "the provider answered 403: Forbidden", status: 403 });
  assert.equal(fixed.current()?.outcome, "requires-auth");
  fixed.record({ state: "error", reason: "the provider answered 500", status: 500 });
  assert.equal(fixed.current()?.outcome, "unreachable");
  fixed.record({ state: "error", reason: "connection refused" });
  assert.equal(fixed.current()?.outcome, "unreachable");
  // The classifier itself, pinned per class boundary.
  assert.equal(classifyProviderRead(undefined), "unreachable");
  assert.equal(classifyProviderRead(401), "requires-auth");
  assert.equal(classifyProviderRead(403), "requires-auth");
  assert.equal(classifyProviderRead(500), "unreachable");
});

test("W167: the wrapped provider read records through the closure — the outcome passes through unchanged and the real board read carries its status", async () => {
  const ledger = createProviderReadLedger();
  const outcome: IssueDetailOutcome = { state: "ok", detail: { provider: "github", key: "#12", title: "t", comments: [], commentsSkipped: 0 } };
  const read = recordProviderReads(ledger, async () => outcome);
  const answered = await read();
  assert.deepEqual(answered, outcome);
  assert.equal(ledger.current()?.outcome, "ok");
  // The real board read's refusal carries the machine status the recorder
  // classifies (the additive companion to the human reason string).
  const rejected = await fetchBoardTasks(provider(), (async (): Promise<Response> => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as typeof fetch);
  assert.equal(rejected.state, "error");
  assert.equal(rejected.state === "error" ? rejected.status : 0, 401);
});

// ── 3. The pill derivation: all four classes, from the record only ──

test("W167: the pill derives ONLY from the recorded read state — fresh within the TTL, stale beyond it, requires-auth and unreachable verbatim, and NO pill without a record", () => {
  const now = 1_700_000_000_000;
  const at = (age: number): string => new Date(now - age).toISOString();
  assert.ok(BOARD_LIVENESS_TTL_MS > 0);
  assert.equal(boardLinkLiveness({ at: at(0), outcome: "ok" }, now), "fresh");
  // The TTL boundary is inclusive: a read exactly TTL old is still fresh.
  assert.equal(boardLinkLiveness({ at: at(BOARD_LIVENESS_TTL_MS), outcome: "ok" }, now), "fresh");
  assert.equal(boardLinkLiveness({ at: at(BOARD_LIVENESS_TTL_MS + 1), outcome: "ok" }, now), "stale");
  // A fault record never ages into stale — stale means "successful but old".
  assert.equal(boardLinkLiveness({ at: at(0), outcome: "requires-auth" }, now), "requires-auth");
  assert.equal(boardLinkLiveness({ at: at(10 * BOARD_LIVENESS_TTL_MS), outcome: "requires-auth" }, now), "requires-auth");
  assert.equal(boardLinkLiveness({ at: at(0), outcome: "unreachable" }, now), "unreachable");
  // No record (the hub has performed no provider read, or predates the
  // record): NO pill — no freshness may be claimed from nothing.
  assert.equal(boardLinkLiveness(undefined, now), undefined);
  assert.equal(boardLinkLiveness(null, now), undefined);
  // A recorded instant the clock cannot parse claims nothing either.
  assert.equal(boardLinkLiveness({ at: "not-a-date", outcome: "ok" }, now), undefined);
});

// ── 4. The pills render on the provider links; NOT-fresh renders dashed ──

test("W167: fresh renders the pill solid; NOT-fresh renders the pill and the provider link dashed; no record renders neither", () => {
  const view = (read: { at: string; outcome: "ok" | "requires-auth" | "unreachable"; reason?: string } | null | undefined): string =>
    renderToStaticMarkup(createElement(BoardView, { board: boardOutcome, read }));
  const fresh = view({ at: new Date().toISOString(), outcome: "ok" });
  assert.ok(fresh.includes("board-liveness"), "a recorded fresh read must render the pill");
  assert.ok(fresh.includes("fresh"));
  assert.ok(!fresh.includes("board-link-not-fresh"), "a fresh provider link must not render dashed");
  const notFreshCases = [
    [{ at: new Date(Date.now() - BOARD_LIVENESS_TTL_MS - 1).toISOString(), outcome: "ok" }, "stale", "board-liveness-stale"],
    [{ at: new Date().toISOString(), outcome: "requires-auth" }, "requires auth", "board-liveness-requires-auth"],
    [{ at: new Date().toISOString(), outcome: "unreachable" }, "unreachable", "board-liveness-unreachable"],
  ] as const;
  for (const [record, label, pillClass] of notFreshCases) {
    const markup = view(record);
    assert.ok(markup.includes(pillClass), `the ${label} pill must render`);
    assert.ok(markup.includes(label), `the ${label} label must render`);
    assert.ok(markup.includes("board-link-not-fresh"), `a ${label} provider link must render dashed`);
  }
  // The requires-auth pill carries the hub's verbatim reason (never laundered).
  const refused = view({ at: new Date().toISOString(), outcome: "requires-auth", reason: "the provider answered 401: Bad credentials" });
  assert.ok(refused.includes("the provider answered 401: Bad credentials"));
  // No record at all: neither a pill nor a dashed link — nothing claimed.
  for (const absent of [undefined, null]) {
    const markup = view(absent);
    assert.ok(!markup.includes("board-liveness"), "no record must render no pill");
    assert.ok(!markup.includes("board-link-not-fresh"), "no record must not render dashed");
  }
});

// ── 5. The detail surface: verbatim records, honest states, no synthesis ──

test("W167: the detail view renders the provider's description and thread verbatim — never a synthesized author, timestamp, or count", () => {
  const detail: IssueDetailOutcome = {
    state: "ok",
    detail: {
      provider: "github",
      key: "#12",
      title: "Fix the flaky test",
      description: "Step 1: repro\nStep 2: fix",
      comments: [
        { author: "hunter", body: "reproduced on 3.0.62", createdAt: "2026-09-27T10:00:00Z" },
      ],
      commentsSkipped: 2,
    },
  };
  const markup = renderToStaticMarkup(createElement(BoardIssueDetailView, { answer: { kind: "detail", outcome: detail } satisfies IssueDetailAnswer }));
  assert.ok(markup.includes("Step 1: repro"));
  assert.ok(markup.includes("Step 2: fix"));
  assert.ok(markup.includes("@hunter"), "the provider-supplied author renders verbatim");
  assert.ok(markup.includes("reproduced on 3.0.62"), "the provider-supplied body renders verbatim");
  assert.ok(markup.includes("2026-09-27"), "the provider-supplied date renders verbatim");
  assert.ok(markup.includes("2 provider rows skipped"), "skipped rows are counted, never rendered");
  assert.ok(!markup.includes("more may exist"));
  // The no-synthesis pins: nothing in the surface invents attribution the
  // records do not carry.
  assert.ok(!markup.includes("Anonymous"));
  assert.ok(!markup.includes("@unknown"));
  assert.ok(!markup.includes("just now"));
  // An absent description and an empty thread render their honest absences.
  const absent: IssueDetailOutcome = {
    state: "ok",
    detail: { provider: "github", key: "#12", title: "Fix the flaky test", comments: [], commentsSkipped: 0 },
  };
  const absentMarkup = renderToStaticMarkup(createElement(BoardIssueDetailView, { answer: { kind: "detail", outcome: absent } satisfies IssueDetailAnswer }));
  assert.ok(absentMarkup.includes("the provider supplied no description"));
  assert.ok(absentMarkup.includes("no comments"));
  // A truncated thread states its bound.
  const truncated: IssueDetailOutcome = {
    state: "ok",
    detail: { provider: "github", key: "#12", title: "t", comments: [{ author: "a", body: "b", createdAt: "2026-09-27T10:00:00Z" }], commentsSkipped: 0, commentsTruncated: true },
  };
  assert.ok(renderToStaticMarkup(createElement(BoardIssueDetailView, { answer: { kind: "detail", outcome: truncated } satisfies IssueDetailAnswer })).includes("more may exist"));
});

test("W167: the detail surface's failure states render honestly — unconfigured, provider error, and a withheld capability verbatim", () => {
  const unconfigured = renderToStaticMarkup(createElement(BoardIssueDetailView, {
    answer: { kind: "detail", outcome: { state: "unconfigured", missing: ["WORKFLOW_GITHUB_TOKEN"] } } satisfies IssueDetailAnswer,
  }));
  assert.ok(unconfigured.includes("no provider configured on the hub"));
  const errored = renderToStaticMarkup(createElement(BoardIssueDetailView, {
    answer: { kind: "detail", outcome: { state: "error", reason: "the provider answered 401: Bad credentials" } } satisfies IssueDetailAnswer,
  }));
  assert.ok(errored.includes("the provider could not be read — the provider answered 401: Bad credentials"));
  // The rendered-deny pattern: a withheld capability (the hub's 404) renders
  // the refusal verbatim with its code, as an alert.
  const withheld = renderToStaticMarkup(createElement(BoardIssueDetailView, {
    answer: { kind: "refusal", code: "HTTP 404", detail: "the hub does not offer issue detail" } satisfies IssueDetailAnswer,
  }));
  assert.ok(withheld.includes("the hub does not offer issue detail"));
  assert.ok(withheld.includes("HTTP 404"));
  assert.ok(withheld.includes("alert"));
  const unreachable = renderToStaticMarkup(createElement(BoardIssueDetailView, {
    answer: { kind: "refusal", code: "unreachable", detail: "hub unavailable" } satisfies IssueDetailAnswer,
  }));
  assert.ok(unreachable.includes("hub unavailable"));
});

test("W170: the relay payload's shape guard refuses a state-shaped answer that carries no detail — the unexpected refusal renders instead of a render-time throw (RED-first)", () => {
  const malformed = { state: "ok" };
  assert.equal(isIssueDetailOutcome(malformed), false);
  const refused = renderToStaticMarkup(createElement(BoardIssueDetailView, {
    answer: isIssueDetailOutcome(malformed)
      ? { kind: "detail", outcome: malformed }
      : { kind: "refusal", code: "unexpected", detail: "the hub's answer was not an issue detail" } satisfies IssueDetailAnswer,
  }));
  assert.ok(refused.includes("answer was not an issue detail"), "the refusal detail renders (the apostrophe is markup-escaped)");
  assert.ok(refused.includes("unexpected"));
});

// ── 6. The hub routes: operator-token reads, records only, no credential ──

test("W167: the /board/task route serves the issue detail on the operator token class, verbatim, and never leaks the credential; /board/read-state answers the recorded record", async () => {
  const detailOutcome: IssueDetailOutcome = {
    state: "ok",
    detail: { provider: "github", key: "#12", title: "Fix the flaky test", description: "the body", comments: [{ author: "hunter", body: "kept", createdAt: "2026-09-27T10:00:00Z" }], commentsSkipped: 0 },
  };
  const readRecord = { at: new Date().toISOString(), outcome: "ok" as const };
  const bridge = await createWorkflowHubBridge(
    application(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => detailOutcome,
    () => readRecord,
  );
  try {
    const denied = await fetch(`${bridge.url}/board/task`, {
      method: "POST",
      headers: { authorization: `Bearer ${"f".repeat(64)}`, "content-type": "application/json" },
      body: JSON.stringify({ key: "#12" }),
    });
    assert.equal(denied.status, 401);
    const answered = await fetch(`${bridge.url}/board/task`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ key: "#12" }),
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as Record<string, unknown>;
    assert.deepEqual(payload, { detail: detailOutcome });
    assert.ok(!JSON.stringify(payload).includes("WORKFLOW_GITHUB_TOKEN"));
    // Malformed keys are refused — the record's own "#<number>" form parses
    // strictly, and a non-positive number never reaches the provider read.
    for (const invalid of [{}, { key: "12" }, { key: "#0" }, { key: "#-3" }, { key: "#x" }, { key: "" }, { key: 12 }]) {
      const refused = await fetch(`${bridge.url}/board/task`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify(invalid),
      });
      assert.equal(refused.status, 400, `invalid key ${JSON.stringify(invalid)} must be refused`);
    }
    const readState = await fetch(`${bridge.url}/board/read-state`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(readState.status, 200);
    assert.deepEqual((await readState.json()) as unknown, { read: readRecord });
    // The read-state route rides the same operator token class.
    const readDenied = await fetch(`${bridge.url}/board/read-state`, {
      method: "POST",
      headers: { authorization: `Bearer ${"f".repeat(64)}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(readDenied.status, 401);
  } finally {
    await bridge.close();
  }
});

test("W167: withheld capabilities answer 404 like the other optional registries — never faked", async () => {
  const bridge = await createWorkflowHubBridge(application(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
  try {
    for (const path of ["/board/task", "/board/read-state"]) {
      const absent = await fetch(`${bridge.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: path === "/board/task" ? JSON.stringify({ key: "#12" }) : "{}",
      });
      assert.equal(absent.status, 404, `${path} must be withheld when the capability is absent`);
    }
  } finally {
    await bridge.close();
  }
});

// ── 7. The web relays: /api/board carries the read record; /api/board/task ──

test("W167: the /api/board relay carries the hub-recorded read state beside the board, and /api/board/task relays the detail verbatim", async () => {
  const hubDir = mkdtempSync(join(tmpdir(), "wf-w167-hub-"));
  const ws = mkdtempSync(join(tmpdir(), "wf-w167-ws-"));
  try {
    const detailOutcome: IssueDetailOutcome = {
      state: "ok",
      detail: { provider: "github", key: "#12", title: "Fix the flaky test", description: "the body", comments: [], commentsSkipped: 0 },
    };
    const ledger = createProviderReadLedger();
    const hub = await createWorkflowHub(application(), {
      discoveryDir: hubDir,
      readBoardTasks: recordProviderReads(ledger, async () => boardOutcome),
      readIssueDetail: recordProviderReads(ledger, async () => detailOutcome),
      providerReadState: () => ledger.current(),
    });
    try {
      const webApplication = new WorkflowApplication(new TaskGraph([seedTask]), hostCapabilities({ transport: "acp", authoritativePreMutation: false }));
      const server = createWorkflowWebServer(webApplication, undefined, undefined, { hubDiscoveryDir: hubDir });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        const base = `http://127.0.0.1:${port}`;
        const boardResponse = await fetch(`${base}/api/board`);
        assert.equal(boardResponse.status, 200);
        const boardPayload = (await boardResponse.json()) as { board?: unknown; read?: unknown };
        assert.deepEqual(boardPayload.board, boardOutcome);
        // The read record rides the relay: the hub's own recorded board read.
        const read = boardPayload.read as { at?: string; outcome?: string } | null;
        assert.equal(read?.outcome, "ok");
        assert.ok(typeof read?.at === "string" && !Number.isNaN(Date.parse(read.at)));
        // The detail relay passes through the hub's records, never a token.
        const detailResponse = await fetch(`${base}/api/board/task?key=${encodeURIComponent("#12")}`);
        assert.equal(detailResponse.status, 200);
        const detailPayload = (await detailResponse.json()) as { detail?: unknown };
        assert.deepEqual(detailPayload.detail, detailOutcome);
        assert.ok(!JSON.stringify(detailPayload).includes("WORKFLOW_GITHUB_TOKEN"));
        const missingKey = await fetch(`${base}/api/board/task`);
        assert.equal(missingKey.status, 400);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await hub.close();
    }
    // No hub at all: the board answers null and the read record stays null —
    // no pill may claim a freshness the hub has no record of.
    const webApplication = new WorkflowApplication(new TaskGraph([seedTask]), hostCapabilities({ transport: "acp", authoritativePreMutation: false }));
    const orphan = createWorkflowWebServer(webApplication, undefined, undefined, { hubDiscoveryDir: ws });
    await new Promise<void>((resolve) => orphan.listen(0, "127.0.0.1", resolve));
    try {
      const port = (orphan.address() as AddressInfo).port;
      const payload = (await (await fetch(`http://127.0.0.1:${port}/api/board`)).json()) as { board?: unknown; reason?: string; read?: unknown };
      assert.equal(payload.board, null);
      assert.equal(payload.reason, "hub unavailable");
      assert.equal(payload.read, null);
      const detail = await fetch(`http://127.0.0.1:${port}/api/board/task?key=${encodeURIComponent("#12")}`);
      assert.equal(detail.status, 503);
    } finally {
      await new Promise<void>((resolve) => orphan.close(() => resolve()));
    }
  } finally {
    rmSync(hubDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
