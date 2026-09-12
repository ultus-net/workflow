import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

import { WorkflowApplication } from "../application/workflow.js";
import type { TaskGraph } from "../kernel/task-graph.js";
import { createWorkflowClineTuiBridge, type WorkflowClineTuiBridge } from "./cline-tui-bridge.js";

/**
 * The Workflow hub daemon: a long-running loopback authority that any Cline
 * surface can resolve through the discovery file. See `docs/HUB.md`.
 */

export interface WorkflowHub {
  readonly url: string;
  readonly discoveryPath: string;
  close(): Promise<void>;
}

export function defaultHubDirectory(): string {
  return resolve(homedir(), ".workflow", "hub");
}

export function resolveHubDiscoveryPath(dir: string): string {
  return join(dir, "hub", "discovery.json");
}

export async function createWorkflowHub(
  application: WorkflowApplication,
  options: { discoveryDir?: string; graph?: TaskGraph } = {},
): Promise<WorkflowHub> {
  const dir = options.discoveryDir ?? resolve(homedir(), ".workflow");
  const discoveryPath = resolveHubDiscoveryPath(dir);
  const lockDir = join(dir, "hub", "lock");
  acquireInstanceLock(lockDir);
  try {
    application.startInteractiveTask();
    const bridge: WorkflowClineTuiBridge = await createWorkflowClineTuiBridge(
      application,
      options.graph === undefined
        ? undefined
        : workspaceApplicationResolver(application, options.graph),
    );

    mkdirSync(dirname(discoveryPath), { recursive: true });
    const temporaryPath = `${discoveryPath}.${process.pid}.tmp`;
    writeFileSync(
      temporaryPath,
      JSON.stringify({
        protocol: 1,
        hubId: randomBytes(8).toString("hex"),
        endpoint: bridge.url,
        token: bridge.token,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, discoveryPath);

    return {
      url: bridge.url,
      discoveryPath,
      close: async () => {
        await bridge.close();
        rmSync(discoveryPath, { force: true });
        rmSync(lockDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Single-instance guard: the lock directory is created atomically (mkdir is
 * atomic on POSIX) and holds the owning pid. A live pid means another hub is
 * running; a dead pid means a crashed hub and the lock is reclaimed.
 */
function acquireInstanceLock(lockDir: string): void {
  mkdirSync(dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid), { encoding: "utf8", mode: 0o600 });
      return;
    } catch {
      // Lock exists: inspect the owning pid.
    }
    let pid = Number.NaN;
    try {
      pid = Number(readFileSync(join(lockDir, "pid"), "utf8").trim());
    } catch {
      // Unreadable lock: treat as stale.
    }
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
      throw new Error(`Workflow hub is already running (pid ${pid})`);
    }
    rmSync(lockDir, { recursive: true, force: true });
  }
  throw new Error("Workflow hub instance lock could not be acquired");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the WorkflowApplication for a surface-declared workspace. Each
 * workspace gets a lazily created application over the hub's shared task
 * graph, so task/evidence state is global while workspace-path authorization
 * is per surface. Invalid declarations throw, which the bridge surfaces as an
 * authority error (clients fail closed). See `docs/HUB_PROTOCOL.md` §3.
 */
function workspaceApplicationResolver(
  fallback: WorkflowApplication,
  graph: TaskGraph,
): (workspace?: string) => WorkflowApplication {
  const applications = new Map<string, WorkflowApplication>();
  return (workspace?: string): WorkflowApplication => {
    if (workspace === undefined) return fallback;
    if (!isAbsolute(workspace)) throw new TypeError(`declared workspace must be absolute: ${workspace}`);
    if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
      throw new TypeError(`declared workspace is not an existing directory: ${workspace}`);
    }
    let application = applications.get(workspace);
    if (application === undefined) {
      application = new WorkflowApplication(
        graph,
        fallback.host,
        [],
        fallback.allowedCapabilities,
        workspace,
      );
      application.startInteractiveTask();
      applications.set(workspace, application);
    }
    return application;
  };
}