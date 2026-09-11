import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, URL } from "node:url";

import {
  ClineHostAdapter,
  LinuxBubblewrapContainment,
  TaskGraph,
  WorkflowApplication,
  WorkflowContainedProcess,
  createWorkflowClineShellExecutor,
  taskId,
} from "../../dist/index.js";

const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const coreUrl = pathToFileURL(join(npmRoot, "cline", "node_modules", "@cline", "core", "dist", "index.js"));
let core;
try {
  core = await import(coreUrl.href);
} catch (error) {
  throw new Error("test:cline-runtime requires the Cline CLI with @cline/core installed globally", { cause: error });
}

const fixture = new URL("./cline-plugin-fixture.mjs", import.meta.url);
const plugin = await core.loadAgentPluginFromPath(fixture.pathname);
assert.equal(plugin.name, "workflow");
assert.deepEqual(plugin.manifest.capabilities, ["hooks"]);
assert.deepEqual(await plugin.hooks.beforeTool({
  toolCall: { toolName: "write_file" },
  input: { path: "src/protected.ts" },
}), {
  stop: true,
  reason: "task A is READY, not IN_PROGRESS",
});

const id = taskId("cline-contained-executor");
const graph = new TaskGraph([{
  id,
  title: "Cline contained executor",
  state: "BLOCKED",
  dependencies: [],
  requiredEvidence: [],
}]);
const adapter = new ClineHostAdapter({
  sessionId: "cline-contained-runtime",
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
assert.equal(application.transition(id, "IN_PROGRESS").kind, "accepted");
const executor = createWorkflowClineShellExecutor(
  new WorkflowContainedProcess(application, new LinuxBubblewrapContainment()),
  adapter,
  (exitCode, output) => new core.CommandExitError(exitCode, output),
);
assert.equal(typeof core.createShellTool, "function");
const directory = await mkdtemp(join(tmpdir(), "workflow-cline-runtime-"));

try {
  const shellTool = core.createShellTool(executor, { cwd: directory });
  const result = await shellTool.execute({
    commands: [{
      command: "/usr/bin/pwd",
      args: [],
    }],
  }, { agentId: "workflow-test", iteration: 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0].success, true, JSON.stringify(result));
  assert.equal(result[0].result, `${directory}\n`);

  const failed = await shellTool.execute({ commands: [{ command: "/bin/sh", args: ["-c", "printf failed-output; exit 7"] }] }, {
    agentId: "workflow-test",
    iteration: 2,
  });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].success, false);
  assert.match(String(failed[0].result), /failed-output/);
} finally {
  await rm(directory, { recursive: true, force: true });
}
