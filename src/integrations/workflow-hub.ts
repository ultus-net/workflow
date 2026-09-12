import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

import { WorkflowApplication } from "../application/workflow.js";
import { evidenceId, observationId, taskId, type TaskId } from "../kernel/contracts.js";
import type { TaskGraph } from "../kernel/task-graph.js";
import {
  createWorkflowClineTuiBridge,
  type WorkflowApplicationResolver,
  type WorkflowClineTuiBridge,
  type WorkflowRunController,
} from "./cline-tui-bridge.js";

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
    const runs = options.graph === undefined ? undefined : createRunRegistry(application, options.graph);
    const bridge: WorkflowClineTuiBridge = await createWorkflowClineTuiBridge(
      application,
      runs?.resolve,
      runs?.controller,
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
 * Resolves the WorkflowApplication for a surface-declared workspace and
 * manages dedicated task/evidence lifecycles for scheduled runs. Each
 * workspace gets a lazily created application over the hub's shared task
 * graph, so task/evidence state is global while workspace-path authorization
 * is per surface; each run gets its own task and records its own evidence.
 * Invalid declarations throw, which the bridge surfaces as an authority error
 * (clients fail closed). See `docs/HUB_PROTOCOL.md` §3.
 */
function createRunRegistry(
  fallback: WorkflowApplication,
  graph: TaskGraph,
): { resolve: WorkflowApplicationResolver; controller: WorkflowRunController } {
  const workspaceApplications = new Map<string, WorkflowApplication>();
  const runs = new Map<string, WorkflowApplication>();

  const workspaceApplication = (workspace: string | undefined): WorkflowApplication => {
    if (workspace === undefined) return fallback;
    if (!isAbsolute(workspace)) throw new TypeError(`declared workspace must be absolute: ${workspace}`);
    if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
      throw new TypeError(`declared workspace is not an existing directory: ${workspace}`);
    }
    let application = workspaceApplications.get(workspace);
    if (application === undefined) {
      application = new WorkflowApplication(graph, fallback.host, [], fallback.allowedCapabilities, workspace);
      application.startInteractiveTask();
      workspaceApplications.set(workspace, application);
    }
    return application;
  };

  return {
    resolve(workspace?: string, runId?: string): WorkflowApplication {
      if (runId !== undefined) {
        const application = runs.get(runId);
        if (application === undefined) throw new TypeError(`unknown run: ${runId}`);
        return application;
      }
      return workspaceApplication(workspace);
    },
    controller: {
      async begin({ runId, title, workspace }) {
        if (runId.trim().length === 0 || title.trim().length === 0) {
          throw new TypeError("run begin requires a non-empty runId and title");
        }
        if (runs.has(runId)) throw new TypeError(`duplicate run: ${runId}`);
        const parent = workspaceApplication(workspace);
        const application = new WorkflowApplication(
          graph,
          fallback.host,
          [],
          fallback.allowedCapabilities,
          parent.workspaceRoot,
        );
        const runTaskId: TaskId = taskId(`run:${runId}`);
        application.addTask({ id: runTaskId, title, dependencies: [], requiredEvidence: [] });
        const started = application.transition(runTaskId, "IN_PROGRESS");
        if (started.kind !== "accepted") throw new Error(`cannot start run ${runId}: ${started.reason}`);
        application.selectActiveTask(runTaskId);
        runs.set(runId, application);
      },
      async finish({ runId, outcome }) {
        const application = runs.get(runId);
        if (application === undefined) throw new TypeError(`unknown run: ${runId}`);
        const runTaskId = taskId(`run:${runId}`);
        application.recordMutation([runId]);
        if (outcome === "verified") {
          const verifying = application.transition(runTaskId, "VERIFYING");
          if (verifying.kind !== "accepted") throw new Error(`cannot verify run ${runId}: ${verifying.reason}`);
          application.recordEvidence({
            id: evidenceId(`run-evidence:${runId}`),
            observationId: observationId(`run-observation:${runId}`),
            authority: "environment",
            subject: runId,
            result: "passed",
            freshness: "fresh",
            mutationEpoch: application.snapshot().mutationEpoch,
            observedAt: new Date().toISOString(),
          });
          const verified = application.transition(runTaskId, "VERIFIED");
          if (verified.kind !== "accepted") throw new Error(`cannot verify run ${runId}: ${verified.reason}`);
        } else {
          application.recordEvidence({
            id: evidenceId(`run-evidence:${runId}`),
            observationId: observationId(`run-observation:${runId}`),
            authority: "environment",
            subject: runId,
            result: "failed",
            freshness: "fresh",
            mutationEpoch: application.snapshot().mutationEpoch,
            observedAt: new Date().toISOString(),
          });
          application.transition(runTaskId, "FAILED");
        }
        runs.delete(runId);
      },
    },
  };
}