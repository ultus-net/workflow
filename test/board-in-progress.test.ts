import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BoardOutcome,
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

// W162 slice 2 — the hub-owned in_progress column (the spec's "open issues
// with an active linked run, joined by the raw-id contract — never a
// timestamp heuristic"). Registered pins:
//   1. the registry accessor answers the ACTIVE run ids — membership in the
//      runs map, bounded to the most recent 64 in begin order (the
//      transitionLogs bound); a finished run leaves the set while its origin
//      record persists, so the join can never key on origins alone;
//   2. /board/tasks carries inProgress ONLY when the active-run authority
//      exists AND the join is nonempty — the honest subset (no authority, no
//      field, no column; the controller-less W161 payload stays bare);
//   3. an ACTIVE provider-task-origin run moves its open card to in_progress;
//      schedule-origin runs and unlinked cards never move; a finished run's
//      card returns to its provider state (its origin record persists);
//   4. precedence: while a run is active, in_progress outranks the W165/W171
//      in_review state — a still-executing run is not yet awaiting review;
//      once the run finishes, the work-product state decides.
// Focused-run discipline: node --import tsx --test
// test/board-in-progress.test.ts.

const seedTask: WorkflowTask = {
  id: taskId("seed"),
  title: "seed",
  state: "READY",
  dependencies: [],
  requiredEvidence: [],
};

const application = (): WorkflowApplication =>
  new WorkflowApplication(new TaskGraph([seedTask]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));

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
  tasks: [boardTask(12), boardTask(13), boardTask(14, "closed")],
  skipped: 0,
  pullRequestsExcluded: 0,
};

const boardOutcome: BoardOutcome = { state: "ok", board };

test("W162 slice 2: the registry accessor answers the ACTIVE run ids — membership bounded at 64; finish removes the run while its origin record persists", async () => {
  const registry = createRunRegistry(application(), new TaskGraph([seedTask]));
  await registry.controller.begin({
    runId: "board:github:12:r1",
    title: "#12 first",
    origin: { kind: "provider-task", provider: "github", key: "#12", url: "https://github.com/o/r/issues/12" },
  });
  await registry.controller.begin({
    runId: "board:github:13:r2",
    title: "#13 second",
    origin: { kind: "provider-task", provider: "github", key: "#13", url: "https://github.com/o/r/issues/13" },
  });
  assert.deepEqual(registry.controller.activeRunIds?.(), ["board:github:12:r1", "board:github:13:r2"]);
  // The finished run leaves ACTIVE membership — but its origin record
  // persists, so an origins-keyed join would hold the card in_progress
  // forever. The accessor keys on the runs map, never the origin records.
  await registry.controller.finish({ runId: "board:github:12:r1", outcome: "failed" });
  assert.deepEqual(registry.controller.activeRunIds?.(), ["board:github:13:r2"]);
  assert.ok(registry.runOrigins().has("board:github:12:r1"), "the origin record persists after finish — the join must key on ACTIVE membership");
  // Bounded to the most recent 64 in begin order (the transitionLogs bound):
  // 71 live runs answer only the last 64.
  for (let index = 3; index <= 72; index += 1) {
    await registry.controller.begin({ runId: `board:github:14:r${index}`, title: `filler ${index}` });
  }
  const bounded = registry.controller.activeRunIds?.() ?? [];
  assert.equal(bounded.length, 64);
  assert.equal(bounded.includes("board:github:12:r1"), false, "the oldest ids leave the bounded view first");
  assert.equal(bounded.includes("board:github:13:r2"), false);
  assert.equal(bounded[0], "board:github:14:r9", "the view keeps the last 64 of the 71 live runs");
  assert.equal(bounded[bounded.length - 1], "board:github:14:r72", "begin order preserved");
});

test("W162 slice 2: /board/tasks joins OPEN cards to ACTIVE provider-task origins — schedule-origin runs and unlinked cards never move", async () => {
  const spy: WorkflowRunController = {
    async begin() {},
    async finish() {},
    async review() {
      return { recorded: false };
    },
    hiddenSnapshotTaskIds() {
      return [];
    },
    activeRunIds() {
      return ["board:github:12:r1", "schedule:r9:u"];
    },
    gateObservability() {
      return {
        reviewOutcomes: new Map(),
        blockingReasons: new Map(),
        completionClaims: new Map(),
        runOrigins: new Map([
          ["board:github:12:r1", { kind: "provider-task" as const, provider: "github" as const, key: "#12", url: "https://github.com/o/r/issues/12" }],
          ["schedule:r9:u", { kind: "schedule" as const, scheduleId: "s9" }],
        ]),
      };
    },
  };
  const bridge = await createWorkflowHubBridge(
    application(), undefined, spy, undefined, undefined, undefined, undefined, undefined,
    { readBoardTasks: async () => boardOutcome },
  );
  try {
    const answered = await fetch(`${bridge.url}/board/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as { board?: unknown; inProgress?: readonly string[] };
    // Only the ACTIVE provider-task origin names an open card: #12. The
    // schedule-origin run and the never-delegated #13 stay provider-owned;
    // the closed #14 never moves.
    assert.deepEqual(payload.inProgress, ["#12"]);
  } finally {
    await bridge.close();
  }
});

test("W162 slice 2: the honest subset — absent authority or no active runs carries NO inProgress field; the controller-less W161 payload stays bare", async () => {
  // A controller without the accessor (a hub predating the slice): the
  // payload is exactly { board } — the W161 pin's shape, unchanged.
  const bare: WorkflowRunController = {
    async begin() {},
    async finish() {},
    async review() {
      return { recorded: false };
    },
    hiddenSnapshotTaskIds() {
      return [];
    },
  };
  const bareBridge = await createWorkflowHubBridge(
    application(), undefined, bare, undefined, undefined, undefined, undefined, undefined,
    { readBoardTasks: async () => boardOutcome },
  );
  try {
    const answered = await fetch(`${bareBridge.url}/board/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${bareBridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as Record<string, unknown>;
    assert.deepEqual(payload, { board: boardOutcome });
  } finally {
    await bareBridge.close();
  }

  // The authority exists but no run is active: the field stays absent — the
  // column never appears from an empty join (no fabricated state).
  const idle: WorkflowRunController = {
    ...bare,
    activeRunIds() {
      return [];
    },
    gateObservability() {
      return {
        reviewOutcomes: new Map(),
        blockingReasons: new Map(),
        completionClaims: new Map(),
        runOrigins: new Map([
          ["board:github:12:r1", { kind: "provider-task" as const, provider: "github" as const, key: "#12", url: "https://github.com/o/r/issues/12" }],
        ]),
      };
    },
  };
  const idleBridge = await createWorkflowHubBridge(
    application(), undefined, idle, undefined, undefined, undefined, undefined, undefined,
    { readBoardTasks: async () => boardOutcome },
  );
  try {
    const answered = await fetch(`${idleBridge.url}/board/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${idleBridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as { inProgress?: unknown };
    assert.equal(payload.inProgress, undefined, "no active runs, no field — the column never appears from an empty join");
  } finally {
    await idleBridge.close();
  }

  // The accessor exists but gateObservability does not: no origins to match
  // — the field stays absent (fail-closed, never guessed).
  const silent: WorkflowRunController = {
    ...bare,
    activeRunIds() {
      return ["board:github:12:r1"];
    },
  };
  const silentBridge = await createWorkflowHubBridge(
    application(), undefined, silent, undefined, undefined, undefined, undefined, undefined,
    { readBoardTasks: async () => boardOutcome },
  );
  try {
    const answered = await fetch(`${silentBridge.url}/board/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${silentBridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(answered.status, 200);
    const payload = (await answered.json()) as { inProgress?: unknown };
    assert.equal(payload.inProgress, undefined, "no origins authority, no field");
  } finally {
    await silentBridge.close();
  }
});

test("W162 slice 2: the delegate lifecycle through the REAL registry — the begun run moves its card, the finished run returns it (its origin record persists)", async () => {
  const registry = createRunRegistry(application(), new TaskGraph([seedTask]));
  const bridge = await createWorkflowHubBridge(
    application(), undefined, registry.controller, undefined, undefined, undefined, undefined, undefined,
    { readBoardTasks: async () => boardOutcome },
  );
  try {
    const read = async (): Promise<readonly string[] | undefined> => {
      const answered = await fetch(`${bridge.url}/board/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(answered.status, 200);
      return ((await answered.json()) as { inProgress?: readonly string[] }).inProgress;
    };
    // No delegation yet: no field, no column authority.
    assert.equal(await read(), undefined);
    await registry.controller.begin({
      runId: "board:github:12:r1",
      title: "#12 Fix the flaky test",
      origin: { kind: "provider-task", provider: "github", key: "#12", url: "https://github.com/o/r/issues/12" },
    });
    assert.deepEqual(await read(), ["#12"]);
    await registry.controller.finish({ runId: "board:github:12:r1", outcome: "failed" });
    // The origin record persists; ACTIVE membership does not — the join keys
    // on the accessor, never on origins alone (the card returns to its
    // provider-owned open state).
    assert.ok(registry.runOrigins().has("board:github:12:r1"));
    assert.equal(await read(), undefined);
  } finally {
    await bridge.close();
  }
});

test("W162 slice 2: precedence — an active run outranks in_review (both facts ride the payload; placement decides); a finished run's PR state decides", async () => {
  const spy: WorkflowRunController = {
    async begin() {},
    async finish() {},
    async review() {
      return { recorded: false };
    },
    hiddenSnapshotTaskIds() {
      return [];
    },
    activeRunIds() {
      return ["board:github:12:r1"];
    },
    gateObservability() {
      return {
        reviewOutcomes: new Map(),
        blockingReasons: new Map(),
        completionClaims: new Map(),
        runOrigins: new Map([
          ["board:github:12:r1", { kind: "provider-task" as const, provider: "github" as const, key: "#12", url: "https://github.com/o/r/issues/12" }],
        ]),
        workProductLinks: new Map([
          ["board:github:12:r1", { provider: "github" as const, key: "#12", url: "https://github.com/o/r/issues/12" }],
        ]),
      };
    },
  };
  const reads = new Map<string, WorkProductStateOutcome>([
    ["#12", { state: "ok", product: { provider: "github", key: "#34", url: "https://github.com/o/r/pull/34", state: "open", draft: true, asOf: "2026-09-28T01:00:00Z" } }],
  ]);
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
    const payload = (await answered.json()) as { inProgress?: readonly string[]; workProducts?: Record<string, WorkProductCardState> };
    // BOTH registry facts ride: the card is actively executing AND its work
    // product reads open — the payload stays honest; the column placement
    // applies the precedence.
    assert.deepEqual(payload.inProgress, ["#12"]);
    assert.equal(payload.workProducts?.["#12"]?.state, "linked");

    // The active run's card renders in in_progress — NOT in_review, even
    // though its work product reads open (a still-executing run is not yet
    // awaiting review) — and exactly once.
    const activeMarkup = renderToStaticMarkup(
      createElement(BoardView, { board: boardOutcome, workProducts: payload.workProducts, inProgress: payload.inProgress }),
    );
    const openChunk = activeMarkup.slice(activeMarkup.indexOf("open ("), activeMarkup.indexOf("in_progress ("));
    const inProgressChunk = activeMarkup.slice(activeMarkup.indexOf("in_progress ("), activeMarkup.indexOf("in_review ("));
    const inReviewChunk = activeMarkup.slice(activeMarkup.indexOf("in_review ("), activeMarkup.indexOf("closed ("));
    assert.ok(inProgressChunk.includes("Issue 12"), "the active run's card lands in in_progress");
    assert.ok(!openChunk.includes("Issue 12"), "it left the open column");
    assert.ok(!inReviewChunk.includes("Issue 12"), "in_progress outranks the linked+open work product while the run is active");
    assert.equal((activeMarkup.match(/Issue 12/g) ?? []).length, 1, "the card renders exactly once");

    // Once the run finishes the payload drops the key — the W165 model
    // decides: the linked+open work product puts the card in in_review, and
    // no in_progress column appears at all.
    const finishedMarkup = renderToStaticMarkup(
      createElement(BoardView, { board: boardOutcome, workProducts: payload.workProducts }),
    );
    assert.ok(!finishedMarkup.includes("in_progress"), "no inProgress payload, no column — the UI computes nothing");
    const finishedInReviewChunk = finishedMarkup.slice(finishedMarkup.indexOf("in_review ("), finishedMarkup.indexOf("closed ("));
    assert.ok(finishedInReviewChunk.includes("Issue 12"), "the finished run's linked+open work product decides in_review");
  } finally {
    await bridge.close();
  }
});
