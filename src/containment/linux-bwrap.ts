import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  ContainedNetworkMode,
  ContainedProcessRequest,
  ContainedProcessResult,
  ProcessContainment,
} from "./contracts.js";
import { UNSUPPORTED_UNTIL_SUPERVISOR } from "./contracts.js";
import { buildBubblewrapInvocation } from "./bwrap-args.js";

/**
 * The plain (isolated/host) Bubblewrap backend. The `proxied` posture lives in
 * `proxied-bwrap.ts`, which composes this backend's boundary with a parent
 * forward proxy; `mediated` is a fail-closed stub everywhere.
 */
export class LinuxBubblewrapContainment implements ProcessContainment {
  readonly isolation = "enforced" as const;
  readonly supportsProxiedNetwork: boolean = false;

  constructor(readonly bwrapPath = "/usr/bin/bwrap") {}

  async execute(request: ContainedProcessRequest): Promise<ContainedProcessResult> {
    const network = request.network ?? "isolated";
    if (network === "mediated") throw new Error(UNSUPPORTED_UNTIL_SUPERVISOR);
    if (network === "proxied") {
      throw new Error("LinuxBubblewrapContainment does not support network: \"proxied\"; use ProxiedBubblewrapContainment");
    }
    if (network !== "isolated" && network !== "host" && network !== "proxied" && network !== "mediated") {
      throw new TypeError("network must be isolated or host");
    }
    const { mountArgs, command, environment, unshareNet } = buildBubblewrapInvocation(request, network);
    const args = [...mountArgs];
    if (unshareNet) args.push("--unshare-net");
    args.push("--", ...command);
    await this.#probe(network);
    return await this.#spawn(args, network, Object.keys(environment).length === 0 ? "cleared" : "explicit", request.timeoutMs);
  }

  /**
   * Launches a long-lived contained process with streaming stdio for
   * interactive protocols. Unlike `execute`, no runtime probe runs first:
   * boundary failures surface through the child (spawn `error` event or a
   * `bwrap:` stderr prefix followed by a non-zero exit), and callers must
   * treat either as fail-closed transport errors.
   */
  spawn(request: ContainedProcessRequest): ChildProcessWithoutNullStreams {
    const network = request.network ?? "isolated";
    if (network === "mediated") throw new Error(UNSUPPORTED_UNTIL_SUPERVISOR);
    if (network === "proxied") {
      throw new Error("LinuxBubblewrapContainment does not support network: \"proxied\"; use ProxiedBubblewrapContainment");
    }
    if (network !== "isolated" && network !== "host" && network !== "proxied" && network !== "mediated") {
      throw new TypeError("network must be isolated or host");
    }
    const { mountArgs, command, unshareNet } = buildBubblewrapInvocation(request, network);
    const args = [...mountArgs];
    if (unshareNet) args.push("--unshare-net");
    args.push("--", ...command);
    return spawn(this.bwrapPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  }

  async #probe(network: "isolated" | "host"): Promise<void> {
    const args = this.#baseProbeArgs();
    if (network === "isolated") args.push("--unshare-net");
    args.push("--", "/usr/bin/true");    const result = await this.#spawn(args, network, "cleared");
    if (result.exitCode !== 0) throw new Error("containment backend failed runtime probe");
  }

  #baseProbeArgs(): string[] {
    // Probe through the same shared spine so the probe exercises the real
    // mount set (an empty environment: PATH is set inside the builder only
    // when a request carries one, so the probe binds /usr/true by absolute
    // path and needs no PATH).
    const { mountArgs } = buildBubblewrapInvocation(
      { executable: "/usr/bin/true", args: [] },
      "isolated",
    );
    return [...mountArgs];
  }

  async #spawn(
    args: readonly string[],
    network: ContainedNetworkMode,
    credentials: "cleared" | "explicit",
    timeoutMs?: number,
  ): Promise<ContainedProcessResult> {
    if (network === "mediated") throw new Error(UNSUPPORTED_UNTIL_SUPERVISOR);
    return await new Promise((resolve, reject) => {
      // W144: detached so the child leads a process group — the timeout kill
      // takes the whole group (bwrap and the contained command together);
      // --die-with-parent still applies to the normal parent-exit path.
      const child = spawn(this.bwrapPath, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        // W144 review P3: grandchildren can hold the stdio pipes past the
        // kill — destroying them lets `close` fire instead of waiting on the
        // dead group's descriptors.
        child.stdout.destroy();
        child.stderr.destroy();
      }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (error.code === "ENOENT") reject(new Error("containment backend unavailable", { cause: error }));
        else reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`contained command timed out after ${timeoutMs}ms (process group SIGKILL): ${stdout}${stderr}`));
          return;
        }
        if (stderr.startsWith("bwrap:")) {
          reject(new Error(`containment boundary could not be established: ${stderr.trim()}`));
          return;
        }
        resolve({
          exitCode,
          stdout,
          stderr,
          enforcement: "enforced",
          network: network === "host" ? "host" : "isolated",
          credentials,
        });
      });
    });
  }
}
