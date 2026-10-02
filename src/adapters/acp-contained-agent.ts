import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

import type { ProcessContainment, ContainedProcessRequest } from "../containment/contracts.js";
import type { EgressPolicy } from "../integrations/egress-policy.js";

export interface ContainedAcpAgentLaunchOptions {
  /** Absolute path to the runtime executable (a Node binary or a self-contained agent binary). */
  readonly executable: string;
  /**
   * Absolute path to the agent entry script, when the executable needs one
   * (e.g. the resolved `cline` wrapper run under Node). Self-contained
   * compiled agents omit it and receive only `args`.
   */
  readonly script?: string | undefined;
  readonly args?: readonly string[];
  /** Absolute workspace path; the only project tree the agent can write. */
  readonly workspace: string;
  /** Absolute scratch directory bound as the agent's HOME (state/logs). */
  readonly home: string;
  /** Extra environment entries (e.g. the agent's provider credential). HOME always wins. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Additional read-only paths the agent needs (e.g. a fixture script directory). */
  readonly readablePaths?: readonly string[];
  /**
   * W183: the egress policy the parent-side forward proxy applies when the
   * backend supports the `proxied` posture. Absent means no proxied policy
   * exists, so the launcher keeps the pre-W183 `network: "host"` posture
   * (filesystem/credential isolation only) rather than failing a launch that
   * cannot be mediated.
   */
  readonly proxiedEgressPolicy?: EgressPolicy;
  /**
   * W183: require the mediated (`proxied`) posture. When true the launcher
   * fails closed unless the backend advertises `supportsProxiedNetwork`;
   * when false/absent it falls back to `host` for backends without proxied
   * support (the pre-W183 posture), never silently — the chosen posture is
   * observable in the result.
   */
  readonly requireProxiedNetwork?: boolean;
}

/**
 * Launches an ACP agent process inside the OS containment boundary. This is
 * the enforcement path for agents that never delegate execution to client
 * `terminal/*`/`fs/*` capabilities (verified for Cline 3.0.61: its ACP
 * `initialize` ignores client capabilities and all tool execution stays in
 * the agent process), so the agent process itself must be contained.
 *
 * Fails closed unless the backend reports an enforced boundary with streaming
 * spawn support — a policy-only passthrough must never masquerade as a
 * contained agent launch.
 */
export function launchContainedAcpAgent(
  containment: ProcessContainment,
  options: ContainedAcpAgentLaunchOptions,
): ChildProcessWithoutNullStreams {
  const request = buildLaunchRequest(containment, options);
  if (request.network === "proxied") {
    throw new Error("proxied agent launch requires the async path (launchContainedAcpAgentAsync)");
  }
  if (containment.isolation !== "enforced" || typeof containment.spawn !== "function") {
    throw new TypeError("contained ACP agent launch requires an enforced containment boundary");
  }
  return containment.spawn(request);
}

/**
 * W183: the async launch path the production composition uses. It selects the
 * `proxied` posture when the backend advertises `supportsProxiedNetwork` and a
 * `proxiedEgressPolicy` is supplied; otherwise it keeps the pre-W183 `host`
 * posture. When `requireProxiedNetwork` is set it fails closed unless both
 * conditions hold — a caller that demands mediation never silently degrades.
 */
export async function launchContainedAcpAgentAsync(
  containment: ProcessContainment,
  options: ContainedAcpAgentLaunchOptions,
): Promise<ChildProcessWithoutNullStreams> {
  if (containment.isolation !== "enforced") {
    throw new TypeError("contained ACP agent launch requires an enforced containment boundary");
  }
  const request = buildLaunchRequest(containment, options);
  if (request.network === "proxied") {
    if (typeof containment.spawnAsync !== "function") {
      throw new TypeError("contained ACP agent launch requires an enforced containment boundary with async streaming spawn for the proxied posture");
    }
    return containment.spawnAsync(request);
  }
  const child = containment.spawn?.(request);
  if (child === undefined) {
    throw new TypeError("contained ACP agent launch requires an enforced containment boundary");
  }
  return child;
}

/**
 * Resolves the launch request and its network posture, validating shape first.
 * The posture decision is:
 *
 * - `requireProxiedNetwork` set → require `supportsProxiedNetwork` **and** a
 *   policy, else throw (caller demanded mediation; fail closed).
 * - backend supports proxied **and** a policy is supplied → `proxied`.
 * - otherwise → `host` (the pre-W183 posture: filesystem/credential isolation
 *   only), which is still an enforced boundary.
 */
function buildLaunchRequest(
  containment: ProcessContainment,
  options: ContainedAcpAgentLaunchOptions,
): ContainedProcessRequest {
  for (const [label, value] of [
    ["executable", options.executable],
    ["workspace", options.workspace],
    ["home", options.home],
    ...(options.script !== undefined ? ([["script", options.script]] as const) : []),
  ] as const) {
    if (!isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
  }
  const readablePaths = [
    ...new Set([
      ...(options.readablePaths ?? []),
      // The entry script must stay visible inside the boundary even when it
      // lives outside the system and node-prefix binds.
      ...(options.script !== undefined ? [options.script] : []),
    ]),
  ];
  const wantsProxied = options.requireProxiedNetwork === true || options.proxiedEgressPolicy !== undefined;
  if (wantsProxied && containment.supportsProxiedNetwork !== true) {
    throw new TypeError(options.requireProxiedNetwork === true
      ? "contained ACP agent launch requires a backend that supports the proxied network posture"
      : "contained ACP agent launch was given an egress policy but the backend does not support the proxied posture");
  }
  if (wantsProxied && options.proxiedEgressPolicy === undefined) {
    throw new TypeError("contained ACP agent launch requires an egress policy for the proxied network posture");
  }
  const proxied = wantsProxied;
  return {
    executable: options.executable,
    args: [...(options.script !== undefined ? [options.script] : []), ...(options.args ?? [])],
    cwd: options.workspace,
    ...(readablePaths.length > 0 ? { readablePaths } : {}),
    writablePaths: [options.workspace, options.home],
    // Agents need network egress for their model API. With a proxied-capable
    // backend and a policy, that egress is mediated and policy-gated; without
    // one it keeps the pre-W183 host posture (the containment property then
    // enforced is filesystem/credential isolation).
    network: proxied ? "proxied" : "host",
    ...(proxied && options.proxiedEgressPolicy !== undefined ? { proxiedEgressPolicy: options.proxiedEgressPolicy } : {}),
    environment: { ...options.environment, HOME: options.home },
  };
}
