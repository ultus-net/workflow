#!/usr/bin/env node
import { appendFileSync } from "node:fs";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { createDefaultToolboxGuardProvider } from "../integrations/mcp-toolbox-guard.js";
import { createWorkflowHub } from "../integrations/workflow-hub.js";
import { taskId } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";

/**
 * Long-running Workflow authority daemon. Any Cline surface resolves the hub
 * through the discovery file written under `<data-dir>/hub/discovery.json`.
 * See `docs/HUB.md`.
 */
const workspace = process.cwd();
const graph = new TaskGraph([
  {
    id: taskId("interactive"),
    title: "Interactive coding session",
    state: "READY",
    dependencies: [],
    requiredEvidence: [],
  },
]);
const application = new WorkflowApplication(
  graph,
  hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  [],
  new Set(["read", "mutation", "process"]),
  workspace,
);

const requestLogPath = process.env.WORKFLOW_HUB_REQUEST_LOG;
const teamTaskVerifyEnv = process.env.WORKFLOW_TEAM_TASK_VERIFY_COMMAND?.trim();
const teamTaskVerificationCommand = process.env.WORKFLOW_TEAM_TASK_VERIFY_COMMAND === undefined
  ? "true"
  : (teamTaskVerifyEnv && teamTaskVerifyEnv.length > 0 ? teamTaskVerifyEnv : undefined);

const guard = await createDefaultToolboxGuardProvider().catch((error) => {
  console.warn(`Workflow guard unavailable (advisory): ${error instanceof Error ? error.message : error}`);
  return undefined;
});

const hub = await createWorkflowHub(application, {
  graph,
  ...(guard === undefined ? {} : { guard }),
  ...(teamTaskVerificationCommand === undefined ? {} : { teamTaskVerificationCommand }),
  ...(requestLogPath === undefined ? {} : {
    observeRequest: (path) => appendFileSync(requestLogPath, `${path}\n`, { mode: 0o600 }),
  }),
});
console.log(`Workflow hub listening at ${hub.url}`);
console.log(`Discovery file: ${hub.discoveryPath}`);

await new Promise<void>((resolveShutdown) => {
  const shutdown = () => resolveShutdown();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});
await hub.close();
await guard?.close();
