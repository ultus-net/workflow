import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorkflowHubBridge } from "../src/integrations/hub-http.js";
import { AzureJobMessageError } from "../src/integrations/azure-jobs-schema.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";

// C1 deploy plan §2.c — the hub `POST /dispatch/azure-job` route. Pins per the
// registered prediction:
//   1. the route is operator-token class (401 without the token, exactly like
//      /board/delegate and /run/begin);
//   2. capability withheld (no dispatchAzureJob) → 404, fail closed;
//   3. a queued message returns { dispatch: { state: "queued", ... } };
//   4. a structural validation failure (TypeError) is a 400, never a queued job;
//   5. a transport fault propagates (a 5xx, never a fabricated success).

function applicationFixture(): WorkflowApplication {
  const task: WorkflowTask = {
    id: taskId("seed"),
    title: "seed",
    state: "READY",
    dependencies: [],
    requiredEvidence: [],
  };
  return new WorkflowApplication(
    new TaskGraph([task]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
}

test("hub /dispatch/azure-job: capability withheld → 404", async () => {
  const bridge = await createWorkflowHubBridge(applicationFixture());
  try {
    const response = await fetch(`${bridge.url}/dispatch/azure-job`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 404);
  } finally {
    await bridge.close();
  }
});

test("hub /dispatch/azure-job: operator-token class (401 without it), 200 on enqueue", async () => {
  const seen: unknown[] = [];
  const bridge = await createWorkflowHubBridge(
    applicationFixture(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      dispatchAzureJob: async (message) => {
        seen.push(message);
        return { taskId: "task-123", messageId: "mid-1", viaBlobRef: false };
      },
    },
  );
  try {
    const denied = await fetch(`${bridge.url}/dispatch/azure-job`, {
      method: "POST",
      headers: { authorization: `Bearer ${"f".repeat(64)}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(denied.status, 401);
    assert.equal(seen.length, 0, "an unauthorized request never reaches the closure");

    const body = { specVersion: 1, taskId: "task-123" };
    const answered = await fetch(`${bridge.url}/dispatch/azure-job`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(answered.status, 200);
    assert.deepEqual(await answered.json(), {
      dispatch: { state: "queued", taskId: "task-123", messageId: "mid-1", viaBlobRef: false },
    });
    assert.deepEqual(seen, [body]);
  } finally {
    await bridge.close();
  }
});

test("hub /dispatch/azure-job: a structural validation failure is a 400, never a queued job", async () => {
  let called = false;
  const bridge = await createWorkflowHubBridge(
    applicationFixture(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      dispatchAzureJob: async () => {
        called = true;
        throw new AzureJobMessageError("invalid azure job message: taskId must be a non-empty string");
      },
    },
  );
  try {
    const response = await fetch(`${bridge.url}/dispatch/azure-job`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid azure job message: taskId must be a non-empty string" });
    assert.equal(called, true);
  } finally {
    await bridge.close();
  }
});

test("hub /dispatch/azure-job: a transport TypeError is a 5xx, not a 400", async () => {
  // A Node fetch transport failure is a TypeError; the route must NOT read it
  // as a malformed message (the false-5xx defect the review caught).
  const bridge = await createWorkflowHubBridge(
    applicationFixture(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      dispatchAzureJob: async () => {
        throw new TypeError("fetch failed");
      },
    },
  );
  try {
    const response = await fetch(`${bridge.url}/dispatch/azure-job`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.ok(response.status >= 500, `expected a server fault, got ${response.status}`);
  } finally {
    await bridge.close();
  }
});

test("hub /dispatch/azure-job: a transport fault is a 5xx, never a fabricated success", async () => {
  const bridge = await createWorkflowHubBridge(
    applicationFixture(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      dispatchAzureJob: async () => {
        throw new Error("azure job dispatch: the queue answered 503");
      },
    },
  );
  try {
    const response = await fetch(`${bridge.url}/dispatch/azure-job`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.ok(response.status >= 500, `expected a server fault, got ${response.status}`);
  } finally {
    await bridge.close();
  }
});
