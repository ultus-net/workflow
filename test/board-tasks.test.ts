import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardProjection,
  boardProviderFromEnv,
  fetchBoardTasks,
  GITHUB_ISSUES_PAGE_SIZE,
  type ExternalTask,
  type GitHubIssuePayload,
} from "../src/integrations/task-provider.js";
import { createWorkflowHubBridge } from "../src/integrations/hub-http.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";

// W161 — the external-task board projection (Paperclip borrow, iteration 1).
// The operator wants a project board fed by the connected repo's issue
// tracker; this iteration is the READ-ONLY projection only (delegation from
// a card is a later iteration with its own prediction). Pins per the
// registered prediction:
//   1. the provider classification is fail-closed: absent or malformed env
//      yields an "unconfigured" state that NAMES the missing/invalid
//      variable — never a fabricated empty board;
//   2. the GitHub payload shape guard maps well-formed issues, EXCLUDES
//      pull requests (counted), and COUNTS malformed rows as skipped — the
//      board renders records, never guesses;
//   3. the projection derives columns ONLY from the provider-owned state
//      field and never mutates its inputs;
//   4. the hub route answers the operator-token class (401 otherwise), the
//      payload carries the provider outcome verbatim, and the provider's
//      credential never crosses the wire.
// Route relays and the webapp view ride the projection types; the /api/board
// proxy relay is e2e-tier like the other hub relays (recorded residual).

const ENV_KEYS = ["WORKFLOW_GITHUB_REPO", "WORKFLOW_GITHUB_TOKEN"] as const;

function withEnv(values: Record<(typeof ENV_KEYS)[number], string | undefined>, body: () => void | Promise<void>): Promise<void> | void {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = (): void => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = body();
    if (result instanceof Promise) return result.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

const issue = (number: number, overrides: Partial<GitHubIssuePayload> = {}): GitHubIssuePayload => ({
  url: `https://api.github.com/repos/ultus-net/workflow/issues/${number}`,
  number,
  title: `Issue ${number}`,
  state: "open",
  labels: [],
  assignee: null,
  updated_at: "2026-09-26T00:00:00Z",
  html_url: `https://github.com/ultus-net/workflow/issues/${number}`,
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

test("W161: the provider classification fails closed — absent or malformed env names the variable, never a fabricated board", () => {
  withEnv({ WORKFLOW_GITHUB_REPO: undefined, WORKFLOW_GITHUB_TOKEN: undefined }, () => {
    const unconfigured = boardProviderFromEnv(process.env);
    assert.equal(unconfigured.kind, "unconfigured");
    assert.deepEqual(unconfigured.kind === "unconfigured" ? unconfigured.missing : [], [
      "WORKFLOW_GITHUB_REPO",
      "WORKFLOW_GITHUB_TOKEN",
    ]);
  });
  withEnv({ WORKFLOW_GITHUB_REPO: "ultus-net/workflow", WORKFLOW_GITHUB_TOKEN: undefined }, () => {
    const half = boardProviderFromEnv(process.env);
    assert.equal(half.kind, "unconfigured");
    assert.deepEqual(half.kind === "unconfigured" ? half.missing : [], ["WORKFLOW_GITHUB_TOKEN"]);
  });
  // A malformed repo declaration is not silently coerced: it names the
  // variable as invalid instead of inventing an owner/repo split.
  withEnv({ WORKFLOW_GITHUB_REPO: "just-a-name", WORKFLOW_GITHUB_TOKEN: "t" }, () => {
    const malformed = boardProviderFromEnv(process.env);
    assert.equal(malformed.kind, "unconfigured");
    assert.match(malformed.kind === "unconfigured" ? malformed.missing.join(";") : "", /WORKFLOW_GITHUB_REPO.*invalid/);
  });
  withEnv({ WORKFLOW_GITHUB_REPO: "ultus-net/workflow", WORKFLOW_GITHUB_TOKEN: "t" }, () => {
    const configured = boardProviderFromEnv(process.env);
    assert.deepEqual(configured.kind === "github" ? { owner: configured.owner, repoName: configured.repoName } : {}, {
      owner: "ultus-net",
      repoName: "workflow",
    });
  });
});

test("W161: the shape guard maps well-formed issues, excludes pull requests (counted), and counts malformed rows as skipped", async () => {
  const payload = JSON.stringify([
    issue(1, { labels: [{ name: "bug" }, { name: "ui" }], assignee: { login: "hunter" } }),
    issue(2, { state: "closed" }),
    // A pull request rides the issues endpoint with a pull_request key —
    // it is not a task; excluded and counted, never rendered.
    issue(3, { pull_request: { url: "https://api.github.com/repos/ultus-net/workflow/pulls/3" } }),
    // A malformed row is skipped and counted — the board never renders a
    // guessed record.
    { number: 9 },
    issue(4, { assignee: null, labels: [] }),
  ]);
  const { impl, calls } = stubFetch(200, payload);
  const provider = boardProviderFromEnv({
    WORKFLOW_GITHUB_REPO: "ultus-net/workflow",
    // Distinctive on purpose: the no-leak assertion below searches for this
    // exact value in the mapped outcome, not just the variable name.
    WORKFLOW_GITHUB_TOKEN: "tok-sup3r-secret-value-9f2c",
  });
  assert.equal(provider.kind, "github");
  const outcome = await fetchBoardTasks(provider, impl);
  assert.equal(outcome.state, "ok");
  if (outcome.state !== "ok") return;
  // The credential never rides the mapped outcome — searched by VALUE
  // (review round P3: the name alone proves little).
  assert.ok(!JSON.stringify(outcome).includes("tok-sup3r-secret-value-9f2c"));
  assert.equal(outcome.board.pullRequestsExcluded, 1);
  assert.equal(outcome.board.skipped, 1);
  assert.equal(outcome.board.tasks.length, 3);
  assert.deepEqual(outcome.board.tasks.map((task) => task.key), ["#1", "#2", "#4"]);
  assert.deepEqual(outcome.board.tasks[0]?.labels, ["bug", "ui"]);
  assert.equal(outcome.board.tasks[0]?.assignee, "hunter");
  assert.equal(outcome.board.tasks[1]?.state, "closed");
  assert.equal(outcome.board.tasks[1]?.assignee, undefined);
  assert.equal(outcome.board.repo, "ultus-net/workflow");
  // The wire request is bounded and explicitly addressed.
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://api.github.com/repos/ultus-net/workflow/issues?state=all&sort=updated&direction=desc&per_page=100",
  );
  assert.equal(calls[0]?.headers.authorization, "Bearer tok-sup3r-secret-value-9f2c");
  assert.equal(calls[0]?.headers.accept, "application/vnd.github+json");
  assert.ok((calls[0]?.headers["user-agent"] ?? "").length > 0);
});

test("W161: a full first page is flagged truncated — the board states its bound instead of implying completeness", async () => {
  const page = Array.from({ length: GITHUB_ISSUES_PAGE_SIZE }, (_, index) => issue(index + 1));
  const { impl } = stubFetch(200, JSON.stringify(page));
  const provider = boardProviderFromEnv({ WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "t" });
  assert.equal(provider.kind, "github");
  const outcome = await fetchBoardTasks(provider, impl);
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(outcome.board.truncated, true);
  assert.equal(outcome.board.tasks.length, GITHUB_ISSUES_PAGE_SIZE);
});

test("W161: provider faults stay honest errors — a rejected credential and a network failure never become an empty board", async () => {
  const provider = boardProviderFromEnv({ WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "t" });
  assert.equal(provider.kind, "github");
  const rejected = await fetchBoardTasks(provider, stubFetch(401, JSON.stringify({ message: "Bad credentials" })).impl);
  assert.equal(rejected.state, "error");
  assert.match(rejected.state === "error" ? rejected.reason : "", /401/);
  const failing = (async (): Promise<Response> => {
    throw new Error("connection refused");
  }) as typeof fetch;
  const unreachable = await fetchBoardTasks(provider, failing);
  assert.equal(unreachable.state, "error");
  assert.match(unreachable.state === "error" ? unreachable.reason : "", /connection refused/);
});

test("W161: the projection derives columns ONLY from the provider state field and never mutates its inputs", () => {
  const open: ExternalTask = {
    provider: "github", key: "#1", title: "one", state: "open",
    url: "https://github.com/o/r/issues/1", labels: [], updatedAt: "2026-09-26T00:00:00Z",
  };
  const closed: ExternalTask = {
    provider: "github", key: "#2", title: "two", state: "closed",
    url: "https://github.com/o/r/issues/2", labels: ["done"], assignee: "hunter", updatedAt: "2026-09-26T01:00:00Z",
  };
  const tasks = [open, closed];
  const frozen: readonly ExternalTask[] = Object.freeze([...tasks]);
  const columns = boardProjection({ provider: "github", repo: "o/r", tasks: frozen, skipped: 0, pullRequestsExcluded: 0 });
  assert.deepEqual(columns.open.map((task) => task.key), ["#1"]);
  assert.deepEqual(columns.closed.map((task) => task.key), ["#2"]);
  assert.deepEqual([...frozen], tasks);
  assert.deepEqual(columns.open, [open]);
});

// Review-round pins (Kimi K3 secondary review, 2026-09-27): each review
// finding gets its own falsifiable pin — the wrong-typed labels row is
// SKIPPED (never a mid-mapping throw that would misreport the fault as hub
// unavailability), the truncation flag keys on the RECEIVED page count (a
// full page of PRs and malformed rows still says "more may exist"), and an
// href-bound URL is https-only (a compromised provider can never hand the
// dashboard a javascript: link).

test("W161 (review): a wrong-typed labels field degrades its row to skipped — never a throw, never a misrendered hub fault", async () => {
  const payload = JSON.stringify([
    issue(1, { labels: "bug" } as unknown as Partial<GitHubIssuePayload>), // wrong-typed FIELD: the row is malformed
    issue(2, { labels: [{ name: "bug" }, "legacy-string-label", {}, { name: "" }] }), // element-wise honesty
    issue(3),
    // An ABSENT labels field is the contract's honest absent case — the row
    // maps with no labels (review P3: absent/wrong-typed are different).
    issue(4, { labels: undefined } as unknown as Partial<GitHubIssuePayload>),
  ]);
  const { impl } = stubFetch(200, payload);
  const provider = boardProviderFromEnv({ WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "t" });
  assert.equal(provider.kind, "github");
  const outcome = await fetchBoardTasks(provider, impl);
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(outcome.board.skipped, 1);
  assert.equal(outcome.board.tasks.length, 3);
  assert.deepEqual(outcome.board.tasks[0]?.labels, ["bug", "legacy-string-label"]);
  assert.deepEqual(outcome.board.tasks[1]?.labels, []);
  assert.deepEqual(outcome.board.tasks[2]?.labels, []);
});

test("W161 (review): the truncation flag keys on the received page count, not the filtered render count", async () => {
  // A FULL page whose payload is mostly exclusions must still say "more may
  // exist" — keying on tasks.length would hide a full page behind 3 PRs and
  // 1 malformed row and falsify the completeness contract.
  const page = [
    issue(1, { pull_request: { url: "https://api.github.com/repos/o/r/pulls/1" } }),
    issue(2, { pull_request: { url: "https://api.github.com/repos/o/r/pulls/2" } }),
    issue(3, { pull_request: { url: "https://api.github.com/repos/o/r/pulls/3" } }),
    { number: 4 },
    ...Array.from({ length: GITHUB_ISSUES_PAGE_SIZE - 4 }, (_, index) => issue(index + 5)),
  ];
  assert.equal(page.length, GITHUB_ISSUES_PAGE_SIZE);
  const { impl } = stubFetch(200, JSON.stringify(page));
  const provider = boardProviderFromEnv({ WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "t" });
  assert.equal(provider.kind, "github");
  const outcome = await fetchBoardTasks(provider, impl);
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(outcome.board.truncated, true);
  assert.equal(outcome.board.pullRequestsExcluded, 3);
  assert.equal(outcome.board.skipped, 1);
  assert.equal(outcome.board.tasks.length, GITHUB_ISSUES_PAGE_SIZE - 4);
});

test("W161 (review): the href-bound url is https-only — javascript:, data:, and http: rows are malformed", async () => {
  const payload = JSON.stringify([
    issue(1, { html_url: "javascript:alert(1)" }),
    issue(2, { html_url: "data:text/html,<script>alert(1)</script>" }),
    issue(3, { html_url: "http://github.com/o/r/issues/3" }),
    issue(4, { html_url: "https://github.com/o/r/issues/4" }),
  ]);
  const { impl } = stubFetch(200, payload);
  const provider = boardProviderFromEnv({ WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "t" });
  assert.equal(provider.kind, "github");
  const outcome = await fetchBoardTasks(provider, impl);
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(outcome.board.skipped, 3);
  assert.deepEqual(outcome.board.tasks.map((task) => task.key), ["#4"]);
});

test("W161: the hub route serves the board on the operator token class, verbatim, and never leaks the credential", async () => {
  const task: WorkflowTask = {
    id: taskId("seed"),
    title: "seed",
    state: "READY",
    dependencies: [],
    requiredEvidence: [],
  };
  const application = new WorkflowApplication(new TaskGraph([task]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const outcome = {
    state: "ok",
    board: {
      provider: "github",
      repo: "ultus-net/workflow",
      tasks: [{
        provider: "github", key: "#7", title: "a task", state: "open",
        url: "https://github.com/ultus-net/workflow/issues/7", labels: [], updatedAt: "2026-09-26T00:00:00Z",
      }],
      skipped: 0,
      pullRequestsExcluded: 0,
    },
  } as const;
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
    const denied = await fetch(`${bridge.url}/board/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${"f".repeat(64)}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(denied.status, 401);
    const answered = await fetch(`${bridge.url}/board/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as Record<string, unknown>;
    assert.deepEqual(payload, { board: outcome });
    assert.ok(!JSON.stringify(payload).includes("WORKFLOW_GITHUB_TOKEN"));
  } finally {
    await bridge.close();
  }
});
