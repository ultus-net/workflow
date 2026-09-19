import type { AddressInfo } from "node:net";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { PermissionBroker } from "../ui/permission-broker.js";
import { createAgentRuntime } from "../ui/web-agents.js";
import { createWorkflowWebServer } from "../ui/web.js";
import { WebSessionManager } from "../ui/web-sessions.js";
import { buildWebappBundle } from "../ui/webapp/bundle.js";

/** A running Workflow browser UI service; `close()` is idempotent. */
export interface WorkflowWebService {
  /** Loopback URL the browser should open, e.g. `http://127.0.0.1:4173`. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartWorkflowWebOptions {
  /** Listen port; defaults to `PORT` (4173 when unset). `0` picks a free port. */
  readonly port?: number;
  /** Workspace root the application confines to; defaults to `process.cwd()`. */
  readonly workspace?: string;
}

/**
 * Start the Workflow browser operator UI: the same application boundary every
 * surface consumes, with the per-session manager defaulting to OpenCode in ACP
 * mode (`DEFAULT_WEB_AGENT`). This is the surface the `workflow` launcher
 * serves; `src/cli/web.ts` is the thin no-browser entry.
 */
export async function startWorkflowWeb(options: StartWorkflowWebOptions = {}): Promise<WorkflowWebService> {
  const workspace = options.workspace ?? process.cwd();
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

  // Workspace confinement gates the process/network capability toggles: with
  // the root pinned, subject paths outside the workspace are denied before the
  // capability is ever consulted.
  const application = new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
    [],
    new Set(["read", "mutation"]),
    workspace,
  );
  // One broker for the whole service: permission mode and always/reject
  // patterns survive session switches; parked prompts are denied on switch.
  const permissionBroker = new PermissionBroker();
  const manager = new WebSessionManager({
    factory: (agent, resumeFrom) =>
      createAgentRuntime(agent, application, workspace, taskId("W001"), resumeFrom, { permissionBroker }),
    permissionBroker,
  });
  const webapp = await buildWebappBundle();
  // W074/W073: the browser reaches the hub's schedule table and loop registry
  // through this service's proxy; the hub stays the single writer and the
  // browser never holds a hub token. A hub that is not running degrades to the
  // Schedules page reporting "hub unavailable" (never a fabricated list).
  const server = createWorkflowWebServer(application, manager, webapp, {
    ...(process.env.WORKFLOW_HUB_DIR === undefined ? {} : { hubDiscoveryDir: process.env.WORKFLOW_HUB_DIR }),
  });
  const port = options.port ?? Number(process.env.PORT ?? 4173);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | string | null;
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  let closed = false;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      server.close();
      await manager.dispose();
    },
  };
}
