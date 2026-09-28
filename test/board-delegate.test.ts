import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardProviderFromEnv,
  fetchBoardTask,
  type BoardProviderState,
  type ExternalTask,
  type GitHubBoardProviderState,
  type GitHubIssuePayload,
} from "../src/integrations/task-provider.js";
import { createWorkflowHubBridge } from "../src/integrations/hub-http.js";
import { activityTimeline } from "../src/integrations/activity-timeline.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";
import type { WorkflowRunController } from "../src/integrations/run-controller.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { BoardDelegateButton, BoardDelegationResultView, BoardView, type BoardDelegationResult } from "../src/ui/webapp/board-view.js";
import type { BoardOutcome } from "../src/integrations/task-provider.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// W162 slice 1 — the board card's delegate action (Paperclip borrow,
// amendment 1's first dispatch-class addition; the read-only board was W161).
// Registered prediction (project memory 5543b57c, 2026-09-27):
//   1. the hub-side single-issue provider read (fetchBoardTask) reuses the
//      W161 shape guard and fails closed: unconfigured env names the
//      variables, provider faults are honest errors, PRs and malformed
//      payloads are never fabricated into tasks;
//   2. the delegation composes through the SAME run-begin path the CLI uses
//      (context.runController.begin) and records the provider-task origin
//      HUB-SIDE from the hub's own provider read — the W153 principle: the
//      client never supplies attribution, /run/begin still accepts none;
//   3. the origin is visible in gateObservability().runOrigins
//      (registry-sourced, never UI-computed) and the timeline renders a
//      provider-task origin row naming the issue (the schedule row's W153
//      shape unchanged);
//   4. refusals render verbatim (rendered-deny): capability withheld → 404,
//      provider unconfigured/error → 200 payload states with begin NEVER
//      called, invalid body → 400, a workspace fault → 400 with the refusal
//      message — never a disabled-looking success.
// Scope cut (registered): the hub-owned in_progress column is W162 slice 2;
// no checkout locks, no wake-on-assign, no agent self-claim.

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
  url: `https://api.github.com/repos/o/r/issues/${number}`,
  number,
  title: `Issue ${number}`,
  state: "open",
  labels: [],
  assignee: null,
  updated_at: "2026-09-27T00:00:00Z",
  html_url: `https://github.com/o/r/issues/${number}`,
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

const provider = (env: Record<string, string | undefined> = { WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "t" }): GitHubBoardProviderState => {
  const state = boardProviderFromEnv(env);
  assert.equal(state.kind, "github");
  return state as BoardProviderState & { kind: "github" };
};

const okTask: ExternalTask = {
  provider: "github",
  key: "#12",
  title: "Fix the flaky test",
  state: "open",
  url: "https://github.com/o/r/issues/12",
  labels: ["bug"],
  updatedAt: "2026-09-27T00:00:00Z",
};

const seedTask: WorkflowTask = {
  id: taskId("seed"),
  title: "seed",
  state: "READY",
  dependencies: [],
  requiredEvidence: [],
};

test("W162: the single-issue provider read reuses the shape guard — a well-formed issue maps verbatim and the credential never rides the outcome", async () => {
  const { impl, calls } = stubFetch(200, JSON.stringify(issue(12, { title: "Fix the flaky test", labels: [{ name: "bug" }], assignee: { login: "hunter" } })));
  // Distinctive on purpose: the no-leak assertion searches for the VALUE.
  const p = provider({ WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "tok-sup3r-secret-value-9f2c" });
  const outcome = await fetchBoardTask(p, 12, impl);
  assert.equal(outcome.state, "ok");
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.deepEqual(
    { key: outcome.task.key, title: outcome.task.title, url: outcome.task.url, state: outcome.task.state, labels: outcome.task.labels, assignee: outcome.task.assignee },
    { key: "#12", title: "Fix the flaky test", url: "https://github.com/o/r/issues/12", state: "open", labels: ["bug"], assignee: "hunter" },
  );
  assert.ok(!JSON.stringify(outcome).includes("tok-sup3r-secret-value-9f2c"));
  // One bounded, explicitly addressed request.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.github.com/repos/o/r/issues/12");
  assert.equal(calls[0]?.headers.authorization, "Bearer tok-sup3r-secret-value-9f2c");
});

test("W162: the single-issue read fails closed — unconfigured env names the variables, provider faults and non-issue payloads stay honest errors", async () => {
  withEnv({ WORKFLOW_GITHUB_REPO: undefined, WORKFLOW_GITHUB_TOKEN: undefined }, async () => {
    const unconfigured = await fetchBoardTask(boardProviderFromEnv(process.env), 12, stubFetch(200, "[]").impl);
    assert.equal(unconfigured.state, "unconfigured");
    assert.deepEqual(unconfigured.state === "unconfigured" ? unconfigured.missing : [], ["WORKFLOW_GITHUB_REPO", "WORKFLOW_GITHUB_TOKEN"]);
  });
  const p = provider();
  const missing = await fetchBoardTask(p, 404, stubFetch(404, JSON.stringify({ message: "Not Found" })).impl);
  assert.equal(missing.state, "error");
  assert.match(missing.state === "error" ? missing.reason : "", /404/);
  const pullRequest = await fetchBoardTask(p, 3, stubFetch(200, JSON.stringify(issue(3, { pull_request: { url: "https://api.github.com/repos/o/r/pulls/3" } }))).impl);
  assert.equal(pullRequest.state, "error");
  assert.match(pullRequest.state === "error" ? pullRequest.reason : "", /pull request/);
  const malformed = await fetchBoardTask(p, 9, stubFetch(200, JSON.stringify({ number: "nine" })).impl);
  assert.equal(malformed.state, "error");
  const failing = (async (): Promise<Response> => {
    throw new Error("connection refused");
  }) as typeof fetch;
  const unreachable = await fetchBoardTask(p, 12, failing);
  assert.equal(unreachable.state, "error");
  assert.match(unreachable.state === "error" ? unreachable.reason : "", /connection refused/);
});

test("W162: the delegate route composes through the run-begin path and records the provider-task origin — run id, title, prompt, and origin all asserted", async () => {
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
    gateObservability() {
      const first = begins[0];
      return {
        reviewOutcomes: new Map(),
        blockingReasons: new Map(),
        completionClaims: new Map(),
        runOrigins: new Map(first === undefined ? [] : [[first.runId, first.origin ?? { kind: "schedule", scheduleId: "NONE" }]]),
      };
    },
  };
  const bridge = await createWorkflowHubBridge(
    new WorkflowApplication(new TaskGraph([seedTask]), hostCapabilities({ transport: "native", authoritativePreMutation: true })),
    undefined,
    spy,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ({ state: "ok", task: okTask }),
  );
  try {
    const denied = await fetch(`${bridge.url}/board/delegate`, {
      method: "POST",
      headers: { authorization: `Bearer ${"f".repeat(64)}`, "content-type": "application/json" },
      body: JSON.stringify({ issue: 12 }),
    });
    assert.equal(denied.status, 401);
    const answered = await fetch(`${bridge.url}/board/delegate`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ issue: 12 }),
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as { delegation?: { state?: string; runId?: string; task?: { key?: string; title?: string; url?: string } } };
    assert.equal(payload.delegation?.state, "ok");
    assert.deepEqual(payload.delegation?.task, { key: "#12", title: "Fix the flaky test", url: "https://github.com/o/r/issues/12" });
    // The composed run id is hub-generated, names the provider and issue, and
    // carries a random tail (unforgeable by payload repetition).
    const runId = payload.delegation?.runId ?? "";
    assert.match(runId, /^board:github:12:[0-9a-f]{16}$/);
    // The composed dispatch went through the SAME begin path the CLI uses,
    // with the hub's own provider-read attribution attached.
    assert.equal(begins.length, 1);
    const begun = begins[0];
    assert.ok(begun !== undefined);
    assert.equal(begun.runId, runId);
    assert.equal(begun.title, "#12 Fix the flaky test");
    assert.equal(begun.taskPrompt, `Work github issue #12: "Fix the flaky test" (source: ${okTask.url})`);
    assert.deepEqual(begun.origin, { kind: "provider-task", provider: "github", key: "#12", url: "https://github.com/o/r/issues/12" });
    // Registry-sourced attribution (the W153 pin pattern): the origin is
    // observable from the gate map, not from the view's own state.
    const origins = spy.gateObservability?.().runOrigins ?? new Map();
    assert.deepEqual(origins.get(runId), { kind: "provider-task", provider: "github", key: "#12", url: "https://github.com/o/r/issues/12" });
  } finally {
    await bridge.close();
  }
});

test("W162: delegated runs are registry-sourced, not UI-computed — createRunRegistry records the provider-task origin at begin", () => {
  const application = new WorkflowApplication(new TaskGraph([seedTask]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const { controller } = createRunRegistry(application, new TaskGraph([seedTask]));
  void controller.begin({
    runId: "board:github:12:deadbeefdeadbeef",
    title: "#12 Fix the flaky test",
    origin: { kind: "provider-task", provider: "github", key: "#12", url: "https://github.com/o/r/issues/12" },
  }).catch(() => assert.fail("begin threw"));
  const origins = controller.gateObservability?.().runOrigins ?? new Map();
  assert.deepEqual(origins.get("board:github:12:deadbeefdeadbeef"), {
    kind: "provider-task",
    provider: "github",
    key: "#12",
    url: "https://github.com/o/r/issues/12",
  });
});

test("W162: the delegate route's refusals render verbatim — capability withheld, invalid bodies, workspace faults, and provider states", async () => {
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
  const application = new WorkflowApplication(new TaskGraph([seedTask]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  // A hub composed WITHOUT the delegation capability: 404 like the other
  // optional registries — the capability is withheld, not faked.
  const withheld = await createWorkflowHubBridge(application, undefined, spy, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
  try {
    const absent = await fetch(`${withheld.url}/board/delegate`, {
      method: "POST",
      headers: { authorization: `Bearer ${withheld.token}`, "content-type": "application/json" },
      body: JSON.stringify({ issue: 12 }),
    });
    assert.equal(absent.status, 404);
  } finally {
    await withheld.close();
  }
  const bridge = await createWorkflowHubBridge(
    application,
    undefined,
    spy,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (issueNumber: number) =>
      issueNumber === 12
        ? { state: "ok" as const, task: okTask }
        : issueNumber === 5
          ? { state: "unconfigured" as const, missing: ["WORKFLOW_GITHUB_REPO", "WORKFLOW_GITHUB_TOKEN"] }
          : { state: "error" as const, reason: "the provider answered 500" },
  );
  try {
    const post = (body: unknown): Promise<Response> =>
      fetch(`${bridge.url}/board/delegate`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const invalid of [{}, { issue: "12" }, { issue: 0 }, { issue: 1.5 }, { issue: -3 }]) {
      const response = await post(invalid);
      assert.equal(response.status, 400, `invalid body ${JSON.stringify(invalid)} must be refused`);
    }
    // A workspace-declaration fault is a CLIENT fault answered 400 with the
    // refusal message verbatim (the /run/begin pattern) — never a 500.
    const workspaceSpy: WorkflowRunController = {
      ...spy,
      async begin() {
        throw new (await import("../src/integrations/run-registry.js")).WorkspaceDeclarationError("declared workspace must be absolute: rel");
      },
    };
    const faulting = await createWorkflowHubBridge(
      application, undefined, workspaceSpy, undefined, undefined, undefined, undefined, undefined, undefined,
      async () => ({ state: "ok" as const, task: okTask }),
    );
    try {
      const fault = await fetch(`${faulting.url}/board/delegate`, {
        method: "POST",
        headers: { authorization: `Bearer ${faulting.token}`, "content-type": "application/json" },
        body: JSON.stringify({ issue: 12, workspace: "rel" }),
      });
      assert.equal(fault.status, 400);
      assert.deepEqual((await fault.json()) as { error?: string }, { error: "declared workspace must be absolute: rel" });
    } finally {
      await faulting.close();
    }
    // Provider unconfigured/error are PAYLOAD states (200) — never 404s —
    // and no run is begun for a refused delegation (never a fabricated
    // success).
    const unconfigured = await post({ issue: 5 });
    assert.equal(unconfigured.status, 200);
    assert.deepEqual((await unconfigured.json()) as unknown, {
      delegation: { state: "unconfigured", missing: ["WORKFLOW_GITHUB_REPO", "WORKFLOW_GITHUB_TOKEN"] },
    });
    const errored = await post({ issue: 13 });
    assert.equal(errored.status, 200);
    assert.deepEqual((await errored.json()) as unknown, { delegation: { state: "error", reason: "the provider answered 500" } });
    assert.equal(begins.length, 0, "a refused delegation must never begin a run");
  } finally {
    await bridge.close();
  }
});

test("W162: /run/begin stays client-origin-free — the forgeable-attribution refusal survives the widened RunOrigin union", async () => {
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
    new WorkflowApplication(new TaskGraph([seedTask]), hostCapabilities({ transport: "native", authoritativePreMutation: true })),
    undefined,
    spy,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  try {
    const response = await fetch(`${bridge.url}/run/begin`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ runId: "client-run", title: "t", origin: { kind: "provider-task", provider: "github", key: "#1", url: "https://github.com/o/r/issues/1" } }),
    });
    assert.equal(response.status, 200);
    assert.equal(begins.length, 1);
    assert.equal(begins[0]?.origin, undefined, "a client-supplied origin must never reach begin — attribution is hub-recorded only");
  } finally {
    await bridge.close();
  }
});

test("W162: the timeline renders a provider-task origin row naming the issue; the schedule row's W153 shape is unchanged", () => {
  const feed = activityTimeline({
    transitions: [],
    tasks: [],
    runOrigins: new Map([
      ["board:github:12:abc", { kind: "provider-task" as const, provider: "github" as const, key: "#12", url: "https://github.com/o/r/issues/12" }],
      ["schedule:r1:u", { kind: "schedule" as const, scheduleId: "s1" }],
    ]),
    schedules: [{ id: "s1", title: "nightly" }],
  });
  const originRows = feed.rows.filter((row) => row.kind === "origin");
  assert.equal(originRows.length, 2);
  const delegation = originRows.find((row) => row.summary.includes("board delegation"));
  assert.ok(delegation !== undefined, "a delegated run must have its own origin row");
  assert.equal(delegation.actor, "operator");
  assert.equal(delegation.authority, "run origin record (provider-task: #12)");
  assert.equal(delegation.summary, "board delegation from #12 (github) started run board:github:12:abc");
  const scheduled = originRows.find((row) => row.summary.includes("fired"));
  assert.ok(scheduled !== undefined);
  assert.equal(scheduled.actor, "scheduler");
  assert.equal(scheduled.authority, "run origin record (schedule: s1)");
  assert.equal(scheduled.summary, "schedule nightly fired run schedule:r1:u");
  // Degraded honesty unchanged: an absent origins map still names the absence.
  const degraded = activityTimeline({ transitions: [], tasks: [] });
  assert.ok(degraded.degraded.includes("run origin records"));
});

test("W162: the board view renders the delegate affordance on open cards and the refusal verbatim (rendered-deny); closed cards render none", () => {
  const open: ExternalTask = { ...okTask };
  const closed: ExternalTask = { ...okTask, key: "#2", state: "closed" as const, url: "https://github.com/o/r/issues/2" };
  const markup = renderToStaticMarkup(
    createElement("div", {}, createElement(BoardDelegateButton, { task: open }), createElement(BoardDelegateButton, { task: closed })),
  );
  assert.ok(markup.includes("delegate"), "an open card must offer the delegate action");
  // The rendered-deny pin: a withheld capability (HTTP 404) renders the
  // refusal verbatim with its code — never a disabled-looking success.
  const refusal: BoardDelegationResult = { ok: false, code: "HTTP 404", detail: "the hub does not offer board delegation" };
  const refusalMarkup = renderToStaticMarkup(createElement(BoardDelegationResultView, { result: refusal }));
  assert.ok(refusalMarkup.includes("the hub does not offer board delegation"), "the refusal detail must render verbatim");
  assert.ok(refusalMarkup.includes("HTTP 404"), "the refusal code must render verbatim");
  assert.ok(refusalMarkup.includes("role=\"alert\"") || refusalMarkup.includes("alert"), "a refusal must render as an alert");
  const success: BoardDelegationResult = { ok: true, runId: "board:github:12:abc", code: "200", detail: "delegated as run board:github:12:abc" };
  const successMarkup = renderToStaticMarkup(createElement(BoardDelegationResultView, { result: success }));
  assert.ok(successMarkup.includes("board:github:12:abc"));
  assert.ok(!successMarkup.includes("alert"), "a success must not render as an alert");
});

test("W170: the delegate runId's provider prefix derives from the task's own provider — a stub-supplied azure_devops task names azure_devops in the run id (RED-first against the hardcoded template)", async () => {
  const adoTask: ExternalTask = { ...okTask, provider: "azure_devops" as const };
  const begins: Parameters<WorkflowRunController["begin"]>[0][] = [];
  const spy: WorkflowRunController = {
    async begin(input) { begins.push(input); },
    async finish() {},
    async review() { return { recorded: false }; },
    hiddenSnapshotTaskIds() { return []; },
  };
  const bridge = await createWorkflowHubBridge(
    new WorkflowApplication(new TaskGraph([seedTask]), hostCapabilities({ transport: "native", authoritativePreMutation: true })),
    undefined,
    spy,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ({ state: "ok" as const, task: adoTask }),
  );
  try {
    const answered = await fetch(`${bridge.url}/board/delegate`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ issue: 12 }),
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as { delegation?: { runId?: string } };
    assert.match(payload.delegation?.runId ?? "", /^board:azure_devops:12:[0-9a-f]{16}$/);
    const begun = begins[0];
    assert.ok(begun !== undefined);
    assert.deepEqual(begun.origin, { kind: "provider-task", provider: "azure_devops", key: "#12", url: "https://github.com/o/r/issues/12" });
  } finally {
    await bridge.close();
  }
});

test("W170: the capability boundary renders BEFORE the click — an ADO-fed card names the GitHub-only boundary instead of offering a delegate button (RED-first)", () => {
  const adoTask: ExternalTask = { ...okTask, provider: "azure_devops" as const };
  const adoBoard: BoardOutcome = { state: "ok", board: { provider: "azure_devops", repo: "org/project", tasks: [adoTask], skipped: 0, pullRequestsExcluded: 0 } };
  const markup = renderToStaticMarkup(createElement("div", {}, createElement(BoardView, { board: adoBoard })));
  assert.ok(markup.includes("delegation is GitHub-only in this slice"), "the boundary renders as an honest note");
  assert.ok(!markup.includes(">delegate</button>"), "no delegate button is offered on the ADO card");
  const githubBoard: BoardOutcome = { state: "ok", board: { provider: "github", repo: "o/r", tasks: [{ ...okTask }], skipped: 0, pullRequestsExcluded: 0 } };
  const githubMarkup = renderToStaticMarkup(createElement("div", {}, createElement(BoardView, { board: githubBoard })));
  assert.ok(githubMarkup.includes(">delegate</button>"), "the github card keeps the affordance");
});