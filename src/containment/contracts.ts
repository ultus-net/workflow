import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { EgressPolicy } from "../integrations/egress-policy.js";

/**
 * Mount mode for the writable grant(s) of a contained process. `read-write`
 * binds each granted tree writable. `read-write-no-delete` keeps the granted
 * tree's directory entries read-only and re-binds every existing regular file
 * writable, so files can be modified but entries cannot be unlinked or
 * created. It is a type-level variant distinct from the backend `enforced` /
 * `policy-only` isolation marker; a policy-only backend cannot establish it.
 */
export type WritableMountMode = "read-write" | "read-write-no-delete";

/**
 * The requested network posture of a contained process.
 *
 * - `isolated` — a private network namespace with no host interfaces (the
 *   default).
 * - `host` — the host network namespace (requires the `network` capability).
 * - `proxied` — a private network namespace reachable only through the
 *   backend's parent-side forward proxy, which applies the W178 egress policy
 *   (deny-by-default). This is the W183 "mediated network posture B1": L7
 *   egress for proxy-aware traffic is mediated and policy-gated; raw-socket
 *   egress from a hostile process is NOT fenced and remains a THREAT_MODEL
 *   residual. Only backends that advertise `supportsProxiedNetwork` may
 *   accept it.
 * - `mediated` — a true mediated channel (supervisor-class). It is a
 *   fail-closed stub until the Wave C/P20 decision: no backend runs it, and
 *   every backend rejects it with `UNSUPPORTED_UNTIL_SUPERVISOR`.
 */
export type ContainedNetworkMode = "isolated" | "host" | "proxied" | "mediated";

/** The postures a backend may actually report: `mediated` never runs. */
export type ContainedNetworkResult = "isolated" | "host" | "proxied";

export interface ContainedProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly readablePaths?: readonly string[];
  readonly writablePaths?: readonly string[];
  /** Applies to every `writablePaths` grant; defaults to `read-write`. */
  readonly writableMountMode?: WritableMountMode;
  readonly network?: ContainedNetworkMode;
  /**
   * W183: the egress policy the parent-side forward proxy applies when
   * `network: "proxied"`. Required for the proxied posture — a proxied
   * request with no policy fails closed rather than forwarding everything.
   */
  readonly proxiedEgressPolicy?: EgressPolicy;
  readonly environment?: Readonly<Record<string, string>>;
  /** W144: a bounded wall-clock execute — the caller sets it ONLY where a
   * bounded lane is wanted (the hub's /bash route). On expiry the backend
   * kills the child's process group (SIGKILL) and rejects with a timeout
   * error carrying the partial output; absent, execute stays unbounded
   * (the agent tool lane keeps its current posture). */
  readonly timeoutMs?: number;
}

export interface ContainedProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * `enforced` means the tested containment boundary was established (Linux
   * bubblewrap). `policy-only` means execution passed validation and Workflow
   * authorization but had NO isolation (non-Linux passthrough). A passthrough
   * can never claim bwrap-level enforcement.
   */
  readonly enforcement: "enforced" | "policy-only";
  readonly network: ContainedNetworkResult;
  readonly credentials: "cleared" | "explicit";
}

/**
 * The machine-readable refusal for the `network: "mediated"` posture. True
 * deny-all mediation needs supervisor-class kernel control (Wave C), so no
 * backend runs it; every backend fails closed with this string rather than
 * pretending the posture exists. Parked as P20 (issue #444).
 */
export const UNSUPPORTED_UNTIL_SUPERVISOR = "UNSUPPORTED_UNTIL_SUPERVISOR" as const;

export interface ProcessContainment {
  /**
   * `enforced` means the backend establishes a real OS isolation boundary
   * (Linux bubblewrap). `policy-only` means requests are validated but run
   * with NO isolation. Launchers that require an enforced boundary must check
   * this marker instead of assuming one exists.
   */
  readonly isolation: "enforced" | "policy-only";
  /**
   * W183: whether this backend can run the `network: "proxied"` posture (a
   * private netns reachable only through the backend's policy-gated parent
   * forward proxy). A caller that requires mediation must check this marker
   * and fail closed rather than silently degrading to `network: "host"`.
   */
  readonly supportsProxiedNetwork?: boolean;
  execute(request: ContainedProcessRequest): Promise<ContainedProcessResult>;
  /**
   * Launches a long-lived contained process with streaming stdio (required for
   * interactive protocols such as ACP, where `execute` buffering to completion
   * is unusable). Backends without an interactive boundary omit this method;
   * callers must fail closed when it is absent.
   */
  spawn?(request: ContainedProcessRequest): ChildProcessWithoutNullStreams;
  /**
   * W183: the async spawn path. The proxied posture must create its forward
   * proxy (a loopback bind), start the shared user-namespace holder, attach
   * slirp to the sandbox netns, and learn the proxy port before it can force
   * the sandbox's proxy env vars — all asynchronously. Backends that can only
   * spawn synchronously omit this; callers prefer it and fall back to `spawn`.
   */
  spawnAsync?(request: ContainedProcessRequest): Promise<ChildProcessWithoutNullStreams>;
}
