import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { launchContainedAcpAgent } from "../adapters/acp-contained-agent.js";
import type { ProcessContainment } from "../containment/contracts.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import { resolveSkillsMount } from "./acp-runtime.js";
import { createModelUsageProxy, type ModelUsageMetrics, type ModelUsageProxy } from "./model-usage-proxy.js";
import { globalOpencodeBinary, meteredOpencodeConfig, resolveOpencodeLaunch } from "./opencode-agent-config.js";
import { autoLatestConfigFromEnv } from "./openrouter-auto-latest.js";
import { loadUpstreamApiKey } from "./upstream-key.js";

/**
 * W071 — the Workflow-owned OpenCode server runtime.
 *
 * Launches `opencode serve` inside the OS containment boundary on loopback,
 * with a hub-written config: the metered provider through the loopback proxy
 * (upstream key proxy-side, placeholder-only inside the boundary), the pinned
 * `ask` ruleset, and the skills-mcp delivery mount. The server password is
 * hub-only; the client-facing gateway password is minted by the gateway.
 *
 * Fail-closed: a policy-only containment backend, a missing upstream key, or a
 * server that never becomes healthy all refuse rather than start an unguarded
 * or unmetered server.
 */

export interface OpencodeServerRuntimeOptions {
  /** Absolute workspace the server operates on. */
  readonly workspace: string;
  /** State root; defaults to `~/.workflow/opencode-server`. Injectable for tests. */
  readonly stateHome?: string | undefined;
  /** Containment backend; defaults to Linux Bubblewrap. Injectable for tests. */
  readonly containment?: ProcessContainment | undefined;
  /** Model upstream base URL; defaults to `WORKFLOW_ACP_UPSTREAM` or OpenRouter. */
  readonly upstream?: string | undefined;
  /** Metered model id; defaults to the hub OpenCode default. */
  readonly model?: string | undefined;
  /** Upstream API key; defaults to `loadUpstreamApiKey()` (throws when absent). */
  readonly apiKey?: string | undefined;
  /** Loopback port; defaults to a free port. Injectable for tests. */
  readonly port?: number | undefined;
  /** Injectable binary resolver (tests). */
  readonly resolveBinary?: (() => { readonly executable: string }) | undefined;
  /** Injectable proxy factory (tests). */
  readonly createProxy?: ((input: { upstream: string; apiKey: string }) => Promise<ModelUsageProxy>) | undefined;
  /** Injectable fetch for the health poll (tests). */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Health-poll timeout in ms (default 30s). */
  readonly healthTimeoutMs?: number | undefined;
}

export interface OpencodeServerRuntime {
  /** Loopback upstream base URL (hub-only; not published to the client). */
  readonly url: string;
  readonly username: string;
  /** Hub-only upstream credential. */
  readonly password: string;
  readonly workspace: string;
  readonly stateDir: string;
  readonly version: string | undefined;
  usage(): ModelUsageMetrics;
  dispose(): Promise<void>;
}

const DEFAULT_UPSTREAM = "https://openrouter.ai";
const DEFAULT_USERNAME = "opencode";

/** Workspace-keyed, filesystem-safe state tag (history/resume survives restarts). */
export function opencodeServerWorkspaceTag(workspace: string): string {
  return `ws-${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}`;
}

export function opencodeServerStateDir(stateHome: string, workspace: string): string {
  return join(stateHome, opencodeServerWorkspaceTag(workspace));
}

/** `opencode serve` arguments: loopback only, pinned port. */
export function opencodeServerArgs(port: number): readonly string[] {
  return ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
}

/** Extracts the bound URL from `opencode serve` stdout (`listening on http://...`). */
export function parseListeningUrl(stdout: string): string | undefined {
  const match = /listening on (https?:\/\/\S+)/.exec(stdout);
  return match?.[1];
}

export async function createOpencodeServerRuntime(
  options: OpencodeServerRuntimeOptions,
): Promise<OpencodeServerRuntime> {
  const workspace = resolve(options.workspace);
  const stateHome = options.stateHome ?? resolve(homedir(), ".workflow", "opencode-server");
  const stateDir = opencodeServerStateDir(stateHome, workspace);
  const configDir = join(stateDir, "config");
  const home = join(stateDir, "home");
  mkdirSync(join(configDir, "opencode"), { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });

  const upstream = options.upstream ?? process.env.WORKFLOW_ACP_UPSTREAM ?? DEFAULT_UPSTREAM;
  const apiKey = options.apiKey ?? loadUpstreamApiKey();
  const createProxy = options.createProxy ?? ((input: { upstream: string; apiKey: string }) => createModelUsageProxy(input));
  const proxy = await createProxy({ upstream, apiKey });
  const container = options.containment ?? new LinuxBubblewrapContainment();

  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const autoLatest = autoLatestConfigFromEnv({ upstream });
    const skillsMount = resolveSkillsMount();
    writeFileSync(
      join(configDir, "opencode", "opencode.json"),
      JSON.stringify(meteredOpencodeConfig({
        proxyUrl: proxy.url,
        model: options.model ?? process.env.WORKFLOW_OPENCODE_MODEL,
        ...(autoLatest === undefined ? {} : { autoLatest: { aliases: autoLatest.aliases } }),
        ...(skillsMount === undefined ? {} : { skills: skillsMount }),
      })),
      { encoding: "utf8", mode: 0o600 },
    );

    const resolveBinary = options.resolveBinary ?? (() => resolveOpencodeLaunch({
      envBinOverride: process.env.WORKFLOW_OPENCODE_BIN,
      opencodeOnPath: globalOpencodeBinary(),
    }));
    const opencode = resolveBinary();
    const port = options.port ?? (await freeLoopbackPort());
    const password = randomBytes(24).toString("hex");

    child = launchContainedAcpAgent(container, {
      executable: opencode.executable,
      args: opencodeServerArgs(port),
      workspace,
      home,
      ...(skillsMount === undefined
        ? {}
        : {
            readablePaths: [
              dirname(skillsMount.serverScript),
              resolve(dirname(skillsMount.serverScript), "..", "node_modules"),
              resolve(dirname(skillsMount.serverScript), "..", "..", "..", "node_modules"),
              skillsMount.skillsDir,
            ],
          }),
      environment: {
        XDG_CONFIG_HOME: configDir,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: DEFAULT_USERNAME,
        OPENCODE_TELEMETRY: "off",
      },
    });

    const { url, version } = await waitForServer({
      child,
      fallbackUrl: `http://127.0.0.1:${port}`,
      username: DEFAULT_USERNAME,
      password,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      timeoutMs: options.healthTimeoutMs ?? 30_000,
    });
    const activeChild = child;

    return {
      url,
      username: DEFAULT_USERNAME,
      password,
      workspace,
      stateDir,
      version,
      usage: (): ModelUsageMetrics => proxy.metrics(),
      async dispose() {
        try {
          await stopChild(activeChild);
        } finally {
          await proxy.close();
          // stateDir is deliberate persistent state (session history/resume);
          // like goose's workspace-keyed store it is never deleted on dispose.
        }
      },
    };
  } catch (error) {
    if (child !== undefined) await stopChild(child);
    await proxy.close();
    throw error;
  }
}

interface WaitForServerInput {
  readonly child: ChildProcessWithoutNullStreams;
  readonly fallbackUrl: string;
  readonly username: string;
  readonly password: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs: number;
}

async function waitForServer(input: WaitForServerInput): Promise<{ url: string; version: string | undefined }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let stdout = "";
  let stderr = "";
  let exited: number | null | undefined;
  input.child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  input.child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  input.child.once("exit", (code) => { exited = code; });

  const deadline = Date.now() + input.timeoutMs;
  const auth = `Basic ${Buffer.from(`${input.username}:${input.password}`).toString("base64")}`;
  while (Date.now() < deadline) {
    if (exited !== undefined) {
      throw new Error(`opencode serve exited before becoming healthy (${exited ?? "signal"}): ${stderr.trim()}`);
    }
    const baseUrl = parseListeningUrl(stdout) ?? input.fallbackUrl;
    try {
      const response = await fetchImpl(`${baseUrl}/global/health`, {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const body = await response.json() as { healthy?: unknown; version?: unknown };
        if (body.healthy === true) {
          return { url: baseUrl, version: typeof body.version === "string" ? body.version : undefined };
        }
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`opencode serve did not become healthy within ${input.timeoutMs}ms: ${stderr.trim()}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}