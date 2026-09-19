import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProposedToolAction } from "../application/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { WorkflowCodingSession, type CodingSessionDriver } from "../application/coding-session.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import type { TaskId } from "../kernel/contracts.js";
import { AcpSessionDriver } from "./acp-session.js";
import { createSessionBudgetGuard, sessionBudgetFromEnv, sessionBudgetMechanism } from "./session-budget.js";
import { globalClineEntrypoint, resolveClineLaunch } from "./cline-launch.js";
import {
  globalGooseBinary,
  gooseConfigYaml,
  gooseLaunchEnvironment,
  gooseProviderKind,
  gooseWorkspaceConfigTag,
  resolveGooseLaunch,
} from "./goose-agent-config.js";
import {
  globalOpencodeBinary,
  meteredOpencodeConfig,
  resolveOpencodeLaunch,
} from "./opencode-agent-config.js";
import type { PermissionBroker } from "../ui/permission-broker.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import { METERED_PLACEHOLDER_KEY, type ModelUsageMetrics, type ModelUsageProxy, createModelUsageProxy, meteredProviderSettings } from "./model-usage-proxy.js";
import { autoLatestConfigFromEnv } from "./openrouter-auto-latest.js";
import { loadUpstreamApiKey } from "./upstream-key.js";

export interface WorkflowAcpRuntime {
  readonly driver: AcpSessionDriver;
  readonly session: WorkflowCodingSession;
  /** Cumulative metering-proxy usage for this runtime (tokens + cost). */
  metrics?(): ModelUsageMetrics;
  /** W045: the interactive session-budget violation reason, once crossed (sticky). */
  budgetViolation?(): string | undefined;
  /** W045: which budget enforcement mechanism is active for this runtime. */
  readonly budgetMechanism: string;
  dispose(): Promise<void>;
  /** Cumulative metering-proxy metrics; absent for unmetered runtimes. */
  usage?(): ModelUsageMetrics;
}

export type AcpAgentKind = "opencode" | "cline" | "goose";

/**
 * Lead-agent selection. Since the 2026-09-16 pivot (`docs/ACP_DECISION.md`)
 * the hub's lead surface is stock-ACP OpenCode: spawn gateable at the hub,
 * hub-written config honored, session resume restoring model context, no
 * vendored patch — all probe-proven (`docs/HOST_ADAPTERS.md`). WORKFLOW_ACP_AGENT
 * selects the Cline fallback (vendored patched binary; stock Cline cannot
 * run headless) for compatibility and dogfooding, or the goose third kind
 * (W048: contained `goose acp`, enforcement classification earned by the six
 * gated probes, never configuration claims — until those probes run live,
 * goose carries no enforcement verdict).
 */
export function acpAgentKind(): AcpAgentKind {
  const raw = process.env.WORKFLOW_ACP_AGENT?.trim();
  if (raw === undefined || raw === "" || raw === "opencode") return "opencode";
  if (raw === "cline") return "cline";
  if (raw === "goose") return "goose";
  throw new Error(`WORKFLOW_ACP_AGENT must be "opencode", "cline", or "goose" (got ${JSON.stringify(raw)})`);
}

export async function createConfiguredAcpRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId | (() => TaskId),
  resumeFrom?: string,
  guard?: WorkflowGuardProvider,
  options: { readonly permissionBroker?: PermissionBroker | undefined; readonly agent?: AcpAgentKind | undefined } = {},
): Promise<WorkflowAcpRuntime> {
  const kind = options.agent ?? acpAgentKind();
  return kind === "opencode"
    ? createOpencodeRuntime(application, workspace, taskId, resumeFrom, guard, options)
    : kind === "cline"
      ? createClineRuntime(application, workspace, taskId, resumeFrom, guard, options)
      : createGooseRuntime(application, workspace, taskId, resumeFrom, guard, options);
}

/**
 * W045 (G1 budget enforcement): the session plus its interactive budget
 * guard. The guard watches the metering proxy's recorded usage on every
 * session event; crossing a configured cap cancels the in-flight turn and
 * the sticky violation refuses every later prompt through the session's
 * refusal gate. No caps configured → no guard; the OpenRouter per-key credit
 * limit on the proxy's upstream key is the recorded backstop mechanism.
 */
export function composeSessionWithBudget(driver: CodingSessionDriver, proxy: ModelUsageProxy): {
  readonly session: WorkflowCodingSession;
  readonly budgetViolation?: () => string | undefined;
  readonly budgetMechanism: string;
} {
  const budget = sessionBudgetFromEnv();
  const budgetMechanism = sessionBudgetMechanism();
  if (budget === undefined) {
    return { session: new WorkflowCodingSession(driver), budgetMechanism };
  }
  const guard = createSessionBudgetGuard({
    budget,
    usageSnapshot: () => proxy.metrics(),
    // Closures evaluated at guard-check time, after the session exists.
    cancel: () => session.cancel(),
    subscribe: (listener) => session.subscribe(listener),
  });
  const session = new WorkflowCodingSession(driver, { refusalGate: () => guard.violation() });
  guard.attach();
  return {
    session,
    budgetViolation: () => guard.violation(),
    budgetMechanism,
  };
}

async function createOpencodeRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId | (() => TaskId),
  resumeFrom: string | undefined,
  guard: WorkflowGuardProvider | undefined,
  options: { readonly permissionBroker?: PermissionBroker | undefined },
): Promise<WorkflowAcpRuntime> {
  const scratchHome = resolve(homedir(), ".workflow", "acp-home");
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });

  const apiKey = loadUpstreamApiKey();
  const upstream = process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai";
  // Hub-owned Auto Router pool (default on for OpenRouter upstreams): resolve
  // `~...-latest` aliases in the proxy so agents never need a client plugin.
  const autoLatest = autoLatestConfigFromEnv({ upstream });
  const proxy = await createModelUsageProxy({ upstream, apiKey, ...(autoLatest === undefined ? {} : { autoLatest }) });
  // Each runtime owns a private config dir: the metering proxy port is
  // ephemeral and the config points the agent at it, so runtimes must never
  // share one config (a dead proxy port would strand later agents). Unique
  // per runtime, not per process: one hub process creates a reviewer runtime
  // per auto-review, and concurrent runtimes must never clobber each other.
  pruneStaleRuntimeArtifacts(scratchHome);
  const configDir = join(scratchHome, `config.${process.pid}.${randomUUID()}`);
  try {
    mkdirSync(join(configDir, "opencode"), { recursive: true, mode: 0o700 });
    // Plan Task F1: mount the skills delivery path into the hub-owned config
    // when the operator runs a skills directory (the same dir skills-mcp and
    // the hub's pedagogy gating read: SKILLS_MCP_DIR ?? ~/.agents/skills).
    // The mount is the single delivery path the skill precondition journals
    // against; absent server or directory means no delivery to mount (levels
    // gating composes to no-ops without the dir, matching the TUI surfaces).
    const skillsMount = resolveSkillsMount();
    writeFileSync(
      join(configDir, "opencode", "opencode.json"),
      JSON.stringify(meteredOpencodeConfig({
        proxyUrl: proxy.url,
        model: process.env.WORKFLOW_OPENCODE_MODEL,
        ...(autoLatest === undefined ? {} : { autoLatest: { aliases: autoLatest.aliases } }),
        ...(skillsMount === undefined ? {} : { skills: skillsMount }),
      })),
      { encoding: "utf8", mode: 0o600 },
    );
    const opencode = resolveOpencodeLaunch({
      envBinOverride: process.env.WORKFLOW_OPENCODE_BIN,
      opencodeOnPath: globalOpencodeBinary(),
    });
    const resume = resumeFrom ?? process.env.WORKFLOW_ACP_RESUME;
    const driver = AcpSessionDriver.contained({
      containment: new LinuxBubblewrapContainment(),
      launch: {
        executable: opencode.executable,
        args: ["acp", "--pure"],
        workspace,
        home: scratchHome,
        // The delivery mount's runtime dependencies must stay readable inside
        // the boundary — the contained agent spawns the skills server, whose
        // first imports reach siblings in its dist directory (vendor/,
        // screening.js, skills.js), then packages through node_modules. pnpm's
        // layout needs BOTH levels: the app's node_modules holds the package
        // symlinks, and their targets live in the .pnpm store under the
        // toolbox-level node_modules one directory further up — binding only
        // the app level leaves every symlink dangling inside the boundary
        // (verified live: ERR_MODULE_NOT_FOUND for @modelcontextprotocol/sdk).
        // Directories are bound AS GIVEN so the relative symlinks keep
        // resolving; the skills directory is dual-bound at its realpath too,
        // mirroring the executable bind, so symlinked layouts resolve by
        // either name.
        ...(skillsMount === undefined
          ? {}
          : {
              readablePaths: [
                dirname(skillsMount.serverScript),
                resolve(dirname(skillsMount.serverScript), "..", "node_modules"),
                resolve(dirname(skillsMount.serverScript), "..", "..", "..", "node_modules"),
                skillsMount.skillsDir,
                realpathSync(skillsMount.skillsDir),
              ],
            }),
        environment: {
          // The placeholder credential rides the 0600 per-runtime config file
          // (same posture as the Cline providers.json); the real upstream key
          // stays exclusively in the hub-side proxy. `--pure` keeps the
          // operator's global plugins out of the contained agent so the
          // hub-owned config is the whole surface.
          XDG_CONFIG_HOME: configDir,
        },
      },
      authorize: options.permissionBroker === undefined
        ? application
        : (action: ProposedToolAction) =>
          options.permissionBroker!.intercept(action, (candidate) => application.authorize(candidate)),
      workspace,
      workspaceSessionId: `acp-${randomBytes(4).toString("hex")}`,
      taskId,
      ...(resume !== undefined ? { resumeFrom: resume } : {}),
      ...(guard === undefined ? {} : { guard }),
      // Plan Task F1/F3: journal skill delivery into the application's
      // precondition. A delivery with no active task cannot bind — skip it
      // rather than fail the read; the precondition only matters once a
      // task is running.
      onSkillRead: (skill) => {
        try {
          application.recordSkillRead(skill);
        } catch {
          // No active task yet: nothing to journal.
        }
      },
    });
    return {
      driver,
      ...composeSessionWithBudget(driver, proxy),
      usage: (): ModelUsageMetrics => proxy.metrics(),
      metrics: (): ModelUsageMetrics => proxy.metrics(),
      async dispose() {
        try {
          await driver.dispose();
        } finally {
          await proxy.close();
          rmSync(configDir, { recursive: true, force: true });
          console.log("metering proxy metrics:", JSON.stringify(proxy.metrics(), null, 2));
        }
      },
    };
  } catch (error) {
    // A missing agent binary (the default first-run failure), an unwritable
    // config dir, or a containment failure must not leak the proxy listener
    // or the per-runtime config dir — mirror the Cline path's cleanup.
    await proxy.close();
    rmSync(configDir, { recursive: true, force: true });
    throw error;
  }
}

async function createClineRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId | (() => TaskId),
  resumeFrom: string | undefined,
  guard: WorkflowGuardProvider | undefined,
  options: { readonly permissionBroker?: PermissionBroker | undefined },
): Promise<WorkflowAcpRuntime> {
  const scratchHome = resolve(homedir(), ".workflow", "acp-home");
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });

  const launchCline = resolveClineLaunch({
    envBinOverride: process.env.WORKFLOW_CLINE_BIN,
    clineOnPath: globalClineEntrypoint(),
  });
  const apiKey = loadUpstreamApiKey();
  const provider = process.env.CLINE_PROVIDER ?? "openrouter";
  const upstream = process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai";
  const autoLatest = autoLatestConfigFromEnv({ upstream });
  const proxy = await createModelUsageProxy({ upstream, apiKey, ...(autoLatest === undefined ? {} : { autoLatest }) });
  // Each runtime owns a private provider-settings file: the metering proxy
  // port is ephemeral, so a shared providers.json let one runtime's agent
  // end up pointed at another runtime's (possibly dead) proxy. Cline writes
  // back to the same path, which must therefore be per-runtime.
  pruneStaleRuntimeArtifacts(scratchHome);
  // Unique per runtime, not per process: one hub process creates a reviewer
  // runtime per auto-review, and concurrent runtimes must never clobber each
  // other's settings file.
  const settingsPath = join(scratchHome, `providers.${process.pid}.${randomUUID()}.json`);
  try {
    writeFileSync(settingsPath, JSON.stringify(meteredProviderSettings(proxy.url, provider)), { encoding: "utf8", mode: 0o600 });
    const model = process.env.CLINE_MODEL;
    const resume = resumeFrom ?? process.env.WORKFLOW_ACP_RESUME;
    const driver = AcpSessionDriver.contained({
      containment: new LinuxBubblewrapContainment(),
      launch: {
        executable: launchCline.executable,
        ...(launchCline.script !== undefined ? { script: launchCline.script } : {}),
        args: ["--acp", "--auto-approve", "false", ...(model ? ["--model", model] : [])],
        workspace,
        home: scratchHome,
        environment: {
          CLINE_API_KEY: METERED_PLACEHOLDER_KEY,
          CLINE_PROVIDER: provider,
          CLINE_PROVIDER_SETTINGS_PATH: settingsPath,
        },
      },
      authorize: options.permissionBroker === undefined
        ? application
        : (action: ProposedToolAction) =>
          options.permissionBroker!.intercept(action, (candidate) => application.authorize(candidate)),
      workspace,
      workspaceSessionId: `acp-${randomBytes(4).toString("hex")}`,
      taskId,
      ...(resume !== undefined ? { resumeFrom: resume } : {}),
      ...(guard === undefined ? {} : { guard }),
      onSkillRead: (skill) => {
        try {
          application.recordSkillRead(skill);
        } catch {
          // No active task yet: nothing to journal.
        }
      },
    });
    return {
      driver,
      ...composeSessionWithBudget(driver, proxy),
      usage: (): ModelUsageMetrics => proxy.metrics(),
      metrics: (): ModelUsageMetrics => proxy.metrics(),
      async dispose() {
        try {
          await driver.dispose();
        } finally {
          await proxy.close();
          rmSync(settingsPath, { force: true });
          console.log("metering proxy metrics:", JSON.stringify(proxy.metrics(), null, 2));
        }
      },
    };
  } catch (error) {
    await proxy.close();
    rmSync(settingsPath, { force: true });
    throw error;
  }
}

/** Path to the operator's OpenCode credential store, when present. */
export function opencodeAuthPath(): string {
  return resolve(homedir(), ".local", "share", "opencode", "auth.json");
}

/**
 * OpenCode over ACP, launched contained like Cline. The runtime uses the
 * hub-owned metering proxy so Auto Router settings apply without a client plugin.
 * The private scratch HOME receives only the proxy config and placeholder
 * credential, so the contained agent never sees the operator's real credentials,
 * session database, or guard plugin.
 */
export async function createConfiguredOpencodeAcpRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId,
  resumeFrom?: string,
  options: { readonly permissionBroker?: PermissionBroker | undefined } = {},
): Promise<WorkflowAcpRuntime> {
  return createOpencodeRuntime(application, workspace, taskId, resumeFrom, undefined, options);
}

/**
 * The upstream (OpenRouter) key for the hub-side metering proxy. This key
 * never enters the agent's environment or config files: the proxy holds it
 * and injects it upstream. Resolution lives in `./upstream-key.ts`:
 * `WORKFLOW_UPSTREAM_KEY` / `~/.config/workflow/upstream-key` are canonical,
 * with back-compat reads of `CLINE_API_KEY` / `~/.config/workflow/cline-api-key`.
 */

export function openrouterAuthKeyFromAuth(auth: unknown): string | undefined {
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return undefined;
  const openrouter = (auth as Record<string, unknown>).openrouter;
  if (typeof openrouter !== "object" || openrouter === null || Array.isArray(openrouter)) return undefined;
  const key = (openrouter as Record<string, unknown>).key;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
}

/**
 * W048: the goose (AAIF) runtime — the third `WORKFLOW_ACP_AGENT` kind and
 * the staged candidate for the vendored-Cline fallback slot. Structurally an
 * opencode-shaped runtime (per-runtime config root, PATH launch, bwrap +
 * AcpSessionDriver.contained, prune parity, dispose/cleanup parity) with a
 * cline-shaped credential posture (env-key auth, no keyring inside
 * containment). Everything here is PROBE-PENDING by design: the six gated
 * probes (`docs/superpowers/plans/2026-09-16-goose-qualification.md`) earn
 * the enforcement classification; goose carries no enforcement verdict
 * until they run live. The provider fork: OpenRouter composes through the
 * loopback metering proxy (placeholder-only credential inside the
 * boundary, real key proxy-side — parity with the Cline/OpenCode paths);
 * Azure AI Foundry is env-composed direct (endpoint + key env injected;
 * ambient az-CLI and Entra auth cannot survive the scratch-HOME boundary).
 */
async function createGooseRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId | (() => TaskId),
  resumeFrom: string | undefined,
  guard: WorkflowGuardProvider | undefined,
  options: { readonly permissionBroker?: PermissionBroker | undefined },
): Promise<WorkflowAcpRuntime> {
  const scratchHome = resolve(homedir(), ".workflow", "acp-home");
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });

  const provider = gooseProviderKind();
  // The `config.` prefix keeps prune parity: the stale-runtime pruner only
  // matches `providers.`/`config.` entries. W049 dogfood fix: the dir is
  // keyed by WORKSPACE (not pid+uuid) so goose's session store — which
  // lives under GOOSE_PATH_ROOT — survives restarts and cross-restart
  // resume can find the session; the ws- tag escapes the pruner by shape.
  pruneStaleRuntimeArtifacts(scratchHome);
  const configDir = join(scratchHome, `config.${gooseWorkspaceConfigTag(workspace)}`);
  // OpenRouter rides the hub-side metering proxy (the real key stays
  // proxy-side); azure_foundry runs direct with no local proxy.
  const proxy = provider === "openrouter"
    ? await createModelUsageProxy({ upstream: process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai", apiKey: loadUpstreamApiKey() })
    : undefined;
  try {
    mkdirSync(join(configDir, "config"), { recursive: true, mode: 0o700 });
    const skillsMount = resolveSkillsMount();
    const configYaml = gooseConfigYaml(skillsMount === undefined ? {} : {
      skillsServerScript: skillsMount.serverScript,
      skillsDir: skillsMount.skillsDir,
    });
    // Probe-pending: the config.yaml schema/location under GOOSE_PATH_ROOT
    // is resolved by the gated MOUNT probe (a no-mount outcome is recorded
    // as an honest negative finding, mirroring the Cline MCP-mount probe).
    if (configYaml !== undefined) {
      writeFileSync(join(configDir, "config", "config.yaml"), configYaml, { encoding: "utf8", mode: 0o600 });
    }
    const goose = resolveGooseLaunch({
      envBinOverride: process.env.WORKFLOW_GOOSE_BIN,
      gooseOnPath: globalGooseBinary(),
    });
    const resume = resumeFrom ?? process.env.WORKFLOW_ACP_RESUME;
    const driver = AcpSessionDriver.contained({
      containment: new LinuxBubblewrapContainment(),
      launch: {
        executable: goose.executable,
        args: [...goose.args],
        workspace,
        home: scratchHome,
        ...(skillsMount === undefined
          ? {}
          : {
              readablePaths: [
                dirname(skillsMount.serverScript),
                resolve(dirname(skillsMount.serverScript), "..", "node_modules"),
                resolve(dirname(skillsMount.serverScript), "..", "..", "..", "node_modules"),
                skillsMount.skillsDir,
                realpathSync(skillsMount.skillsDir),
              ],
            }),
        environment: gooseLaunchEnvironment({
          provider,
          configRoot: configDir,
          proxyUrl: proxy?.url,
          env: process.env,
        }),
      },
      authorize: options.permissionBroker === undefined
        ? application
        : (action: ProposedToolAction) =>
          options.permissionBroker!.intercept(action, (candidate) => application.authorize(candidate)),
      workspace,
      workspaceSessionId: `acp-${randomBytes(4).toString("hex")}`,
      taskId,
      ...(resume !== undefined ? { resumeFrom: resume } : {}),
      ...(guard === undefined ? {} : { guard }),
      onSkillRead: (skill) => {
        try {
          application.recordSkillRead(skill);
        } catch {
          // No active task yet: nothing to journal.
        }
      },
    });
    return {
      driver,
      ...(proxy === undefined
        ? {
            session: new WorkflowCodingSession(driver),
            // azure_foundry direct: no loopback proxy, so no locally recorded
            // usage — the provider's own spend management is the budget
            // surface, stated honestly (the OpenRouter per-key credit-limit
            // backstop is OpenRouter-only).
            budgetMechanism: "server-side: azure_foundry provider-side spend limits (no local metering proxy on the direct path); no local interactive caps",
          }
        : composeSessionWithBudget(driver, proxy)),
      ...(proxy === undefined ? {} : {
        usage: (): ModelUsageMetrics => proxy.metrics(),
        metrics: (): ModelUsageMetrics => proxy.metrics(),
      }),
      async dispose() {
        try {
          await driver.dispose();
        } finally {
          if (proxy !== undefined) {
            await proxy.close();
            console.log("goose metering proxy metrics:", JSON.stringify(proxy.metrics(), null, 2));
          }
          // W049: configDir is workspace-keyed PERSISTENT state (goose's
          // session store lives under GOOSE_PATH_ROOT) — disposing a runtime
          // must never delete it, or cross-restart resume loses the session.
          // Stale dirs of dead pids stay bounded by the pruner; ws-tagged
          // dirs are bounded by the number of workspaces ever used.
        }
      },
    };
  } catch (error) {
    if (proxy !== undefined) await proxy.close();
    // No rmSync here either: a failed launch must not destroy prior
    // sessions in the workspace-keyed store (W049 resume requirement).
    throw error;
  }
}

/**
 * Plan Task F1: resolves the skills-mcp delivery mount for the lead-agent
 * runtime. The skills directory is the operator-managed surface skills-mcp
 * and the hub's pedagogy gating both read (`SKILLS_MCP_DIR`, default
 * `~/.agents/skills`) — one config source for availability (the mount) and
 * requirements (levels.json). Absent server build or absent directory means
 * nothing to mount: no delivery path exists, and level gating composes to
 * no-ops without the directory, matching the TUI surfaces.
 */
export function resolveSkillsMount(): { readonly serverScript: string; readonly skillsDir: string } | undefined {
  return resolveSkillsMountFor({
    root: resolve(fileURLToPath(import.meta.url), "..", "..", ".."),
    envSkillsDir: process.env.SKILLS_MCP_DIR,
    home: homedir(),
  });
}

export function resolveSkillsMountFor(options: {
  readonly root: string;
  readonly envSkillsDir: string | undefined;
  readonly home: string;
  readonly exists?: (path: string) => boolean;
}): { readonly serverScript: string; readonly skillsDir: string } | undefined {
  const exists = options.exists ?? existsSync;
  const serverScript = resolve(options.root, "mcp-toolbox", "apps", "skills-mcp", "dist", "server.js");
  // Trim-to-default mirrors the hub's gating resolver (skill-gating.ts
  // resolveSkillsLevelMap): a whitespace-only override lands both sides on
  // the same default directory.
  const skillsDir = resolve(options.envSkillsDir?.trim() || join(options.home, ".agents", "skills"));
  if (!exists(serverScript) || !exists(skillsDir)) return undefined;
  return { serverScript, skillsDir };
}

/**
 * Removes per-runtime artifacts whose owning process is gone, so crashed
 * runtimes cannot leave stale configs behind. Files and directories
 * belonging to live processes (e.g. a concurrent TUI or the web service)
 * are preserved.
 */
function pruneStaleRuntimeArtifacts(scratchHome: string): void {
  for (const entry of readdirSync(scratchHome)) {
    const match = /^(?:providers|config)\.(\d+)(?:\.[0-9a-f-]+)?(?:\.json)?$/.exec(entry);
    if (match === null) {
      // The legacy shared file is obsolete and exactly what pointed agents at
      // dead proxies; remove it once encountered.
      if (entry === "providers.json") rmSync(join(scratchHome, entry), { force: true });
      continue;
    }
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch {
      rmSync(join(scratchHome, entry), { recursive: true, force: true });
    }
  }
}
