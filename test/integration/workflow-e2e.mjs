import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClineHostAdapter,
  LinuxBubblewrapContainment,
  TaskGraph,
  WorkflowApplication,
  WorkflowContainedProcess,
  evidenceId,
  observationId,
  taskId,
} from "../../dist/index.js";

const id = taskId("e2e-contained-change");
const graph = new TaskGraph([
  {
    id,
    title: "E2E contained change",
    state: "BLOCKED",
    dependencies: [],
    requiredEvidence: [{ authority: "environment", subject: "artifact" }],
  },
]);
const adapter = new ClineHostAdapter({
  sessionId: "e2e-session",
  taskId: id,
  isMutatingTool: () => true,
  authoritativePreMutation: true,
});
const application = new WorkflowApplication(
  graph,
  adapter.capabilities,
  [],
  new Set(["read", "mutation", "process"]),
);
const process = new WorkflowContainedProcess(application, new LinuxBubblewrapContainment());
const directory = await mkdtemp(join(tmpdir(), "workflow-e2e-"));
const artifact = join(directory, "artifact.txt");

try {
  assert.equal(application.transition(id, "IN_PROGRESS").kind, "accepted");
  const proposal = adapter.proposalFromBeforeTool({
    tool: { name: "execute_command" },
    input: {
      executable: "/bin/sh",
      args: ["-c", 'printf workflow-e2e > "$1"', "workflow", artifact],
    },
  });
  assert.equal(proposal.capability, "process");
  assert.equal(typeof proposal.input, "object");
  assert.notEqual(proposal.input, null);
  const { executable, args } = proposal.input;
  assert.equal(typeof executable, "string");
  assert.ok(Array.isArray(args) && args.every((argument) => typeof argument === "string"));

  const execution = await process.execute(proposal, {
    executable,
    args,
    writablePaths: [directory],
  });
  assert.equal(execution.enforcement, "enforced");
  assert.equal(execution.exitCode, 0);
  assert.equal(await readFile(artifact, "utf8"), "workflow-e2e");

  application.recordMutation(["artifact"]);
  assert.equal(application.transition(id, "VERIFYING").kind, "accepted");
  application.recordEvidence({
    id: evidenceId("e2e-artifact-evidence"),
    observationId: observationId("e2e-artifact-observation"),
    authority: "environment",
    subject: "artifact",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: application.snapshot().mutationEpoch,
    observedAt: new Date().toISOString(),
  });
  assert.equal(application.transition(id, "VERIFIED").kind, "accepted");
  assert.equal(application.snapshot().tasks[0]?.state, "VERIFIED");
} finally {
  await rm(directory, { recursive: true, force: true });
}
