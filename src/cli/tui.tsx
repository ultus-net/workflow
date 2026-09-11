import React from "react";
import { render } from "ink";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { createConfiguredClineRuntime } from "../integrations/cline-runtime.js";
import { WorkflowTui } from "../ui/tui.js";

const tasks: WorkflowTask[] = [
  {
    id: taskId("W001"),
    title: "Inspect the runnable Workflow TUI",
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
  hostCapabilities({ transport: "native", authoritativePreMutation: false }),
  [],
  new Set(["read", "mutation", "process"]),
  process.cwd(),
);

const runtime = await createConfiguredClineRuntime(application, process.cwd());
try {
  const instance = render(<WorkflowTui application={application} session={runtime.session} />);
  await instance.waitUntilExit();
} finally {
  await runtime.dispose();
}
