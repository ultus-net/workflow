import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { createWorkflowClineTuiBridge } from "../integrations/cline-tui-bridge.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { WORKFLOW_MARK } from "../ui/tui.js";
import { resolveTuiWorkspace } from "./tui-args.js";

const workspace = resolveTuiWorkspace(process.argv.slice(2), process.cwd());
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const clineRoot = resolve(root, ".workflow-cline", "cline");
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
  hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  [],
  new Set(["read", "mutation", "process"]),
  workspace,
);

application.startInteractiveTask();
const bridge = await createWorkflowClineTuiBridge(application);
try {
  const exitCode = await runClineTui(clineRoot, workspace, bridge.url, bridge.token);
  process.exitCode = exitCode;
} finally {
  await bridge.close();
}

function runClineTui(clineRoot: string, cwd: string, bridgeUrl: string, bridgeToken: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(
      "npx",
      ["--yes", "bun@1.3.13", "run", "--cwd", clineRoot, "cli", "--", "-i", "--cwd", cwd],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          WORKFLOW_CLINE_BRIDGE_URL: bridgeUrl,
          WORKFLOW_CLINE_BRIDGE_TOKEN: bridgeToken,
          WORKFLOW_TUI_MARK_B64: Buffer.from(WORKFLOW_MARK).toString("base64"),
        },
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) return reject(new Error(`Cline TUI terminated by ${signal}`));
      resolveExit(code ?? 1);
    });
  });
}
