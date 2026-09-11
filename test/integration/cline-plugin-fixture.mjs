import {
  ClineHostAdapter,
  TaskGraph,
  WorkflowApplication,
  createWorkflowClinePlugin,
  taskId,
} from "../../dist/index.js";

const task = {
  id: taskId("A"),
  title: "Cline runtime integration",
  state: "BLOCKED",
  dependencies: [],
  requiredEvidence: [],
};
const adapter = new ClineHostAdapter({
  sessionId: "cline-runtime-smoke",
  taskId: task.id,
  isMutatingTool: () => true,
  authoritativePreMutation: true,
});
const application = new WorkflowApplication(new TaskGraph([task]), adapter.capabilities);

export default createWorkflowClinePlugin(application, adapter);
