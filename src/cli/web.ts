import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { createConfiguredAcpRuntime } from "../integrations/acp-runtime.js";
import { createWorkflowWebServer } from "../ui/web.js";

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
const runtime = await createConfiguredAcpRuntime(application, process.cwd(), taskId("W001"));
const server = createWorkflowWebServer(application, runtime.session);
const port = Number(process.env.PORT ?? 4173);

async function shutdown(): Promise<void> {
  server.close();
  await runtime.dispose();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

server.listen(port, "127.0.0.1", () => {
  console.log(`Workflow browser UI: http://127.0.0.1:${port}`);
});
