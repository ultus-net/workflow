import assert from "node:assert/strict";
import { test } from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowCodingSession, type CodingSessionDriver } from "../src/application/coding-session.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { composeDriver, driverHasAuthoritativePreMutation, parseUniversalArgs, resolveDriverName } from "../src/cli/driver-registry.js";
import { taskId } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";

const noopDriver: CodingSessionDriver = { async start() {}, async cancel() {} };

function application(): WorkflowApplication {
  return new WorkflowApplication(
    new TaskGraph([{ id: taskId("A"), title: "t", state: "READY", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
}

test("resolveDriverName defaults to cline and accepts every registered driver", () => {
  const original = process.env.WORKFLOW_DRIVER;
  delete process.env.WORKFLOW_DRIVER;
  try {
    assert.equal(resolveDriverName(undefined), "cline");
    process.env.WORKFLOW_DRIVER = "opencode";
    assert.equal(resolveDriverName(undefined), "opencode");
    assert.equal(resolveDriverName("acp"), "acp");
  } finally {
    if (original === undefined) delete process.env.WORKFLOW_DRIVER;
    else process.env.WORKFLOW_DRIVER = original;
  }
});

test("resolveDriverName fails closed on unknown names", () => {
  assert.throws(() => resolveDriverName("nope"), /unknown driver 'nope' \(valid: cline, opencode, acp\)/);
});

test("parseUniversalArgs extracts driver and opencode url", () => {
  assert.deepEqual(parseUniversalArgs(["--driver", "opencode", "--opencode-url", "http://x:1"]), {
    driver: "opencode",
    opencodeUrl: "http://x:1",
  });
  assert.deepEqual(parseUniversalArgs([]), {});
});

test("parseUniversalArgs fails closed when an option value is missing", () => {
  assert.throws(() => parseUniversalArgs(["--driver"]), /--driver requires a value/);
  assert.throws(() => parseUniversalArgs(["--opencode-url", "--driver", "cline"]), /--opencode-url requires a value/);
});

test("driver enforcement claims match the installed authorization seam", () => {
  assert.equal(driverHasAuthoritativePreMutation("cline"), true);
  assert.equal(driverHasAuthoritativePreMutation("acp"), true);
  assert.equal(driverHasAuthoritativePreMutation("opencode"), false);
});

test("composeDriver uses an injected composer without falling back", async () => {
  const app = application();
  const composed = await composeDriver("acp", app, process.cwd(), {
    opencodeUrl: "http://127.0.0.1:4096",
    composers: {
      acp: async () => ({ label: "fake-acp", session: new WorkflowCodingSession(noopDriver), dispose: async () => undefined }),
    },
  });
  assert.equal(composed.label, "fake-acp");
  assert.equal(app.snapshot().tasks[0]?.state, "IN_PROGRESS");

  const failingApp = application();
  await assert.rejects(
    () => composeDriver("acp", failingApp, process.cwd(), {
      opencodeUrl: "http://127.0.0.1:4096",
      composers: { acp: async () => { throw new Error("ACP spawn failed exactly"); } },
    }),
    (error) => error instanceof Error && error.message === "ACP spawn failed exactly",
  );
  assert.equal(failingApp.snapshot().tasks[0]?.state, "IN_PROGRESS");
});
