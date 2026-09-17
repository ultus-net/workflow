import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

import type { WorkflowApplication } from "../application/workflow.js";
import type { TaskGraph } from "../kernel/task-graph.js";
import {
  createWorkflowClineTuiBridge,
  type WorkflowApplicationResolver,
  type WorkflowClineTuiBridge,
  type WorkflowRunController,
} from "./cline-tui-bridge.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import { createRunRegistry, type RunReviewerFactory, type RunTestRunner } from "./run-registry.js";
import type { HubScheduler } from "./hub-scheduler.js";

/**
 * The Workflow hub daemon: a long-running loopback authority that any Cline
 * surface can resolve through the discovery file. See `docs/HUB.md`.
 */

export interface WorkflowHub {
  readonly url: string;
  readonly discoveryPath: string;
  readonly verifierDiscoveryPath: string;
  readonly verificationToken: string;
  close(): Promise<void>;
}

export function defaultHubDirectory(): string {
  return resolve(homedir(), ".workflow", "hub");
}

export function resolveHubDiscoveryPath(dir: string): string {
  return join(dir, "hub", "discovery.json");
}

/** Handles handed to the scheduler factory: the run registry surfaces. */
export interface WorkflowHubSchedulerHandles {
  resolve: WorkflowApplicationResolver;
  controller: WorkflowRunController;
  recordBlockingReason: (input: { readonly runId: string; readonly reason: string }) => void;
  /** Plan Task G5: journal a scheduled run's completion claim (observability-only). */
  recordCompletionClaim: (input: { readonly runId: string; readonly claim: string }) => void;
  /** W044 (open clause): record a run turn's metering-proxy totals for the monitor. */
  recordRunUsage: (input: { readonly runId: string; readonly usage: { readonly requests: number; readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number; readonly costUsd: number } }) => void;
}

export async function createWorkflowHub(
  application: WorkflowApplication,
  options: {
    discoveryDir?: string;
    graph?: TaskGraph;
    observeRequest?: (path: string) => void;
    observeBridgeStarted?: (url: string) => void;
    teamTaskVerificationCommand?: string;
    guard?: WorkflowGuardProvider;
    reviewerFactory?: RunReviewerFactory;
    testRunner?: RunTestRunner;
    schedulerFactory?: (handles: WorkflowHubSchedulerHandles) => HubScheduler;
  } = {},
): Promise<WorkflowHub> {
  const dir = options.discoveryDir ?? resolve(homedir(), ".workflow");
  const discoveryPath = resolveHubDiscoveryPath(dir);
  const verifierDiscoveryPath = join(dirname(discoveryPath), "verifier.json");
  const lockDir = join(dir, "hub", "lock");
  const temporaryPath = `${discoveryPath}.${process.pid}.tmp`;
  const verifierTemporaryPath = `${verifierDiscoveryPath}.${process.pid}.tmp`;
  let bridge: WorkflowClineTuiBridge | undefined;
  let discoveryPublished = false;
  acquireInstanceLock(lockDir);
  try {
    const runs = options.graph === undefined ? undefined : createRunRegistry(application, options.graph, {
      ...(options.reviewerFactory === undefined ? {} : { reviewer: options.reviewerFactory }),
      ...(options.testRunner === undefined ? {} : { testRunner: options.testRunner }),
    });
    const scheduler = options.schedulerFactory !== undefined && runs !== undefined
      ? options.schedulerFactory({
        resolve: runs.resolve,
        controller: runs.controller,
        recordBlockingReason: runs.recordBlockingReason,
        recordCompletionClaim: runs.recordCompletionClaim,
        recordRunUsage: runs.recordRunUsage,
      })
      : undefined;
    bridge = await createWorkflowClineTuiBridge(
      application,
      runs?.resolve,
      runs?.controller,
      options.observeRequest,
      options.teamTaskVerificationCommand,
      options.guard,
    );
    options.observeBridgeStarted?.(bridge.url);
    scheduler?.start();

    mkdirSync(dirname(discoveryPath), { recursive: true });
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
    discoveryPublished = true;
    writeFileSync(
      verifierTemporaryPath,
      JSON.stringify({ protocol: 1, endpoint: bridge.url, token: bridge.verificationToken }),
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(verifierTemporaryPath, verifierDiscoveryPath);
    const activeBridge = bridge;

    return {
      url: activeBridge.url,
      discoveryPath,
      verifierDiscoveryPath,
      verificationToken: activeBridge.verificationToken,
      close: async () => {
        scheduler?.stop();
        await activeBridge.close();
        rmSync(discoveryPath, { force: true });
        rmSync(verifierDiscoveryPath, { force: true });
        rmSync(lockDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await bridge?.close();
    rmSync(temporaryPath, { force: true });
    rmSync(verifierTemporaryPath, { force: true });
    if (discoveryPublished) rmSync(discoveryPath, { force: true });
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
