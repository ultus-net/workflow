import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { randomBytes } from "node:crypto";

import type { WorkflowApplication } from "../application/workflow.js";
import type { TaskGraph } from "../kernel/task-graph.js";
import { createWorkflowHubBridge, type WorkflowHubBridge } from "./hub-http.js";
import type { EvidenceContentStore } from "./evidence-content-store.js";
import type { WorkflowApplicationResolver, WorkflowRunController } from "./run-controller.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import { createRunRegistry, type RunReviewerFactory, type RunTestRunner } from "./run-registry.js";
import type { AzureJobDispatchFn } from "./azure-jobs-dispatch.js";
import type { ValidateDispatchFn } from "./azure-jobs-record.js";
import type { TaskUsageSummary } from "./task-usage.js";
import type { HubScheduler } from "./hub-scheduler.js";
import type { SelfImprovementRegistry } from "./self-improvement-registry.js";
import type { ScheduleRegistry } from "./schedule-registry.js";
import type { ProjectRegistry } from "./project-registry.js";
import type { PermissionBroker } from "../ui/permission-broker.js";
import type { EgressPolicyRevisionStore } from "./egress-policy-revisions.js";

/**
 * The Workflow hub daemon: a long-running loopback authority that any Cline
 * surface can resolve through the discovery file. See `docs/HUB.md`.
 */

export interface WorkflowHub {
  readonly url: string;
  readonly discoveryPath: string;
  readonly verifierDiscoveryPath: string;
  readonly verificationToken: string;
  /** W183: the hub-start generation bound to every issued token. */
  readonly generation: string;
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
    /**
     * W182 (NVIDIA adoption wave A7): the durable egress policy revision store.
     * When provided, the hub mounts `/egress/pending` and `/egress/answer`, and
     * the composition root threads its `recordDenial` into the hub-composed
     * proxy lanes that carry the sink as `onEgressDenied` (OpenCode, Cline,
     * goose's OpenRouter lane, and the W129 opencode-server lane at runtime
     * level). As of W184 the sink receives W180's path/function policy tier too,
     * so an approvable `egress_policy` `no_matching_rule` denial parks
     * end-to-end. Absent → both routes 404 (capability withheld, fail closed).
     */
    egressApprovals?: EgressPolicyRevisionStore;
    /**
     * C1 deploy plan §2.c (D1/D3): the Azure job-dispatch enqueue closure. When
     * provided, the hub mounts POST /dispatch/azure-job; the composition root
     * builds it from the dispatch env (opt-in `WORKFLOW_AZURE_JOBS=1`). Absent
     * → the route 404s (capability withheld, fail closed).
     */
    dispatchAzureJob?: AzureJobDispatchFn;
    /**
     * C1 deploy plan §2.c (the return leg): the `validateDispatch(taskId)`
     * evidence-ingest read path. When provided, the hub mounts
     * POST /dispatch/azure-job/validate. Absent → the route 404s (capability
     * withheld, fail closed).
     */
    validateDispatch?: ValidateDispatchFn;
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
        // P4 topology Option A2 (issue #283): the hub's session mint + resolve
        // behind /usage/session and /usage/record's session-bound branch.
        ...(runs === undefined ? {} : { registerSurfaceSession: runs.registerSurfaceSession }),
        ...(runs === undefined ? {} : { consumeSurfaceSession: runs.consumeSurfaceSession }),
        ...(options.permissionBroker === undefined ? {} : { permissionBroker: options.permissionBroker }),
        // W182 (A7): the durable egress policy revision store — the operator
        // approval surface (routes + the proxy denial sink).
        ...(options.egressApprovals === undefined ? {} : { egressApprovals: options.egressApprovals }),
        // C1 deploy plan §2.c: the Azure job-dispatch enqueue closure behind
        // POST /dispatch/azure-job. Present only when the instance configured
        // the dispatch env (the closure is built and validated at startup).
        ...(options.dispatchAzureJob === undefined ? {} : { dispatchAzureJob: options.dispatchAzureJob }),
        ...(options.validateDispatch === undefined ? {} : { validateDispatch: options.validateDispatch }),
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
        // W183: the hub-start generation. A token replayed from a previous
        // hub start carries a different generation prefix and is rejected; the
        // same-UID file-read residual (THREAT_MODEL W073 item 1) is NOT closed
        // by this binding.
        generation: bridge.generation,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, discoveryPath);
    discoveryPublished = true;
    writeFileSync(
      verifierTemporaryPath,
      JSON.stringify({ protocol: 1, endpoint: bridge.url, token: bridge.verificationToken, generation: bridge.generation }),
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(verifierTemporaryPath, verifierDiscoveryPath);
    const activeBridge = bridge;

    return {
      url: activeBridge.url,
      discoveryPath,
      verifierDiscoveryPath,
      verificationToken: activeBridge.verificationToken,
      generation: activeBridge.generation,
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
 * The lease identity written into the lock directory. `pid` alone cannot tell
 * a live hub from an unrelated process that inherited a recycled pid, so the
 * record also carries the owner's process start time and a random token.
 * A lock is only live when every field still matches a live owner process.
 */
interface InstanceLockRecord {
  pid: number;
  /** The owner's `/proc/<pid>/stat` start time (clock ticks since boot). */
  startTime: string;
  host: string;
  token: string;
}

const LOCK_OWNER_FILE = "owner.json";
const LOCK_LEGACY_PID_FILE = "pid";
/** Bounded retries before an unreadable lock is deemed stale (mid-write window). */
const LOCK_STALE_RETRIES = 10;
const LOCK_RETRY_DELAY_MS = 20;

/**
 * Single-instance guard: the lock directory is created atomically (mkdir is
 * atomic on POSIX) and holds a lease record. The lock is LIVE only when the
 * recorded owner is a live process on THIS host whose identity (process start
 * time) still matches. The decision is tri-state so a lock is never destroyed
 * while it might still be held:
 *
 *  - `live`    — same host, owner alive, identity matches → refuse to start.
 *  - `foreign` — the record names ANOTHER host. Liveness cannot be verified
 *                from here, so the lock is treated as live and NOT reclaimed:
 *                deleting it could steal it from a live hub on a shared Azure
 *                Files mount (the multi-revision scenario this guards). Fail
 *                closed to "already running"; cross-host reclaim is manual.
 *  - `dead`    — same host, owner gone or the pid was recycled to a different
 *                process → the lock is stale and is reclaimed.
 *
 * A lock whose record is not yet readable is retried briefly before being
 * reclaimed, so a sibling that has won the `mkdir` race but not yet renamed
 * its record into place is never stolen.
 */
function acquireInstanceLock(lockDir: string): void {
  mkdirSync(dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt <= LOCK_STALE_RETRIES; attempt += 1) {
    if (attempt > 0) sleepSync(LOCK_RETRY_DELAY_MS);
    try {
      mkdirSync(lockDir);
      writeInstanceLockRecord(lockDir);
      return;
    } catch {
      // Lock exists: inspect the recorded lease.
    }
    const record = readInstanceLockRecord(lockDir);
    if (record === undefined) {
      // No readable record. A legacy lock (pre-lease `pid` file) is honored
      // while its owner lives on this host. Otherwise a sibling may be
      // mid-write (mkdir won, record not yet in place), so wait and retry
      // before declaring it stale; after the retries a still-unreadable lock is
      // a crashed writer or genuine corruption and is reclaimed.
      const legacyPid = readLegacyLockPid(lockDir);
      if (legacyPid !== undefined) {
        if (processAlive(legacyPid)) throw new Error(`Workflow hub is already running (pid ${legacyPid})`);
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (attempt < LOCK_STALE_RETRIES) continue;
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (lockOwnerState(record) !== "dead") {
      throw new Error(`Workflow hub is already running (pid ${record.pid})`);
    }
    // Same-host owner gone (or pid recycled): the lock is stale.
    rmSync(lockDir, { recursive: true, force: true });
  }
  throw new Error("Workflow hub instance lock could not be acquired");
}

/** Writes the lease record atomically (temp file + rename), so a concurrent
 * reader never observes a partial record. */
function writeInstanceLockRecord(lockDir: string): void {
  const record: InstanceLockRecord = {
    pid: process.pid,
    startTime: processStartTime(process.pid),
    host: hostname(),
    token: randomBytes(16).toString("hex"),
  };
  const temporary = join(lockDir, `.${LOCK_OWNER_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, join(lockDir, LOCK_OWNER_FILE));
}

/** Reads the lease record, returning undefined for an unreadable/corrupt lock. */
function readInstanceLockRecord(lockDir: string): InstanceLockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { pid, startTime, host, token } = parsed as Record<string, unknown>;
  if (
    typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 ||
    typeof startTime !== "string" || typeof host !== "string" || typeof token !== "string" ||
    startTime === "" || token === ""
  ) {
    return undefined;
  }
  return { pid, startTime, host, token };
}

/** The pre-lease lock format: a bare `pid` file. Honored during migration. */
function readLegacyLockPid(lockDir: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(lockDir, LOCK_LEGACY_PID_FILE), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Tri-state ownership: `live`; `foreign` (another host — cannot verify from
 * here, so treated as live); or `dead` (same host, owner gone or pid recycled
 * to a different process). */
function lockOwnerState(record: InstanceLockRecord): "live" | "foreign" | "dead" {
  if (record.host !== hostname()) return "foreign";
  if (!processAlive(record.pid)) return "dead";
  const startTime = processStartTime(record.pid);
  return startTime !== "" && startTime === record.startTime ? "live" : "dead";
}

/** A bounded synchronous delay for the stale-lock retry (the acquisition path
 * is synchronous, so there is no async boundary to yield to). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The process's start time from `/proc/<pid>/stat` (field 22): a constant per
 * process that differs even after a pid is recycled within one boot. Returns
 * "" when the process is gone or `/proc` is unavailable (non-Linux, fail
 * closed to the caller).
 */
function processStartTime(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field (2) is parenthesized and may contain spaces or parens;
    // fields after the final ")" are space-delimited, so start time (field 22)
    // is the 20th field of the tail.
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return tail[19] ?? "";
  } catch {
    return "";
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
