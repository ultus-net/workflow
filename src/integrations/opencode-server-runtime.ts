import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { launchContainedAcpAgent } from "../adapters/acp-contained-agent.js";
import type { ProcessContainment } from "../containment/contracts.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import { opencodeMajorVersion, resolveSkillsMount, resolveRuntimeMeteredLane } from "./acp-runtime.js";
import { connectorReadablePaths, provisionToolboxSkill, resolveToolboxCatalog, skillConnectorMounts } from "./toolbox-catalog.js";
import { createModelUsageProxy, METERED_PLACEHOLDER_KEY, syntheticFailoverProxyOptions, type AutoLatestProxyOptions, type EgressDenialEvent, type EgressObservation, type ModelUsageMetrics, type ModelUsageProxy, type ProxyPayloadPolicy, type SyntheticFailoverProxyOptions } from "./model-usage-proxy.js";
import type { CredentialEndpoint } from "./credentials.js";
import { globalOpencodeBinary, meteredOpencodeConfig, OPENCODE_V2_METERED_ENV_KEY, resolveOpencodeLaunch } from "./opencode-agent-config.js";
import { installFleetIntoOpencodeConfig, type FleetInstallResult } from "./fleet-payload.js";
import { probeOpencodeHealth } from "./opencode-health.js";
import { autoLatestConfigFromEnv } from "./openrouter-auto-latest.js";
import { budgetDowngradeFromEnv, sessionBudgetFromEnv, type BudgetDowngradeRuntime } from "./session-budget.js";
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

/**
 * The proxy composition seam for the server runtime: the upstream/key plus the
 * hub-owned policy options. Named once so the runtime call site and the
 * injectable factory (tests) cannot drift apart.
 *
 * W118/P15(a): `budgetDowngrade` carries the env-parsed downgrade axes + the
 * budget the warn tier evaluates against; `autoLatest` is the Auto Router seam
 * that lets an active downgrade NARROW the injected `allowed_models` instead of
 * rewriting the model off the router. Both are absent when unconfigured, which
 * leaves the proxy's pass-through posture exactly as before.
 */
export interface OpencodeServerProxyInput {
  readonly upstream: string;
  readonly apiKey: string;
  readonly autoLatest?: AutoLatestProxyOptions | undefined;
  readonly budgetDowngrade?: BudgetDowngradeRuntime | undefined;
  /** W184: gate-2 credential binding (W179); absent leaves gate 2 inactive. */
  readonly credentialEndpoints?: readonly CredentialEndpoint[] | undefined;
  /** W184: W180 path/function policy tier + size ceiling; absent is dark. */
  readonly payloadPolicy?: ProxyPayloadPolicy | undefined;
  /** W184: W181 egress observation sink; absent observes nothing. */
  readonly onEgressObservation?: ((observation: EgressObservation) => void) | undefined;
  /** W184: W182 shared egress-denial sink; absent observes nothing. */
  readonly onEgressDenied?: ((event: EgressDenialEvent) => void) | undefined;
  /** Synthetic→OpenRouter failover composition; absent leaves the lane single-upstream. */
  readonly syntheticFailover?: SyntheticFailoverProxyOptions | undefined;
}

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
  /**
   * W082 (config-side auto-compaction trigger): when true, the hub-written
   * server config composes `compaction: { auto: true }` so sessions driven
   * through this topology get the same deterministic maintenance the ACP
   * lane composes from the settings preference. The CLI resolves it from the
   * operator's `agents.opencode.autoCompact` setting (default off).
   */
  readonly autoCompact?: boolean | undefined;
  /**
   * W080 (the operator-disable precedence on this lane): connector names the
   * operator explicitly disabled in settings — the declaration never mounts
   * them here either. The CLI resolves the names from the settings doc.
   */
  readonly skillConnectorsDisabled?: readonly string[] | undefined;
  /** Upstream API key; defaults to `loadUpstreamApiKey()` (throws when absent). */
  readonly apiKey?: string | undefined;
  /** Loopback port; defaults to a free port. Injectable for tests. */
  readonly port?: number | undefined;
  /** Injectable binary resolver (tests). */
  readonly resolveBinary?: (() => { readonly executable: string }) | undefined;
  /** Injectable proxy factory (tests). */
  readonly createProxy?: ((input: OpencodeServerProxyInput) => Promise<ModelUsageProxy>) | undefined;
  /**
   * Injectable fleet-install seam (tests). Defaults to {@link installVendoredFleet},
   * which deploys the vendored agents/commands into the hub-owned config dir.
   */
  readonly installFleetImpl?: ((configDir: string) => readonly FleetInstallResult[]) | undefined;
  /** W184: gate-2 credential binding (W179) threaded into the proxy; absent leaves gate 2 inactive. */
  readonly credentialEndpoints?: readonly CredentialEndpoint[] | undefined;
  /**
   * W184: the W180 path/function policy tier + payload size ceiling. Absent
   * (the default) leaves the proxy byte-identical; present activates the
   * deny-by-default tier for this lane.
   */
  readonly payloadPolicy?: ProxyPayloadPolicy | undefined;
  /** W184: W181 egress observation sink for this lane; absent observes nothing. */
  readonly onEgressObservation?: ((observation: EgressObservation) => void) | undefined;
  /** W184: W182 shared egress-denial sink for this lane; absent observes nothing. */
  readonly onEgressDenied?: ((event: EgressDenialEvent) => void) | undefined;
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

/**
 * The contained `opencode serve` launch environment.
 *
 * v1 keeps the placeholder credential inside the 0600 config file (the metered
 * custom provider's `options.apiKey`); v2's built-in `openrouter` provider is
 * credential-activated, so the placeholder rides this env var instead — still
 * placeholder-only, the real upstream key stays exclusively in the hub-side
 * proxy. The bwrap backend launches with a cleared environment, so neither an
 * ambient key nor any other host env leaks into the boundary.
 */
export function opencodeServerLaunchEnvironment(input: {
  readonly configDir: string;
  readonly password: string;
  readonly opencodeMajor?: number | undefined;
}): Record<string, string> {
  return {
    XDG_CONFIG_HOME: input.configDir,
    OPENCODE_SERVER_PASSWORD: input.password,
    OPENCODE_SERVER_USERNAME: DEFAULT_USERNAME,
    OPENCODE_TELEMETRY: "off",
    ...(input.opencodeMajor !== undefined && input.opencodeMajor >= 2
      ? { [OPENCODE_V2_METERED_ENV_KEY]: METERED_PLACEHOLDER_KEY }
      : {}),
  };
}

/** Extracts the bound URL from `opencode serve` stdout (`listening on http://...`). */
export function parseListeningUrl(stdout: string): string | undefined {
  const match = /listening on (https?:\/\/\S+)/.exec(stdout);
  return match?.[1];
}

/**
 * Deploys the vendored OpenCode fleet (agents + slash commands) into the
 * hub-owned config dir at runtime, so the plane's `opencode serve` — which runs
 * under the isolated `XDG_CONFIG_HOME=<stateDir>/config` (never the operator's
 * `~/.config/opencode`) — actually loads them.
 *
 * Root cause this closes (measured 2026-10-10): the fleet is vendored under
 * `assets/opencode-fleet/` and installed by the operator-invoked `workflow
 * install fleet` into `~/.config/opencode/{agents,commands}`, but the plane
 * writes only `opencode.json` into `<stateDir>/config/opencode/` and never
 * installs the fleet there. OpenCode scans `{agent,agents}` and
 * `{command,commands}` under `$XDG_CONFIG_HOME/opencode` (ConfigPaths
 * `Global.Path.config = xdgConfig/opencode`), so with the fleet absent the
 * plane advertised only stock agents (`/api/agent`) and commands
 * (`/api/command`). Installing the payload at launch restores the custom
 * config the operator depends on.
 *
 * Only the agent/command kinds install here: the docs bundle is a repo-owned
 * living set under the WORKSPACE (`<workspace>/docs/agents`), never written
 * into the config dir. `force` is deliberately true — the config dir is
 * hub-owned and regenerated per workspace, so a stale/mismatched copy from an
 * earlier plane revision is overwritten rather than skipped (the installer's
 * refuse-to-clobber protects operator edits on the host, which do not exist
 * here). Fail-closed: a malformed manifest throws and refuses the runtime.
 */
export function installVendoredFleet(configDir: string): readonly FleetInstallResult[] {
  return installFleetIntoOpencodeConfig(configDir);
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

  const apiKey = options.apiKey ?? loadUpstreamApiKey();
  // Operator pivot: Synthetic is the primary metered upstream with an
  // automatic OpenRouter failover on rate-limit/5xx/connection failure, when
  // a Synthetic key is resolvable; else OpenRouter single-upstream (unchanged).
  // An explicit `options.upstream` or `WORKFLOW_ACP_UPSTREAM` always wins.
  const lane = resolveRuntimeMeteredLane(apiKey, options.upstream ?? process.env.WORKFLOW_ACP_UPSTREAM);
  const meteredUpstream = lane.upstream;
  // W118 (the W095 budget-downgrade consumer) + P15(a) wiring breadth: the
  // server-runtime proxy composes the SAME axes the ACP lane composes
  // (`createOpencodeRuntime`): the downgrade additionally requires budget caps
  // to exist (no caps = nothing to warn about); absent either leaves the proxy
  // without a downgrade (the pass-through default). The malformed-axis posture
  // fails CLOSED to undefined (the W122 parse), never to an unenforced or
  // partially-applied downgrade.
  const budgetDowngradeConfig = budgetDowngradeFromEnv();
  const sessionBudget = sessionBudgetFromEnv();
  const budgetDowngrade = budgetDowngradeConfig !== undefined && sessionBudget !== undefined
    ? { ...budgetDowngradeConfig, budget: sessionBudget }
    : undefined;
  // P15 part (a): the autoLatest seam is parsed ONCE and now feeds BOTH the
  // config-side alias catalog (the model picker, below) and the proxy-side
  // injection/narrowing seam. With the seam composed, an active downgrade on an
  // auto-router request narrows the injected `allowed_models` to the target
  // (narrow-before-inject, resolver-independent) instead of switching the
  // session off the router; a concrete-model request keeps the W118 rewrite.
  const autoLatest = autoLatestConfigFromEnv({ upstream: meteredUpstream });
  const defaultCreateProxy = (input: OpencodeServerProxyInput): Promise<ModelUsageProxy> => createModelUsageProxy(input);
  const createProxy = options.createProxy ?? defaultCreateProxy;
  const proxy = await createProxy({
    upstream: meteredUpstream,
    apiKey: lane.apiKey,
    ...(autoLatest === undefined ? {} : { autoLatest }),
    ...(budgetDowngrade === undefined ? {} : { budgetDowngrade }),
    // W184: thread the egress seams the ACP lanes already carry. Each is absent
    // by default, so an unconfigured server topology stays byte-identical.
    ...(options.credentialEndpoints === undefined ? {} : { credentialEndpoints: options.credentialEndpoints }),
    ...(options.payloadPolicy === undefined ? {} : { payloadPolicy: options.payloadPolicy }),
    ...(options.onEgressObservation === undefined ? {} : { onEgressObservation: options.onEgressObservation }),
    ...(options.onEgressDenied === undefined ? {} : { onEgressDenied: options.onEgressDenied }),
    ...(lane.failover === undefined ? {} : { syntheticFailover: syntheticFailoverProxyOptions(lane.failover) }),
  });
  const container = options.containment ?? new LinuxBubblewrapContainment();

  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const skillsMount = resolveSkillsMount();
    // W080 mount half: provision the workflow-toolbox skill into the hub-owned
    // delivery store and compose the declared-connector mounts (the daemon has
    // no operator settings doc; the declaration's built filter applies, and
    // the delivery mount dedupes skills-mcp). Best-effort orientation: a
    // failed provisioning degrades to no delivery, never a failed daemon.
    let skillConnectors: readonly { readonly name: string; readonly serverPath: string }[] = [];
    if (skillsMount !== undefined) {
      try {
        const catalog = resolveToolboxCatalog();
        provisionToolboxSkill(skillsMount.skillsDir, catalog);
        skillConnectors = skillConnectorMounts(catalog, {
          ...(options.skillConnectorsDisabled === undefined ? {} : { disabled: options.skillConnectorsDisabled }),
          alreadyMounted: ["skills-mcp"],
        });
      } catch (error) {
        console.error(`workflow-toolbox skill delivery failed for the topology (continuing without it): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Resolve the binary and its major version BEFORE writing the config, so
    // the written provider shape matches the binary that will read it. v1 keeps
    // the historical `provider`/`npm`/`options` shape byte-for-byte; v2 emits
    // the `providers`/`package`/`settings` shape reusing the built-in
    // `openrouter` provider (see opencode-agent-config.ts). On the server/HTTP
    // lane the config `model` IS honored for `POST /api/session` on v2.0.10
    // (live-verified; unlike the ACP session default), so the v2-shaped config
    // `model` is the metered pin for this lane — no separate session pin is
    // needed. Verified against `opencode serve --help` on v2.0.10: the
    // `--hostname`/`--port` flags in `opencodeServerArgs` remain valid.
    const resolveBinary = options.resolveBinary ?? (() => resolveOpencodeLaunch({
      envBinOverride: process.env.WORKFLOW_OPENCODE_BIN,
      opencodeOnPath: globalOpencodeBinary(),
    }));
    const opencode = resolveBinary();
    const opencodeMajor = await opencodeMajorVersion(opencode.executable);
    writeFileSync(
      join(configDir, "opencode", "opencode.json"),
      JSON.stringify(meteredOpencodeConfig({
        proxyUrl: proxy.url,
        model: options.model ?? process.env.WORKFLOW_OPENCODE_MODEL,
        opencodeMajor,
        // W082: the daemon carries the same config-side auto-compaction
        // trigger the ACP lane composes (settings `agents.opencode.autoCompact`).
        ...(options.autoCompact === true ? { autoCompact: true } : {}),
        ...(autoLatest === undefined ? {} : { autoLatest: { aliases: autoLatest.aliases } }),
        ...(skillsMount === undefined ? {} : { skills: skillsMount }),
        ...(skillConnectors.length === 0 ? {} : { skillConnectors }),
      })),
      { encoding: "utf8", mode: 0o600 },
    );
    // Deploy the vendored fleet into the hub-owned config dir so the contained
    // `opencode serve` loads the custom agents/commands (root-cause fix,
    // 2026-10-10: the config dir is isolated from the operator's
    // `~/.config/opencode`, so nothing else installs them). Fail-closed: a
    // malformed manifest throws and refuses the runtime.
    const fleetInstall = options.installFleetImpl ?? installVendoredFleet;
    const fleetResults = fleetInstall(configDir);
    const fleetInstalled = fleetResults.filter((result) => result.action === "written" || result.action === "forced").length;
    console.log(`[fleet] installed ${fleetInstalled} vendored agent/command file(s) into ${join(configDir, "opencode")}`);

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
              // W080: the declared connectors' stdio entrypoints need the
              // same two-level pnpm binds (dist + app node_modules +
              // toolbox node_modules) or the server's spawned MCP child
              // dies with ERR_MODULE_NOT_FOUND inside the boundary.
              ...connectorReadablePaths(skillConnectors.map((mount) => mount.serverPath)),
            ],
          }),
      environment: opencodeServerLaunchEnvironment({ configDir, password, opencodeMajor }),
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
    // The launch probe walks both health contracts (see opencode-health.ts):
    // v1.x answers /global/health with JSON { healthy: true }; v2.x serves the
    // web UI as an SPA fallback on every bare path — /global/health returns
    // HTML — and /api/info answers the { version, ... } JSON that is the
    // health signal.
    const healthy = await probeOpencodeHealth(fetchImpl, baseUrl, auth);
    if (healthy !== undefined) {
      return { url: baseUrl, version: healthy.version };
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