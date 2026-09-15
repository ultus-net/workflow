import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { createConfiguredAcpRuntime } from "../integrations/acp-runtime.js";
import { createWorkflowWebServer } from "../ui/web.js";
import { WebSessionManager } from "../ui/web-sessions.js";
import { buildWebappBundle } from "../ui/webapp/bundle.js";

const tasks: WorkflowTask[] = [
  {
    id: taskId("W001"),
    title: "Inspect the browser Workflow UI",
    state: "BLOCKED",
    dependencies: [],
    requiredEvidence: [],
  },
  {
    id: taskId("W002"),
    title: "Observe dependency-derived readiness",
    state: "BLOCKED",
    dependencies: [taskId("W001")],
    requiredEvidence: [],
  },
];

const application = new WorkflowApplication(
  new TaskGraph(tasks),
  hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
);
const manager = new WebSessionManager({
  factory: (resumeFrom) => createConfiguredAcpRuntime(application, process.cwd(), taskId("W001"), resumeFrom),
});
const webapp = await buildWebappBundle();
const server = createWorkflowWebServer(application, manager, webapp);
const port = Number(process.env.PORT ?? 4173);

async function shutdown(): Promise<void> {
  server.close();
  await manager.dispose();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

server.listen(port, "127.0.0.1", () => {
  console.log(`Workflow browser UI: http://127.0.0.1:${port}`);
});
