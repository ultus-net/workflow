import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

import type { ProcessContainment } from "../containment/contracts.js";

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
  /** Extra environment entries (e.g. CLINE_API_KEY, CLINE_PROVIDER). HOME always wins. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Additional read-only paths the agent needs (e.g. a fixture script directory). */
  readonly readablePaths?: readonly string[];
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
  if (containment.isolation !== "enforced" || typeof containment.spawn !== "function") {
    throw new TypeError("contained ACP agent launch requires an enforced containment boundary");
  }
  for (const [label, value] of [
    ["executable", options.executable],
    ["workspace", options.workspace],
    ["home", options.home],
    ...(options.script !== undefined ? ([["script", options.script]] as const) : []),
  ] as const) {
    if (!isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
  }
  const readablePaths = [
    ...(options.readablePaths ?? []),
    // The entry script must stay visible inside the boundary even when it
    // lives outside the system and node-prefix binds.
    ...(options.script !== undefined ? [options.script] : []),
  ];
  return containment.spawn({
    executable: options.executable,
    args: [...(options.script !== undefined ? [options.script] : []), ...(options.args ?? [])],
    cwd: options.workspace,
    ...(readablePaths.length > 0 ? { readablePaths } : {}),
    writablePaths: [options.workspace, options.home],
    // Agents need network egress for their model API; the containment
    // property enforced here is filesystem/credential isolation.
    network: "host",
    environment: { ...options.environment, HOME: options.home },
  });
}
