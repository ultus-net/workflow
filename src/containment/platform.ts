import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

import type {
  ContainedProcessRequest,
  ContainedProcessResult,
  ProcessContainment,
  WritableMountMode,
} from "./contracts.js";
import { LinuxBubblewrapContainment } from "./linux-bwrap.js";

/**
 * Policy-only execution establishes no filesystem boundary: `read-write` is
 * the only writable mount mode it can stand behind. A requested
 * `read-write-no-delete` is refused rather than silently run with deletion
 * permitted.
 */
function requireSupportedWritableMountMode(value: WritableMountMode | undefined): void {
  if (value === undefined || value === "read-write") return;
  if (value === "read-write-no-delete") {
    throw new Error("passthrough containment cannot enforce read-write-no-delete");
  }
  throw new TypeError("writableMountMode must be read-write or read-write-no-delete");
}

/**
 * Cross-platform containment selection. Process isolation exists only on
 * Linux (bubblewrap). On every other platform Workflow degrades to
 * POLICY-ONLY mode: requests are still validated and authorized through the
 * same pipeline, but there is NO process isolation. Degradation is visible in
 * two places: a warning at selection time, and the result's
 * `enforcement: "policy-only"` marker, so a passthrough can never claim the
 * bwrap `enforced` boundary.
 */

export class PassthroughContainment implements ProcessContainment {
  readonly isolation = "policy-only" as const;

  async execute(request: ContainedProcessRequest): Promise<ContainedProcessResult> {
    if (!isAbsolute(request.executable)) throw new TypeError("executable must be an absolute path");
    if (request.cwd !== undefined && !isAbsolute(request.cwd)) throw new TypeError("cwd must be an absolute path");
    const network = request.network ?? "isolated";
    if (network !== "isolated" && network !== "host") throw new TypeError("network must be isolated or host");
    requireSupportedWritableMountMode(request.writableMountMode);

    const environment = request.environment ?? {};
    return await new Promise<ContainedProcessResult>((resolveResult, rejectResult) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: Object.keys(environment).length === 0 ? process.env : environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", rejectResult);
      child.once("close", (exitCode) => {
        resolveResult({
          exitCode,
          stdout,
          stderr,
          enforcement: "policy-only",
          network,
          credentials: Object.keys(environment).length === 0 ? "cleared" : "explicit",
        });
      });
    });
  }

  /**
   * Streaming stdio launch with NO isolation (policy-only marker on the
   * class). Callers that require an enforced boundary must refuse this
   * backend via the `isolation` marker instead of spawning anyway.
   */
  spawn(request: ContainedProcessRequest): ChildProcessWithoutNullStreams {
    if (!isAbsolute(request.executable)) throw new TypeError("executable must be an absolute path");
    if (request.cwd !== undefined && !isAbsolute(request.cwd)) throw new TypeError("cwd must be an absolute path");
    requireSupportedWritableMountMode(request.writableMountMode);
    const environment = request.environment ?? {};
    return spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: Object.keys(environment).length === 0 ? process.env : environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}

export function selectContainment(
  platform: NodeJS.Platform = process.platform,
  warn: (message: string) => void = (message) => console.warn(`[workflow] ${message}`),
): ProcessContainment {
  if (platform === "linux") return new LinuxBubblewrapContainment();
  warn(`no process isolation: policy gating only (platform ${platform})`);
  return new PassthroughContainment();
}
