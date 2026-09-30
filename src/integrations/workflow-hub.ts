import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

import type { WorkflowApplication } from "../application/workflow.js";
import type { TaskGraph } from "../kernel/task-graph.js";
import { createWorkflowHubBridge, type WorkflowHubBridge } from "./hub-http.js";
import type { EvidenceContentStore } from "./evidence-content-store.js";
import type { WorkflowApplicationResolver, WorkflowRunController } from "./run-controller.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import { createRunRegistry, type RunReviewerFactory, type RunTestRunner } from "./run-registry.js";
import type { TaskUsageSummary } from "./task-usage.js";
import type { HubScheduler } from "./hub-scheduler.js";
import type { SelfImprovementRegistry } from "./self-improvement-registry.js";
import type { ScheduleRegistry } from "./schedule-registry.js";
import type { ProjectRegistry } from "./project-registry.js";
import type { PermissionBroker } from "../ui/permission-broker.js";

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
  /** Iteration 21: journal an advisory reasoning-claim finding (observability-only). */
  recordReasoningClaim: (input: { readonly runId: string; readonly sentence: string }) => void;
  /** Iteration 21: declare that the monitor observed a run (coverage denominator). */
  noteReasoningClaimMonitor: (input: { readonly runId: string }) => void;
  /** W044 (open clause): record a run turn's metering-proxy totals for the monitor. */
  recordRunUsage: (input: { readonly runId: string; readonly usage: { readonly requests: number; readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number; readonly costUsd: number; readonly cacheReadTokens: number; readonly cacheCreateTokens: number } }) => void;
  /**
   * W111: record a turn's per-task boundary delta (the active-task pointer
   * paired with the delta). The seam a host lane calls at its turn edge; no
   * lane is wired yet (the brief §5 lane decisions stay open).
   */
  recordTaskUsage: (input: Omit<TaskUsageSummary, "recordedAt">) => void;
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
    /** W158: the bounded evidence-content store; wired → the hub exposes the /evidence-content read route and the test-runner capture records content. */
    contentStore?: EvidenceContentStore;
    schedulerFactory?: (handles: WorkflowHubSchedulerHandles) => HubScheduler;
    /**
     * W073 trigger surface: when provided, the hub exposes operator-token
     * `/rsi/start|status|cancel` routes backed by this registry. Absent means
     * the routes 404 (the loop is not configured on this hub).
     */
    selfImprovement?: SelfImprovementRegistry;
    /**
     * Checkpoint F: when provided instead of (or with) `selfImprovement`, the
     * factory receives the run-registry handles so the composition root can
     * build the production loop runner against the real controller — the same
     * lazy-handles pattern as `schedulerFactory`. Takes precedence over
     * `selfImprovement` when both are provided. Like `schedulerFactory`, the
     * factory needs the run registry, which exists only when a `graph` is
     * provided; with no graph the factory is silently unused and the routes
     * 404 (fail closed — no registry, no loop).
     */
    selfImprovementFactory?: (handles: WorkflowHubSchedulerHandles) => SelfImprovementRegistry;
    /**
     * W074 scheduled-task manager: when provided, the hub exposes
     * operator-token `/schedule/list|save|delete` routes and the VERIFIER-ONLY
     * `/schedule/run-now` route (firing a scheduled run now is a consequential
     * autonomous action; the verifier credential gates it — hub-http.ts and
     * `docs/HUB_PROTOCOL.md` §3), backed by this registry. Absent means the
     * routes 404.
     */
    schedules?: ScheduleRegistry;
    /**
     * W161: the external-task board's read capability (a closure over the
     * env-classified provider and its bounded fetch — see task-provider.ts).
     * When provided, the hub exposes the operator-token `/board/tasks` read
     * route; absent means the route 404s. The composition root builds the
     * production closure from env so the hub's payload stays credential-free.
     */
    readBoardTasks?: () => Promise<import("./task-provider.js").BoardOutcome>;
    /**
     * W162: the board's delegation capability (the hub-side single-issue read
     * behind POST /board/delegate). Absent means the route 404s — capability
     * withheld, never faked.
     */
    delegateBoardTask?: (issue: number) => Promise<import("./task-provider.js").BoardTaskOutcome>;
    /**
     * W164: the project container's registry — when provided, the hub
     * exposes operator-token `/project/list|save|delete|scope` routes backed
     * by this registry. Absent means the routes 404. The composition root
     * builds it from the persisted table (WORKFLOW_HUB_PROJECTS).
     */
    projects?: ProjectRegistry;
    /**
     * W165: the board's pull-request-state read capability (the hub-side
     * provider read the /board/tasks work-product join composes from — see
     * task-provider.ts). Absent means the payload carries no workProducts.
     */
    readWorkProductState?: (issueNumber: number) => Promise<import("./task-provider.js").WorkProductStateOutcome>;
    /**
     * W167: the read-only issue-detail capability (the hub-side provider read
     * of an issue's description and comment thread — see issue-detail.ts).
     * When provided, the hub exposes the operator-token `/board/task` route;
     * absent means the route 404s.
     */
    readIssueDetail?: (issue: number) => Promise<import("./issue-detail.js").IssueDetailOutcome>;
    /**
     * W167: the hub-recorded provider read state accessor — the record the
     * webapp's liveness pills derive from. When provided, the hub exposes the
     * operator-token `/board/read-state` route; absent means the route 404s.
     */
    providerReadState?: () => import("./issue-detail.js").ProviderReadRecord | undefined;
    /**
     * W177: the review-provenance journal reader — the lane the /snapshot
     * audit block (and the webapp's audit page through it) relays. Absent
     * means the audit block omits the lane (the honest subset).
     */
    reviewProvenance?: () => Promise<readonly import("../review/provenance.js").ReviewProvenanceRecord[]>;
    /**
     * W171: the provider-owned discovery capability (the linked board issue's
     * timeline cross-references — the hub records the actual PR reference it
     * discovers there, exactly-one rule). Absent means no discovery: the join
     * keeps the honest unreadable states.
     */
    discoverIssueCrossReferences?: (issueNumber: number) => Promise<import("./task-provider.js").CrossReferenceOutcome>;
    /**
     * P6 (issue #285): the hub process's same-process `PermissionBroker`. When
     * provided, the hub mounts the broker's pending/answer path on
     * `/api/permission` and the hub's container lanes (the /bash route and the
     * composed shells) pass `broker.askHold()` to `shellExecutorFor`, so a
     * guard `ask` a containment seat holds is answerable. In-process only —
     * never cross-process plumbing.
     */
    permissionBroker?: PermissionBroker;
  } = {},
): Promise<WorkflowHub> {
  const dir = options.discoveryDir ?? resolve(homedir(), ".workflow");
  const discoveryPath = resolveHubDiscoveryPath(dir);
  const verifierDiscoveryPath = join(dirname(discoveryPath), "verifier.json");
  const lockDir = join(dir, "hub", "lock");
  const temporaryPath = `${discoveryPath}.${process.pid}.tmp`;
  const verifierTemporaryPath = `${verifierDiscoveryPath}.${process.pid}.tmp`;
  let bridge: WorkflowHubBridge | undefined;
  let discoveryPublished = false;
  acquireInstanceLock(lockDir);
  try {
    const runs = options.graph === undefined ? undefined : createRunRegistry(application, options.graph, {
      ...(options.reviewerFactory === undefined ? {} : { reviewer: options.reviewerFactory }),
      ...(options.testRunner === undefined ? {} : { testRunner: options.testRunner }),
      ...(options.contentStore === undefined ? {} : { contentStore: options.contentStore }),
    });
    const scheduler = options.schedulerFactory !== undefined && runs !== undefined
      ? options.schedulerFactory({
        resolve: runs.resolve,
        controller: runs.controller,
        recordBlockingReason: runs.recordBlockingReason,
        recordCompletionClaim: runs.recordCompletionClaim,
        recordReasoningClaim: runs.recordReasoningClaim,
        noteReasoningClaimMonitor: runs.noteReasoningClaimMonitor,
        recordRunUsage: runs.recordRunUsage,
        recordTaskUsage: runs.recordTaskUsage,
      })
      : undefined;
    // Checkpoint F: the self-improvement registry may be composed lazily
    // against the run-registry handles so its loop runner can drive the real
    // controller. A factory beats a pre-built registry; absent both, the
    // routes 404.
    const selfImprovement = options.selfImprovementFactory !== undefined && runs !== undefined
      ? options.selfImprovementFactory({
        resolve: runs.resolve,
        controller: runs.controller,
        recordBlockingReason: runs.recordBlockingReason,
        recordCompletionClaim: runs.recordCompletionClaim,
        recordReasoningClaim: runs.recordReasoningClaim,
        noteReasoningClaimMonitor: runs.noteReasoningClaimMonitor,
        recordRunUsage: runs.recordRunUsage,
        recordTaskUsage: runs.recordTaskUsage,
      })
      : options.selfImprovement;
    // W074: connect the schedule registry's run-now to the live scheduler so
    // the operator route fires the same gated run path the clock uses. Done
    // here (not in each composition root) so any caller wiring a registry and
    // a scheduler together gets run-now for free.
    if (scheduler !== undefined && options.schedules !== undefined) {
      const scheduleRegistry = options.schedules;
      scheduleRegistry.attachRunner((id) => scheduler.trigger(id));
    }
    bridge = await createWorkflowHubBridge(
      application,
      runs?.resolve,
      runs?.controller,
      options.observeRequest,
      options.guard,
      selfImprovement,
      options.schedules,
      options.contentStore,
      {
        ...(options.readBoardTasks === undefined ? {} : { readBoardTasks: options.readBoardTasks }),
        ...(options.delegateBoardTask === undefined ? {} : { delegateBoardTask: options.delegateBoardTask }),
        ...(options.projects === undefined ? {} : { projects: options.projects }),
        ...(options.readWorkProductState === undefined ? {} : { readWorkProductState: options.readWorkProductState }),
        ...(options.readIssueDetail === undefined ? {} : { readIssueDetail: options.readIssueDetail }),
        ...(options.providerReadState === undefined ? {} : { providerReadState: options.providerReadState }),
        ...(options.reviewProvenance === undefined ? {} : { reviewProvenance: options.reviewProvenance }),
        ...(options.discoverIssueCrossReferences === undefined ? {} : { discoverIssueCrossReferences: options.discoverIssueCrossReferences }),
        // P4 topology Option A1 (issue #283): the run registry's surface-
        // observation journal writer behind the observability-only
        // /usage/record route. Present only when a registry exists.
        ...(runs === undefined ? {} : { recordSurfaceUsage: runs.recordSurfaceUsage }),
        ...(options.permissionBroker === undefined ? {} : { permissionBroker: options.permissionBroker }),
      },
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
