import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { probeOpencodeHealth } from "./opencode-health.js";

/**
 * C1 launcher plane-awareness (deploy plan task 2b; spec §10:230-246).
 *
 * A remote plane is always-on by posture (`minReplicas=1`), but it can still be
 * unreachable: a revision restart, a manual scale-in, or a network fault. The
 * launcher probes gateway health BEFORE attaching and classifies the state
 * before acting:
 *
 *   - **ready**   — the gateway answers; attach.
 *   - **asleep**   — the ACA resource exists but is scaled to zero
 *                    (`minReplicas=0`); PATCH `minReplicas` 0->1 with the
 *                    operator's ambient `az` credentials, poll health with a
 *                    bounded timeout, then attach.
 *   - **broken**   — the resource is missing, a revision failed, or the app is
 *                    running but the gateway is gone; never attempt a wake that
 *                    cannot succeed — report the honest state instead.
 *   - **no-az**    — no `az` cli session: skip the wake, state exactly why, and
 *                    NEVER hang.
 *
 * Fail-closed throughout, the same discipline as the launcher's doctor/
 * discovery seams: a wake is attempted only when the classification proves it
 * can help, and every failure path resolves to an honest state line rather than
 * an optimistic attach.
 *
 * One-way rule: this module names only environment VARIABLES
 * (`WORKFLOW_PLANE_ACA_RESOURCE_GROUP`, `WORKFLOW_PLANE_ACA_APP`); the instance
 * supplies the values, exactly as it supplies the gateway URL and password.
 */

/** The ACA resource facts the classifier reads (a subset of `az containerapp show`). */
export interface PlaneResourceFacts {
  readonly exists: boolean;
  readonly provisioningState?: string | undefined;
  readonly runningStatus?: string | undefined;
  readonly minReplicas?: number | undefined;
}

/** The launcher's verdict about the plane. */
export type PlaneState =
  | { readonly kind: "ready"; readonly version?: string | undefined }
  | { readonly kind: "asleep"; readonly reason: string }
  | { readonly kind: "broken"; readonly reason: string }
  | { readonly kind: "no-az"; readonly reason: string };

export interface PlaneClassifyInput {
  readonly reachable: boolean;
  readonly version?: string | undefined;
  /** True when an `az` cli session is live (a wake could run). */
  readonly azSession: boolean;
  /** Resource facts, or undefined when the resource/query could not be read. */
  readonly resource?: PlaneResourceFacts | undefined;
}

/**
 * The pure classification table. Reachability wins outright (never touch `az`
 * for a live plane). Otherwise the `az` session gates the wake: without it the
 * answer is `no-az` (an honest dead end, not a doomed attempt). With a session,
 * resource facts split asleep from broken, and any unreadable or unhealthy
 * resource is `broken`.
 */
export function classifyPlaneState(input: PlaneClassifyInput): PlaneState {
  if (input.reachable) {
    return input.version === undefined ? { kind: "ready" } : { kind: "ready", version: input.version };
  }
  if (!input.azSession) {
    return { kind: "no-az", reason: "no az cli session (log in to enable plane wake)" };
  }
  const resource = input.resource;
  if (resource === undefined || !resource.exists) {
    return { kind: "broken", reason: "plane resource not found" };
  }
  // A failed/non-terminal provisioning state is a revision problem a wake cannot
  // fix.
  if (resource.provisioningState !== undefined && resource.provisioningState !== "Succeeded") {
    return { kind: "broken", reason: `provisioning state is ${resource.provisioningState}` };
  }
  // Scale-to-zero is the ONE unreachable state a wake can fix. Checked before
  // runningStatus because a zero-replica app reports a stopped/unknown status.
  if (resource.minReplicas === 0) {
    return { kind: "asleep", reason: "scaled to zero (minReplicas=0)" };
  }
  if (resource.runningStatus !== undefined && resource.runningStatus !== "Running") {
    return { kind: "broken", reason: `replica running status is ${resource.runningStatus}` };
  }
  return { kind: "broken", reason: "resource is running but the gateway is unreachable" };
}

/** The honest one-line state notice the launcher prints. */
export function planeStateLine(state: PlaneState): string {
  switch (state.kind) {
    case "ready":
      return state.version === undefined ? "[plane] gateway ready" : `[plane] gateway ready (${state.version})`;
    case "asleep":
      return `[plane] plane is asleep (${state.reason}); waking automatically`;
    case "broken":
      return `[plane] plane is unreachable and cannot be woken: ${state.reason}`;
    case "no-az":
      return `[plane] plane is unreachable; ${state.reason}`;
  }
}

/** Probes gateway health, resolving undefined when unreachable. */
export type PlaneProbe = () => Promise<{ readonly version?: string | undefined } | undefined>;

export interface PlaneWakeDeps {
  readonly probe: PlaneProbe;
  /** True when `az account show` succeeds (a wake could run). */
  readonly azSession: () => Promise<boolean>;
  /** Reads the ACA resource facts; undefined when the resource is absent. */
  readonly show: () => Promise<PlaneResourceFacts | undefined>;
  /** PATCHes `minReplicas` 0->1 with the operator's credentials. */
  readonly wake: () => Promise<void>;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface PlaneReadyOptions {
  readonly timeoutMs?: number | undefined;
  readonly pollMs?: number | undefined;
  readonly report?: ((line: string) => void) | undefined;
}

export interface PlaneReadyOutcome {
  readonly state: PlaneState;
  /** True only when a wake was attempted AND the bounded poll observed health. */
  readonly woke: boolean;
}

/** The bounded post-wake health window (spec: "bounded health-poll timeout"). */
export const PLANE_WAKE_TIMEOUT_MS = 90_000;
export const PLANE_WAKE_POLL_MS = 2_000;

/**
 * Probes, classifies, and — only for a proven-asleep plane with an `az` session
 * — wakes it, then polls health within a bounded window. Every path resolves to
 * an outcome (never throws for a transport fault) and the `no-az` path performs
 * NO polling, so a missing `az` can never hang the launcher.
 */
export async function ensurePlaneReady(
  deps: PlaneWakeDeps,
  options: PlaneReadyOptions = {},
): Promise<PlaneReadyOutcome> {
  const report = options.report ?? (() => undefined);
  const probe = async (): Promise<{ readonly version?: string | undefined } | undefined> => {
    try {
      return await deps.probe();
    } catch {
      return undefined;
    }
  };

  const first = await probe();
  if (first !== undefined) {
    return { state: classifyPlaneState({ reachable: true, version: first.version, azSession: false }), woke: false };
  }

  const azSession = await deps.azSession().catch(() => false);
  if (!azSession) {
    const state = classifyPlaneState({ reachable: false, azSession: false });
    report(planeStateLine(state));
    return { state, woke: false };
  }

  const resource = await deps.show().catch(() => undefined);
  const initial = classifyPlaneState({ reachable: false, azSession: true, resource });
  if (initial.kind !== "asleep") {
    report(planeStateLine(initial));
    return { state: initial, woke: false };
  }

  report(planeStateLine(initial));
  try {
    await deps.wake();
  } catch (error) {
    const state: PlaneState = {
      kind: "broken",
      reason: `wake failed: ${error instanceof Error ? error.message : String(error)}`,
    };
    report(planeStateLine(state));
    return { state, woke: false };
  }

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms)));
  const timeoutMs = options.timeoutMs ?? PLANE_WAKE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? PLANE_WAKE_POLL_MS;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs);
    const again = await probe();
    if (again !== undefined) {
      const ready = classifyPlaneState({ reachable: true, version: again.version, azSession: true });
      report(planeStateLine(ready));
      return { state: ready, woke: true };
    }
  }
  const state: PlaneState = { kind: "broken", reason: `wake timed out after ${timeoutMs}ms` };
  report(planeStateLine(state));
  return { state, woke: false };
}

// ── the `az`-backed deps (the real plane lane) ──────────────────────────────

export interface PlaneWakeTarget {
  readonly resourceGroup: string;
  readonly app: string;
}

/** The env NAMES (never values) that carry the instance's ACA coordinates. */
export const PLANE_WAKE_ENV_KEYS = ["WORKFLOW_PLANE_ACA_RESOURCE_GROUP", "WORKFLOW_PLANE_ACA_APP"] as const;

/**
 * Resolves the ACA target from the environment. Returns undefined when neither
 * variable is set (wake not configured — the launcher still probes and reports
 * honestly), and throws when only one is set (a partial declaration is a
 * misconfiguration, never a silent skip).
 */
export function resolvePlaneWakeTarget(env: NodeJS.ProcessEnv): PlaneWakeTarget | undefined {
  const resourceGroup = env.WORKFLOW_PLANE_ACA_RESOURCE_GROUP;
  const app = env.WORKFLOW_PLANE_ACA_APP;
  const rgSet = resourceGroup !== undefined && resourceGroup !== "";
  const appSet = app !== undefined && app !== "";
  if (!rgSet && !appSet) return undefined;
  if (!rgSet || !appSet) {
    throw new Error(
      "plane wake requires BOTH WORKFLOW_PLANE_ACA_RESOURCE_GROUP and WORKFLOW_PLANE_ACA_APP",
    );
  }
  return { resourceGroup: resourceGroup as string, app: app as string };
}

/** Runs `az` with an argument array (no shell) and returns stdout. */
export type PlaneAzExec = (args: readonly string[]) => Promise<string>;

export function defaultPlaneAzExec(timeoutMs = 15_000): PlaneAzExec {
  const exec = promisify(execFile);
  return async (args) => {
    const { stdout } = await exec("az", [...args], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  };
}

/** Parses the `az containerapp show --query` JSON into resource facts. */
export function parsePlaneResourceFacts(stdout: string): PlaneResourceFacts | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // `az` renders a missing --query leaf as JSON null; treat it as absent.
  return {
    exists: true,
    ...(typeof record.provisioningState === "string" ? { provisioningState: record.provisioningState } : {}),
    ...(typeof record.runningStatus === "string" ? { runningStatus: record.runningStatus } : {}),
    ...(typeof record.minReplicas === "number" ? { minReplicas: record.minReplicas } : {}),
  };
}

export interface CreateAzurePlaneWakeDepsOptions {
  readonly target: PlaneWakeTarget;
  readonly gatewayUrl: string;
  readonly auth: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly azExec?: PlaneAzExec | undefined;
}

/** Builds the real `az` + gateway deps for the plane lane. */
export function createAzurePlaneWakeDeps(options: CreateAzurePlaneWakeDepsOptions): PlaneWakeDeps {
  const fetchImpl = options.fetchImpl ?? fetch;
  const az = options.azExec ?? defaultPlaneAzExec();
  return {
    probe: async () => {
      const verdict = await probeOpencodeHealth(fetchImpl, options.gatewayUrl, options.auth);
      return verdict === undefined ? undefined : { version: verdict.version };
    },
    azSession: async () => {
      try {
        await az(["account", "show", "--query", "id", "-o", "tsv"]);
        return true;
      } catch {
        return false;
      }
    },
    show: async () => {
      let stdout: string;
      try {
        stdout = await az([
          "containerapp", "show",
          "--name", options.target.app,
          "--resource-group", options.target.resourceGroup,
          "--query",
          "{provisioningState:properties.provisioningState,runningStatus:properties.runningStatus,minReplicas:properties.template.scale.minReplicas}",
          "-o", "json",
        ]);
      } catch {
        // Non-zero exit (resource missing, auth) has no facts: the classifier
        // reads that as broken, never as asleep.
        return undefined;
      }
      return parsePlaneResourceFacts(stdout);
    },
    wake: async () => {
      await az([
        "containerapp", "update",
        "--name", options.target.app,
        "--resource-group", options.target.resourceGroup,
        "--min-replicas", "1",
      ]);
    },
  };
}

// ── the explicit-gateway lane the launcher calls ────────────────────────────

export interface ExplicitPlaneProbe {
  readonly gatewayUrl: string;
  readonly tuiUsername: string;
  readonly tuiPassword: string;
}

export interface EnsureExplicitPlaneReadyOptions extends PlaneReadyOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly azExec?: PlaneAzExec | undefined;
  /** Injected for tests; defaults to the real `az`-backed factory. */
  readonly createDeps?: ((options: CreateAzurePlaneWakeDepsOptions) => PlaneWakeDeps) | undefined;
}

/**
 * Plane-awareness for the operator-exported explicit gateway. When the ACA
 * coordinates are absent the lane still probes health and reports honestly
 * (never attempting `az`); when present it runs the full classify/wake/poll.
 * A broken or no-az verdict is the caller's cue to fail closed rather than
 * attach to nothing.
 */
export async function ensureExplicitPlaneReady(
  explicit: ExplicitPlaneProbe,
  env: NodeJS.ProcessEnv,
  options: EnsureExplicitPlaneReadyOptions = {},
): Promise<PlaneReadyOutcome> {
  const auth = `Basic ${Buffer.from(`${explicit.tuiUsername}:${explicit.tuiPassword}`).toString("base64")}`;
  const report = options.report ?? (() => undefined);
  const target = resolvePlaneWakeTarget(env);

  if (target === undefined) {
    const verdict = await probeOpencodeHealth(options.fetchImpl ?? fetch, explicit.gatewayUrl, auth);
    if (verdict !== undefined) {
      // A live gateway needs no notice; only the unreachable case is reported.
      return { state: verdict.version === undefined ? { kind: "ready" } : { kind: "ready", version: verdict.version }, woke: false };
    }
    const state: PlaneState = {
      kind: "broken",
      reason:
        "the gateway is unreachable and plane wake is not configured (set WORKFLOW_PLANE_ACA_RESOURCE_GROUP and WORKFLOW_PLANE_ACA_APP)",
    };
    report(planeStateLine(state));
    return { state, woke: false };
  }

  const deps = (options.createDeps ?? createAzurePlaneWakeDeps)({
    target,
    gatewayUrl: explicit.gatewayUrl,
    auth,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.azExec !== undefined ? { azExec: options.azExec } : {}),
  });
  return ensurePlaneReady(deps, {
    ...(options.report !== undefined ? { report: options.report } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
  });
}
