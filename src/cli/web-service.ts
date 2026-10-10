import type { AddressInfo } from "node:net";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { PermissionBroker } from "../ui/permission-broker.js";
import { createAgentRuntime } from "../ui/web-agents.js";
import { createWorkflowWebServer } from "../ui/web.js";
import { loadSettings } from "../integrations/workflow-settings.js";
import { laneTaskUsageSink } from "../integrations/task-usage.js";
import { createSurfaceUsageSessionPost } from "../integrations/surface-usage-client.js";
import type { WorkflowAcpRuntime } from "../integrations/acp-runtime.js";
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
 * C1 hub endpoint (D5): start the Workflow hub operator UI INSIDE the hub
 * process against the hub's own canonical `WorkflowApplication`. This is the
 * single-writer composition — the very point the D5 review fixed: the UI must
 * NOT build a second `WorkflowApplication`/`TaskGraph` (the standalone
 * `startWorkflowWeb` does, as the demo surface the `workflow` launcher serves).
 * Every canonical mutation already proxies to the hub bridge via the discovery
 * file; the only local-authority reads are `application.snapshot()` and
 * `application.workspaceRoot`, which must be the hub's own instance.
 *
 * The hub UI is the MANAGEMENT/scheduling surface (settings, schedules, runs),
 * not the interactive coding surface (that is the vendor OpenCode UI at the
 * `code` host, D5's settled primary). So this composes NO session manager: the
 * session routes answer their honest "session management unavailable" state,
 * and no ACP runtime launches inside the authority process.
 */
export async function startHubWebUi(
  application: WorkflowApplication,
  options: StartWorkflowWebOptions = {},
): Promise<WorkflowWebService> {
  const workspace = options.workspace ?? application.workspaceRoot ?? process.cwd();
  const webapp = await buildWebappBundle();
  // No session manager (the management-only posture above). The hub discovery
  // dir rides the hub's own env so the UI's schedule/RSI/project relays reach
  // the bridge; absent means the same fail-closed "hub unavailable" degrade.
  const server = createWorkflowWebServer(application, undefined, webapp, {
    workspace,
    ...(process.env.WORKFLOW_HUB_DIR === undefined ? {} : { hubDiscoveryDir: process.env.WORKFLOW_HUB_DIR }),
  });
  const port = options.port ?? Number(process.env.WORKFLOW_HUB_WEB_PORT ?? 0);
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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
  // P4 topology Option A2 (issue #283): the hub-BOUND cross-process sink. A
  // completed interactive turn asks the hub to mint a single-use session id
  // bound to this runtime's task, then posts only the counters + that id to the
  // hub's observability-only /usage/record route (read from the hub discovery
  // file at post time; no hub → nothing minted, nothing recorded). The hub
  // resolves session→task from its OWN registration record and writes the
  // CANONICAL `taskUsage` journal — the record wire carries NO task id, so the
  // task is hub-derived, never a client attribution (W153). The `usage` reading
  // is deferred: it reads the runtime once it exists, at the turn boundary.
  const postSurfaceSessionUsage = createSurfaceUsageSessionPost(
    process.env.WORKFLOW_HUB_DIR === undefined ? {} : { hubDiscoveryDir: process.env.WORKFLOW_HUB_DIR },
  );
  const manager = new WebSessionManager({
    // Load settings per session so an edit made on the settings page is
    // pushed into the next session's agent launch config. W151: a session's
    // persisted raised budget rides the same options into the runtime. The
    // manager also hands the session's stable registry id (P4 A1); A2 no longer
    // carries a surface stamp on the record wire, so the factory omits it (a
    // factory that ignores it stays valid).
    factory: async (agent, resumeFrom, budgetOverride) => {
      const usageHolder: { runtime?: WorkflowAcpRuntime } = {};
      const composed = await createAgentRuntime(agent, application, workspace, taskId("W001"), resumeFrom, {
        permissionBroker,
        settings: loadSettings({ workspace }),
        ...(budgetOverride === undefined ? {} : { budgetOverride }),
        taskUsage: laneTaskUsageSink(() => usageHolder.runtime?.metrics?.(), postSurfaceSessionUsage),
      });
      usageHolder.runtime = composed;
      return composed;
    },
    permissionBroker,
  });
  const webapp = await buildWebappBundle();
  // W074/W073 (main's scheduled-task manager + RSI loop): the browser reaches
  // the hub's schedule table and loop registry through this service's proxy;
  // the hub stays the single writer and the browser never holds a hub token. A
  // hub that is not running degrades to the Schedules page reporting "hub
  // unavailable" (never a fabricated list).
  const server = createWorkflowWebServer(application, manager, webapp, {
    workspace,
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
