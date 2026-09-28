
import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoardOutcome, ExternalTask } from "../src/integrations/task-provider.js";
import { createWorkflowHubBridge } from "../src/integrations/hub-http.js";
import type { WorkflowRunController } from "../src/integrations/run-controller.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import {
  BoardDelegateButton,
  BoardDelegateForm,
  BoardDelegationResultView,
  BoardView,
  delegateDefaultWorkspace,
  type BoardDelegationResult,
} from "../src/ui/webapp/board-view.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// W162 deferral (c) - the delegate form preselects the workspace binding
// of the scoped project. Settled design (round 1 recon):
//   1. delegateDefaultWorkspace(projectWorkspaces) returns the single
//      binding when the scoped project has exactly one, and "" for zero,
//      several, or an absent list - never an invented choice;
//   2. the optional projectWorkspaces prop threads BoardView -> BoardColumn
//      -> BoardCard -> BoardDelegateButton, whose workspace state
//      initializes from the helper (still user-editable; the POST body
//      shape {issue, workspace?} is unchanged - no new fields);
//   3. app.tsx passes nothing today - the default activates when the Board
//      page gains project scoping (registered deferral); this slice lands
//      the seam + pins.
// SSR-pin honesty note (probed against the unmodified view): the live
// delegate form renders only after the click-to-reveal state flips, so
// renderToStaticMarkup of BoardDelegateButton / BoardView shows the
// affordance but never the input. The prefilled value is therefore pinned
// through the extracted presentational form region (BoardDelegateForm -
// the SSR-testable form-region pattern of this suite, cf. ScheduleForm in
// webapp-surface.test.ts) whose markup BoardDelegateButton renders
// verbatim when revealed; the click-to-reveal disclosure itself is pinned
// unchanged below.

const BINDING = "/home/hunter/worktrees/alpha";

const noop = (): void => {};

const seedTask: WorkflowTask = {
  id: taskId("seed"),
  title: "seed",
  state: "READY",
  dependencies: [],
  requiredEvidence: [],
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

test("W162 deferral c: delegateDefaultWorkspace returns the single binding and never invents a choice", () => {
  assert.equal(delegateDefaultWorkspace([BINDING]), BINDING, "exactly one binding is the honest default");
  assert.equal(delegateDefaultWorkspace([]), "", "zero bindings leave the field empty");
  assert.equal(delegateDefaultWorkspace(["/wt/a", "/wt/b"]), "", "several bindings are never collapsed into a guess");
  assert.equal(delegateDefaultWorkspace(undefined), "", "an absent list (the unscoped board) leaves the field empty");
});

test("W162 deferral c: the delegate form workspace input renders the scoped binding preselected", () => {
  const prefilled = renderToStaticMarkup(createElement(BoardDelegateForm, {
    workspace: delegateDefaultWorkspace([BINDING]),
    result: undefined,
    pending: false,
    onWorkspaceChange: noop,
    onStart: noop,
  }));
  assert.ok(prefilled.includes("value=" + JSON.stringify(BINDING)), "the single binding is the prefilled value");
  assert.ok(prefilled.includes("aria-label=" + JSON.stringify("workspace")), "the prefilled field is the workspace input");
  assert.ok(prefilled.includes(">start run</button>"), "the form keeps its start affordance");
  for (const shape of [[], ["/wt/a", "/wt/b"], undefined] as (readonly string[] | undefined)[]) {
    const bare = renderToStaticMarkup(createElement(BoardDelegateForm, {
      workspace: delegateDefaultWorkspace(shape),
      result: undefined,
      pending: false,
      onWorkspaceChange: noop,
      onStart: noop,
    }));
    assert.ok(bare.includes("value=" + JSON.stringify("")), "no invented choice for " + JSON.stringify(shape) + ": the field stays empty");
    assert.ok(!bare.includes(BINDING), "no binding may leak into an unscoped-or-ambiguous form");
  }
});

test("W162 deferral c: the click-to-reveal disclosure is unchanged - the scoped board renders the affordance, the form only after reveal", () => {
  const buttonMarkup = renderToStaticMarkup(createElement(BoardDelegateButton, { task: { ...okTask }, projectWorkspaces: [BINDING] }));
  assert.ok(buttonMarkup.includes(">delegate</button>"), "the scoped card keeps the delegate affordance");
  assert.ok(!buttonMarkup.includes("board-delegate-workspace"), "the form stays behind the click-to-reveal state (the settled disclosure)");
  const board: BoardOutcome = { state: "ok", board: { provider: "github", repo: "o/r", tasks: [{ ...okTask }], skipped: 0, pullRequestsExcluded: 0 } };
  const viewMarkup = renderToStaticMarkup(createElement(BoardView, { board, projectWorkspaces: [BINDING] }));
  assert.ok(viewMarkup.includes(">delegate</button>"), "the full scoped board keeps the affordance");
  assert.ok(!viewMarkup.includes("board-delegate-workspace"), "the full board form stays behind the click too");
});

test("W162 deferral c: the delegate POST body shape is unchanged - {issue, workspace} composes the exact begin keys and a rogue field is dropped", async () => {
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
    { delegateBoardTask: async () => ({ state: "ok" as const, task: okTask }) },
  );
  try {
    const post = (body: Record<string, unknown>): Promise<Response> =>
      fetch(bridge.url + "/board/delegate", {
        method: "POST",
        headers: { authorization: "Bearer " + bridge.token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const answered = await post({ issue: 12, workspace: BINDING });
    assert.equal(answered.status, 200);
    // The rogue twin carries fields the browser must never be able to
    // widen the composition with - they are dropped hub-side and the begin
    // comes out identical (modulo the hub-generated runId).
    const twin = await post({
      issue: 12,
      workspace: BINDING,
      origin: { kind: "schedule", scheduleId: "rogue" },
      runId: "client-forge",
      requiresReview: false,
    });
    assert.equal(twin.status, 200);
    assert.equal(begins.length, 2, "both delegations compose through begin");
    const first = begins[0];
    const second = begins[1];
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(first.workspace, BINDING, "the chosen workspace rides the composition");
    assert.deepEqual(
      Object.keys(first).sort(),
      ["origin", "runId", "taskPrompt", "title", "workProductLink", "workspace"],
      "the begin keys are exactly the settled set - no client field widens it",
    );
    assert.match(first.runId, /^board:github:12:[0-9a-f]{16}$/);
    assert.notEqual(first.runId, second.runId, "the runId is hub-generated per delegation");
    assert.deepEqual({ ...first, runId: second.runId }, second, "the rogue twin composes an identical begin");
  } finally {
    await bridge.close();
  }
});

test("W162 deferral c: the W170 capability boundary and the refusal markup are unchanged on a scoped board", () => {
  const adoTask: ExternalTask = { ...okTask, provider: "azure_devops" as const };
  const scopedAdo: BoardOutcome = { state: "ok", board: { provider: "azure_devops", repo: "org/project", tasks: [adoTask], skipped: 0, pullRequestsExcluded: 0 } };
  const adoMarkup = renderToStaticMarkup(createElement(BoardView, { board: scopedAdo, projectWorkspaces: [BINDING] }));
  assert.ok(adoMarkup.includes("delegation is GitHub-only in this slice"), "the boundary note renders verbatim on the scoped board");
  assert.ok(!adoMarkup.includes(">delegate</button>"), "no delegate button is offered on the ADO card");
  const scopedGithub: BoardOutcome = { state: "ok", board: { provider: "github", repo: "o/r", tasks: [{ ...okTask }], skipped: 0, pullRequestsExcluded: 0 } };
  const githubMarkup = renderToStaticMarkup(createElement(BoardView, { board: scopedGithub, projectWorkspaces: [BINDING] }));
  assert.ok(githubMarkup.includes(">delegate</button>"), "the github card keeps the affordance");
  const refusal: BoardDelegationResult = { ok: false, code: "HTTP 404", detail: "the hub does not offer board delegation" };
  const refusalMarkup = renderToStaticMarkup(createElement(BoardDelegationResultView, { result: refusal }));
  assert.ok(refusalMarkup.includes("the hub does not offer board delegation"), "the refusal detail renders verbatim");
  assert.ok(refusalMarkup.includes("HTTP 404"), "the refusal code renders verbatim");
  assert.ok(refusalMarkup.includes("role=" + JSON.stringify("alert")) || refusalMarkup.includes("alert"), "a refusal renders as an alert");
});
