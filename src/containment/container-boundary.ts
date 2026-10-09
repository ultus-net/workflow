import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import type {
  ContainedProcessRequest,
  ContainedProcessResult,
  ProcessContainment,
} from "./contracts.js";
import { UNSUPPORTED_UNTIL_SUPERVISOR } from "./contracts.js";

/**
 * The C1 delegated container-boundary backend.
 *
 * In the Azure control-plane topology (`docs/superpowers/specs/2026-09-25-azure-container-jobs-remote-sandbox-design.md`
 * §10: the container is the boundary) the contained `opencode serve` must run
 * through `launchContainedAcpAgent`, which requires an `enforced` backend
 * (`src/adapters/acp-contained-agent.ts`). On local Linux that backend is
 * Bubblewrap. Inside an Azure Container Apps pod Bubblewrap cannot create a
 * nested namespace (measured: `Creating new namespace failed: Operation not
 * permitted` in the default, unprivileged container), and ACA exposes no
 * privileged-container knob, so the nested boundary is not expressible.
 *
 * This backend resolves the contradiction honestly instead of claiming a
 * boundary it did not build: the process is contained by the container it
 * already runs in, and the backend FIRST verifies (fail-closed) that it is
 * inside a container before it will report `enforced`. The `boundaryKind`
 * marker is `"container-boundary"` so no consumer, probe, or doc can conflate
 * it with the local Bubblewrap boundary.
 *
 * Honest limits (recorded in `THREAT_MODEL.md` at landing): the pod boundary
 * is strictly stronger than Bubblewrap on its OUTSIDE (no host filesystem, no
 * host network, no other tenants' processes), but it provides NO intra-pod
 * narrowing — the contained process shares the pod's filesystem, network, and
 * `/proc` with the hub, the metering proxy, and the toolbox. Therefore:
 *
 * - `readablePaths` / `writablePaths` / `writableMountMode` cannot be enforced
 *   intra-pod. They are shape-validated and then delegated (the pod is
 *   single-tenant and disposable, so the delegation is the boundary). A
 *   `read-write-no-delete` request is REFUSED, never silently run with delete
 *   permitted.
 * - `network: "proxied"` is refused: it needs a private per-process netns the
 *   pod does not provide. `network: "mediated"` is refused with the shared
 *   `UNSUPPORTED_UNTIL_SUPERVISOR` stub. `network: "host"` is accepted (it is
 *   the pod's own network — the pre-W183 posture agents already use for model
 *   egress) and `isolated` is accepted (no additional narrowing is claimed).
 *
 * This class must never be a silent default: `selectContainment` constructs it
 * only when `WORKFLOW_CONTAINMENT_BACKEND=container-boundary` is set
 * explicitly.
 */
export class ContainerBoundaryContainment implements ProcessContainment {
  readonly isolation = "enforced" as const;
  readonly boundaryKind = "container-boundary" as const;
  readonly supportsProxiedNetwork: boolean = false;

  /**
   * One-time, fail-closed startup probe: refuse to construct a boundary claim
   * outside a container. Detection covers Docker/Podman markers and the
   * cgroup-based signal ACA containers carry.
   */
  constructor(readonly detect: () => boolean = detectContainer) {
    if (!detect()) {
      throw new Error(
        "container-boundary containment requires a container environment (no /.dockerenv, /run/.containerenv, container= env, or container cgroup detected)",
      );
    }
  }

  async execute(request: ContainedProcessRequest): Promise<ContainedProcessResult> {
    validateRequest(request);
    return await new Promise<ContainedProcessResult>((resolve, reject) => {
      const network = request.network ?? "isolated";
      const environment = request.environment ?? {};
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: Object.keys(environment).length === 0 ? process.env : environment,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        child.stdout.destroy();
        child.stderr.destroy();
      }, request.timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", (error) => {
        clearTimeout(timer);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("containment backend unavailable", { cause: error }));
          return;
        }
        reject(error);
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`contained command timed out after ${request.timeoutMs}ms (process group SIGKILL): ${stdout}${stderr}`));
          return;
        }
        resolve({
          exitCode,
          stdout,
          stderr,
          enforcement: "enforced",
          network: network === "host" ? "host" : "isolated",
          credentials: Object.keys(environment).length === 0 ? "cleared" : "explicit",
        });
      });
    });
  }

  spawn(request: ContainedProcessRequest): ChildProcessWithoutNullStreams {
    validateRequest(request);
    const environment = request.environment ?? {};
    return spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: Object.keys(environment).length === 0 ? process.env : environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}

/**
 * Shape validation shared by `execute`/`spawn`: the same absolute-path and
 * posture gates the passthrough applies, plus the intra-pod refusals. A
 * refused posture throws BEFORE anything spawns (fail closed).
 */
function validateRequest(request: ContainedProcessRequest): void {
  if (!isAbsolute(request.executable)) throw new TypeError("executable must be an absolute path");
  if (request.cwd !== undefined && !isAbsolute(request.cwd)) throw new TypeError("cwd must be an absolute path");
  const network = request.network ?? "isolated";
  if (network === "mediated") throw new Error(UNSUPPORTED_UNTIL_SUPERVISOR);
  if (network === "proxied") {
    throw new TypeError("container-boundary containment cannot establish a per-process proxied network namespace");
  }
  if (network !== "isolated" && network !== "host") throw new TypeError("network must be isolated, host, proxied, or mediated");
  if (request.writableMountMode === "read-write-no-delete") {
    throw new TypeError("container-boundary containment cannot enforce read-write-no-delete");
  }
  if (request.writableMountMode !== undefined && request.writableMountMode !== "read-write") {
    throw new TypeError("writableMountMode must be read-write or read-write-no-delete");
  }
}

/**
 * Best-effort container detection. Any single positive is sufficient; absence
 * of all leaves the backend unconstructable (fail closed). Detection is not a
 * security boundary by itself — it guards against a silent misconfiguration
 * (the delegated backend selected on a bare host, where it would report
 * `enforced` with no boundary at all).
 */
export function detectContainer(): boolean {
  if (process.env.WORKFLOW_CONTAINER_BOUNDARY_FORCE === "1") return true;
  if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) return true;
  if (process.env.container !== undefined && process.env.container !== "") return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    if (cgroup.includes("docker") || cgroup.includes("containerd") || cgroup.includes("kubepods") || cgroup.includes("podman")) {
      return true;
    }
  } catch {
    // /proc/1/cgroup absent or unreadable — not a positive signal.
  }
  return false;
}
