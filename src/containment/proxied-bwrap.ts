/**
 * W183: the `network: "proxied"` containment backend (NVIDIA adoption plan
 * Wave B, B1).
 *
 * Architecture (proven live, 2026-10-02):
 *
 * 1. A user-namespace holder (`unshare -Ur sleep …`) runs in the host network
 *    namespace. Its user namespace is the one joined by both the sandbox and
 *    slirp4netns — nested user namespaces (bwrap's own) cannot be joined by an
 *    unprivileged slirp, so the holder is what makes the private netns
 *    reachable from a user-mode network stack.
 * 2. The sandbox is bwrap with `--userns <holder-fd> --unshare-net
 *    --unshare-pid`. It sits in a private network namespace with only
 *    loopback.
 * 3. slirp4netns attaches to the sandbox's network namespace (joining the
 *    holder's user namespace) and provides the `10.0.2.0/24` user-mode stack.
 *    Host loopback is reachable from the sandbox as `10.0.2.2` — the same
 *    path to every host listener, not only the proxy.
 * 4. A parent-side forward proxy listens on host loopback. slirp's `10.0.2.2`
 *    mapping forwards to it, so every proxy-aware request from the sandbox
 *    reaches the proxy, which applies `decideEgress` over the request's
 *    `EgressPolicy` (deny-by-default). The sandbox's `HTTP(S)_PROXY` env vars
 *    are forced to `http://10.0.2.2:<port>`.
 * 5. bwrap's `--block-fd` gates exec until the proxy is listening and slirp
 *    has configured the interface, so the child never races a half-built
 *    network.
 *
 * Honesty boundary: this mediates **proxy-aware** traffic only, and the proxy
 * is the intended path, not the only one. A hostile process that opens a raw
 * socket, or ignores `HTTP_PROXY`, has its packets carried by slirp to the
 * host unfenced — including host-loopback listeners, because this pass does
 * not give slirp `--disable-host-loopback` (fencing it needs a
 * supervisor-owned proxy, parked as P20 / issue #444). No claim of true
 * mediation is made; `THREAT_MODEL.md` residual #1 records the raw-socket
 * residual and `network: "mediated"` remains a fail-closed stub
 * (`UNSUPPORTED_UNTIL_SUPERVISOR`).
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, openSync, readlinkSync } from "node:fs";

import type {
  ContainedProcessRequest,
  ContainedProcessResult,
} from "./contracts.js";
import { UNSUPPORTED_UNTIL_SUPERVISOR } from "./contracts.js";
import { buildBubblewrapInvocation } from "./bwrap-args.js";
import { LinuxBubblewrapContainment } from "./linux-bwrap.js";
import { createEgressForwardProxy, type EgressForwardProxy, type EgressProxyObservation } from "../integrations/egress-forward-proxy.js";
import type { EgressPolicy } from "../integrations/egress-policy.js";

/** The host-loopback address a sandbox sees slirp map the host to. */
export const SLIRP_HOST_ADDRESS = "10.0.2.2";

const HOLDER_WAIT_MS = 3_000;
const READINESS_TIMEOUT_MS = 15_000;

export interface ProxiedBubblewrapContainmentOptions {
  readonly bwrapPath?: string;
  readonly unsharePath?: string;
  readonly slirpPath?: string;
  /** Advisory sink for each proxy decision (tests/probe). */
  readonly onProxyDecision?: (observation: EgressProxyObservation) => void;
}

/** The live processes/sockets behind one proxied sandbox. */
interface SandboxHandles {
  readonly bwrap: ChildProcess;
  readonly childPid: number;
  readonly slirp: ChildProcess;
  readonly proxy: EgressForwardProxy;
  readonly holder: ChildProcess;
  readonly network: "proxied";
  cleanup(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opens the holder's user-namespace fd, polling until it has actually unshared. */
async function openUserNamespace(pid: number): Promise<number> {
  const deadline = Date.now() + HOLDER_WAIT_MS;
  const own = readlinkSync("/proc/self/ns/user");
  for (;;) {
    try {
      // The ns/user file exists from process birth, before `unshare -Ur` runs.
      // Wait until the inode differs from our own, otherwise we would open the
      // parent user namespace and bwrap would reject it as non-descendant.
      if (readlinkSync(`/proc/${pid}/ns/user`) !== own) {
        return openSync(`/proc/${pid}/ns/user`, "r");
      }
    } catch {
      // Process not visible yet; retry.
    }
    if (Date.now() >= deadline) throw new Error("proxied containment: user-namespace holder did not come up");
    await sleep(20);
  }
}

function policyFor(request: ContainedProcessRequest): EgressPolicy {
  const policy = request.proxiedEgressPolicy;
  if (policy === undefined) {
    throw new TypeError("network: \"proxied\" requires proxiedEgressPolicy (a proxied request with no policy fails closed)");
  }
  return policy;
}

function proxyEnvironment(proxy: EgressForwardProxy, environment: Readonly<Record<string, string>>): Record<string, string> {
  const url = `http://${SLIRP_HOST_ADDRESS}:${proxy.port}`;
  // Uppercase and lowercase are forced so a sandbox cannot silently inherit a
  // different proxy setting; NO_PROXY is deliberately not set (there is no
  // direct route to opt out to).
  return { ...environment, HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url };
}

/** Waits for `slirp` to write its readiness byte (fd 3). */
function awaitSlirpReady(slirp: ChildProcess): Promise<void> {
  const control = slirp.stdio as ReadonlyArray<NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined>;
  const readyStream = control[3];
  if (readyStream === null || readyStream === undefined || !("read" in readyStream)) {
    return Promise.reject(new Error("proxied containment: slirp readiness pipe was not created"));
  }
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("proxied containment: slirp did not configure the network")), READINESS_TIMEOUT_MS);
    (readyStream as NodeJS.ReadableStream).once("data", () => { clearTimeout(deadline); resolve(); });
    slirp.once("error", (error) => { clearTimeout(deadline); reject(error); });
    slirp.once("close", () => { clearTimeout(deadline); reject(new Error("proxied containment: slirp exited before configuring the network")); });
  });
}

/** Waits for bwrap to report its child pid on the info fd. */
function awaitChildPid(bwrap: ChildProcess): Promise<number> {
  const control = bwrap.stdio as ReadonlyArray<NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined>;
  const infoStream = control[4];
  if (infoStream === null || infoStream === undefined || !("read" in infoStream)) {
    return Promise.reject(new Error("proxied containment: sandbox info pipe was not created"));
  }
  let sandboxStderr = "";
  (bwrap.stderr as NodeJS.ReadableStream | null)?.on("data", (chunk: Buffer | string) => { sandboxStderr += String(chunk); });
  return new Promise<number>((resolve, reject) => {
    let buffer = "";
    const deadline = setTimeout(() => reject(new Error("proxied containment: sandbox did not report its child pid")), READINESS_TIMEOUT_MS);
    (infoStream as NodeJS.ReadableStream & { setEncoding(enc: string): void }).setEncoding("utf8");
    infoStream.on("data", (chunk: string) => {
      buffer += chunk;
      try {
        const info = JSON.parse(buffer) as { "child-pid"?: number };
        if (typeof info["child-pid"] === "number") {
          clearTimeout(deadline);
          resolve(info["child-pid"]);
        }
      } catch {
        // Partial JSON; wait for more bytes.
      }
    });
    bwrap.once("error", (error) => { clearTimeout(deadline); reject(error); });
    bwrap.once("close", () => { clearTimeout(deadline); reject(new Error(`proxied containment: sandbox exited before reporting readiness: ${sandboxStderr.trim()}`)); });
  });
}

/**
 * Starts the holder, sandbox (gated on `--block-fd`), and slirp; resolves once
 * the network is configured and releases the gate. Any failure tears down
 * every process it started and rejects — the boundary fails closed.
 */
async function startProxiedSandbox(
  request: ContainedProcessRequest,
  options: ProxiedBubblewrapContainmentOptions,
): Promise<SandboxHandles> {
  const bwrapPath = options.bwrapPath ?? "/usr/bin/bwrap";
  const unsharePath = options.unsharePath ?? "/usr/bin/unshare";
  const slirpPath = options.slirpPath ?? "/usr/bin/slirp4netns";
  const policy = policyFor(request);

  const proxy = await createEgressForwardProxy({
    policy,
    ...(options.onProxyDecision === undefined ? {} : { onDecision: options.onProxyDecision }),
  });

  let holder: ChildProcess | undefined;
  let bwrap: ChildProcess | undefined;
  let slirp: ChildProcess | undefined;
  let cleaned = false;
  const teardown = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try { slirp?.kill("SIGKILL"); } catch { /* already gone */ }
    try { bwrap?.kill("SIGKILL"); } catch { /* already gone */ }
    try { holder?.kill("SIGKILL"); } catch { /* already gone */ }
    await proxy.close().catch(() => undefined);
  };

  try {
    holder = spawn(unsharePath, ["-Ur", "sleep", "86400"], { stdio: "ignore" });
    if (holder.pid === undefined) throw new Error("proxied containment: user-namespace holder failed to spawn");
    const usernsFd = await openUserNamespace(holder.pid);

    // The proxy env must be present in the sandbox's environment, so rebuild
    // the invocation with the real proxy port before spawning.
    const env = proxyEnvironment(proxy, request.environment ?? {});
    const { mountArgs, command } = buildBubblewrapInvocation({ ...request, environment: env }, "proxied");

    const bwrapArgs: string[] = [
      ...mountArgs,
      "--userns", "3",
      "--info-fd", "4",
      "--block-fd", "5",
      "--unshare-net",
      "--", ...command,
    ];

    // stdio: 0/1/2 pipes; 3 = inherited userns fd; 4 = info pipe (read);
    // 5 = block pipe (write when ready).
    bwrap = spawn(bwrapPath, bwrapArgs, {
      stdio: ["pipe", "pipe", "pipe", usernsFd, "pipe", "pipe"],
    });
    closeSync(usernsFd);
    if (bwrap.pid === undefined) throw new Error("proxied containment: sandbox failed to spawn");

    const childPid = await awaitChildPid(bwrap);

    slirp = spawn(slirpPath, [
      "--configure",
      "--netns-type=pid",
      "--ready-fd=3",
      `--userns-path=/proc/${holder.pid}/ns/user`,
      String(childPid),
      "tap0",
    ], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    await awaitSlirpReady(slirp);

    // Release the sandbox's exec gate only after the network is configured.
    const blockControl = bwrap.stdio as ReadonlyArray<NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined>;
    const blockStream = blockControl[5];
    if (blockStream === null || blockStream === undefined || !("write" in blockStream)) throw new Error("proxied containment: sandbox block pipe was not created");
    (blockStream as NodeJS.WritableStream).end("x");

    return { bwrap, childPid, slirp, proxy, holder, network: "proxied", cleanup: teardown };
  } catch (error) {
    await teardown();
    throw error;
  }
}

/**
 * The proxied-capable Bubblewrap backend. `isolated`/`host` delegate to the
 * plain backend (one backend, no posture drift); `proxied` runs the mediated
 * path above; `mediated` fails closed.
 */
export class ProxiedBubblewrapContainment extends LinuxBubblewrapContainment {
  override readonly supportsProxiedNetwork = true;
  constructor(readonly proxiedOptions: ProxiedBubblewrapContainmentOptions = {}) {
    super(proxiedOptions.bwrapPath);
  }

  override async execute(request: ContainedProcessRequest): Promise<ContainedProcessResult> {
    const network = request.network ?? "isolated";
    if (network === "mediated") throw new Error(UNSUPPORTED_UNTIL_SUPERVISOR);
    if (network !== "proxied") return super.execute(request);
    return await this.#executeProxied(request);
  }

  override spawn(request: ContainedProcessRequest): ChildProcessWithoutNullStreams {
    const network = request.network ?? "isolated";
    if (network === "mediated") throw new Error(UNSUPPORTED_UNTIL_SUPERVISOR);
    if (network !== "proxied") return super.spawn(request);
    throw new Error("proxied network requires the async spawn path (spawnAsync)");
  }

  async spawnAsync(request: ContainedProcessRequest): Promise<ChildProcessWithoutNullStreams> {
    const network = request.network ?? "isolated";
    if (network === "mediated") throw new Error(UNSUPPORTED_UNTIL_SUPERVISOR);
    if (network !== "proxied") {
      const child = super.spawn?.(request);
      if (child === undefined) throw new TypeError("containment backend has no streaming spawn");
      return child;
    }
    const handles = await startProxiedSandbox(request, this.proxiedOptions);
    // Self-clean when the sandbox exits: the returned child is a plain bwrap
    // process, so the slirp/holder/proxy lifetime is tied to it here.
    handles.bwrap.once("close", () => { void handles.cleanup(); });
    handles.bwrap.once("error", () => { void handles.cleanup(); });
    return handles.bwrap as ChildProcessWithoutNullStreams;
  }

  async #executeProxied(request: ContainedProcessRequest): Promise<ContainedProcessResult> {
    const handles = await startProxiedSandbox(request, this.proxiedOptions);
    const { bwrap } = handles;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      try { if (bwrap.pid !== undefined) process.kill(-bwrap.pid, "SIGKILL"); } catch { bwrap.kill("SIGKILL"); }
    }, request.timeoutMs);
    try {
      return await new Promise<ContainedProcessResult>((resolve, reject) => {
        (bwrap.stdout as NodeJS.ReadableStream | null)?.on("data", (chunk: Buffer | string) => stdoutChunks.push(String(chunk)));
        (bwrap.stderr as NodeJS.ReadableStream | null)?.on("data", (chunk: Buffer | string) => stderrChunks.push(String(chunk)));
        bwrap.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") reject(new Error("containment backend unavailable", { cause: error }));
          else reject(error);
        });
        bwrap.once("close", (exitCode) => {
          if (timedOut) {
            reject(new Error(`contained command timed out after ${request.timeoutMs}ms (process group SIGKILL): ${stdoutChunks.join("")}${stderrChunks.join("")}`));
            return;
          }
          const stderr = stderrChunks.join("");
          if (stderr.startsWith("bwrap:")) {
            reject(new Error(`containment boundary could not be established: ${stderr.trim()}`));
            return;
          }
          resolve({
            exitCode,
            stdout: stdoutChunks.join(""),
            stderr,
            enforcement: "enforced",
            network: "proxied",
            credentials: Object.keys(request.environment ?? {}).length === 0 ? "cleared" : "explicit",
          });
        });
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await handles.cleanup();
    }
  }
}

