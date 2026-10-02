import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProposedToolAction } from "../application/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { WorkflowCodingSession, type CodingSessionDriver } from "../application/coding-session.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import type { TaskId } from "../kernel/contracts.js";
import { AcpSessionDriver } from "./acp-session.js";
import type { RunBudget } from "./hub-scheduler.js";
import { budgetDowngradeFromEnv, createSessionBudgetGuard, describeBudgetMechanism, mergeSessionBudget, sessionBudgetFromEnv } from "./session-budget.js";
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
  OPENCODE_V2_METERED_ENV_KEY,
  OPENCODE_V2_VENDOR_BUILTINS,
  resolveOpencodeLaunch,
  v2BuiltinModelRef,
} from "./opencode-agent-config.js";
import type { PermissionBroker } from "../ui/permission-broker.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import { METERED_PLACEHOLDER_KEY, type EgressDenialEvent, type ModelUsageMetrics, type ModelUsageProxy, type ProxyPayloadPolicy, createModelUsageProxy, meteredProviderSettings } from "./model-usage-proxy.js";
import type { CredentialEndpoint } from "./credentials.js";
import { createEgressRuntimeFeed } from "./egress-audit-client.js";
import { egressPostureFromEnv, egressRuntimeContext } from "./runtime-context.js";
import type { TaskUsageSummary } from "./task-usage.js";
import { autoLatestConfigFromEnv } from "./openrouter-auto-latest.js";
import { loadOpenModelKeys } from "./open-model-keys.js";
import { createOpenModelMeteringPool, type OpenModelMeteringPool } from "./open-model-proxy.js";
import { findOpenModel, openSourcePoolFromEnv } from "./open-source-pool.js";
import { DEFAULT_OPENCODE_MODEL, OPENCODE_METERED_PROVIDER_ID, type MeteredVendorProvider } from "./opencode-agent-config.js";
import { loadUpstreamApiKey } from "./upstream-key.js";
import { enabledMcpServers, type WorkflowSettings } from "./workflow-settings.js";
import { connectorReadablePaths, provisionToolboxSkill, resolveToolboxCatalog, skillConnectorMounts } from "./toolbox-catalog.js";

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

/** Parse "opencode v2.0.10" / "1.18.31" style `--version` output into a major. */
export function parseOpencodeMajorVersion(versionOutput: string): number | undefined {
  const match = /v?(\d+)\.\d+\.\d+/.exec(versionOutput);
  if (match === null || match[1] === undefined) return undefined;
  const major = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(major) ? major : undefined;
}

/**
 * The 1.x `acp --pure` flag kept the operator's global plugins out of the
 * contained agent. opencode v2 removed the flag and instead prints its CLI
 * help page to stdout when given an unknown flag — the first line is a bare
 * `DESCRIPTION`, which the ACP NDJSON decoder correctly rejects, so every
 * hub-composed turn died at spawn before any model call (verified live,
 * 2026-09-26: standalone `acp` framing is clean on v2.0.10; only `--pure`
 * dumps help). v2+ and unknown versions (assumed modern) drop the flag:
 * per-runtime config isolation is carried by `HOME`/`XDG_CONFIG_HOME`
 * regardless, so the hub-owned config remains the agent's whole surface.
 */
export function opencodeAcpArgs(majorVersion: number | undefined): readonly string[] {
  return majorVersion !== undefined && majorVersion < 2 ? ["acp", "--pure"] : ["acp"];
}

const opencodeMajorCache = new Map<string, Promise<number | undefined>>();

/** Probe the opencode binary's major version once per executable path. */
export function opencodeMajorVersion(executable: string): Promise<number | undefined> {
  const cached = opencodeMajorCache.get(executable);
  if (cached !== undefined) return cached;
  const probe = new Promise<number | undefined>((resolveProbe) => {
    execFile(executable, ["--version"], { timeout: 10_000, encoding: "utf8" }, (error, stdout) => {
      // execFile signals success with error === null (never undefined) —
      // testing undefined here made the probe always resolve undefined and
      // silently drop --pure on v1 (review P1, 2026-09-26).
      resolveProbe(parseOpencodeMajorVersion(error === null ? String(stdout) : ""));
    });
  });
  opencodeMajorCache.set(executable, probe);
  return probe;
}

export interface AcpRuntimeOptions {
  readonly permissionBroker?: PermissionBroker | undefined;
  readonly agent?: AcpAgentKind | undefined;
  /** Canonical Workflow settings projected into the agent's launch config. */
  readonly settings?: WorkflowSettings | undefined;
  /**
   * W151: a session's operator-raised budget caps (persisted per session
   * record, applied on every spawn of that session). Merged per-axis over the
   * env budget; only the env's axes and the override's axes exist — nothing
   * is invented. The azure-foundry direct path records no local usage, so a
   * local guard over it would never fire; there the override is honestly
   * inert (the mechanism string still describes the effective caps).
   */
  readonly budgetOverride?: RunBudget | undefined;
  /**
   * W111 (issue #283): the per-task attribution sink for this runtime's ACP
   * driver. When provided, each `start()` turn publishes its boundary delta
   * through it (completed only). Absent → no driver-side attribution; the hub
   * scheduler lane wires the same mechanism in `runTurn`'s finally instead, so
   * it deliberately passes no sink here (no double count).
   */
  readonly taskUsage?: {
    readonly usage: () => ModelUsageMetrics | undefined;
    readonly record: (delta: Omit<TaskUsageSummary, "recordedAt">) => void;
  } | undefined;
  /**
   * W182 (A7): the shared proxy egress-denial sink. When provided, every proxy
   * the cline, opencode, and goose OpenRouter lanes compose emits one value-free
   * denial event through it, so the hub's durable egress policy revision store
   * can park the denial for operator visibility. The goose azure_foundry lane
   * composes no local proxy, so it carries no seam. As of W184 the W180
   * path/function policy tier routes through this same sink, so its approvable
   * `egress_policy` `no_matching_rule` denial parks end-to-end. Absent leaves
   * the proxies' refusal posture byte-identical. Observation only at the proxy
   * seam; the sink cannot block or rewrite a request.
   */
  readonly onEgressDenied?: ((event: EgressDenialEvent) => void) | undefined;
  /**
   * W184: the W180 path/function policy tier + size ceiling, threaded into
   * every proxy this runtime composes (opencode/cline/goose OpenRouter lanes +
   * the open-source pool). Absent (the default) leaves every lane dark; the hub
   * composes it FRESH per turn so a merged revision is consulted immediately.
   */
  readonly payloadPolicy?: ProxyPayloadPolicy | undefined;
  /**
   * W184: the W179 gate-2 credential-endpoint binding, threaded into every proxy
   * this runtime composes. Empty/absent (the default) leaves gate 2 inactive.
   */
  readonly credentialEndpoints?: readonly CredentialEndpoint[] | undefined;
}

export async function createConfiguredAcpRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId | (() => TaskId),
  resumeFrom?: string,
  guard?: WorkflowGuardProvider,
  options: AcpRuntimeOptions = {},
): Promise<WorkflowAcpRuntime> {
  const kind = options.agent ?? acpAgentKind();
  return kind === "opencode"
    ? createOpencodeRuntime(application, workspace, taskId, resumeFrom, guard, options)
    : kind === "cline"
      ? createClineRuntime(application, workspace, taskId, resumeFrom, guard, options)
      : createGooseRuntime(application, workspace, taskId, resumeFrom, guard, options);
}

/** W119: the abort tier must see every lane — the guard's usage snapshot
 * aggregates the OpenRouter proxy's metrics with the open-source pool's
 * (field-wise; latestPromptTokens stays the primary lane's). Absent
 * additional usage leaves the snapshot exactly as before (the pre-W119
 * callers are unchanged). */
function aggregateUsage(a: ModelUsageMetrics, b: ModelUsageMetrics | undefined): ModelUsageMetrics {
  if (b === undefined) return a;
  return {
    requests: a.requests + b.requests,
    usageEvents: a.usageEvents + b.usageEvents,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
    latestPromptTokens: a.latestPromptTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreateTokens: a.cacheCreateTokens + b.cacheCreateTokens,
  };
}

/**
 * W045 (G1 budget enforcement): the session plus its interactive budget
 * guard. The guard watches the metering proxy's recorded usage on every
 * session event; crossing a configured cap cancels the in-flight turn and
 * the sticky violation refuses every later prompt through the session's
 * refusal gate. No caps configured → no guard; the OpenRouter per-key credit
 * limit on the proxy's upstream key is the recorded backstop mechanism.
 * W119: the usage snapshot aggregates the open-source pool's metrics with the
 * OpenRouter proxy's when wired (one budget sees all lanes — the abort tier
 * and the W118 warn tier cover the same usage; the per-family granularity
 * residual is the pool's own metrics() aggregate). The cline/goose runtime
 * flavors have no open lane (the OpenRouter proxy is their only lane, so
 * their snapshot is complete by construction); the azure direct path
 * records no local usage at all (the provider's own spend management — the
 * pre-existing honest statement). Latest prompt tokens stay the primary
 * lane's (display-only: no cap reads them).
 */
export function composeSessionWithBudget(driver: CodingSessionDriver, proxy: ModelUsageProxy, additionalUsage?: () => ModelUsageMetrics | undefined, budgetOverride?: RunBudget | undefined): {
  readonly session: WorkflowCodingSession;
  readonly budgetViolation?: () => string | undefined;
  readonly budgetMechanism: string;
} {
  const budget = mergeSessionBudget(sessionBudgetFromEnv(), budgetOverride);
  const budgetMechanism = describeBudgetMechanism(budget);
  if (budget === undefined) {
    return { session: new WorkflowCodingSession(driver), budgetMechanism };
  }
  const guard = createSessionBudgetGuard({
    budget,
    usageSnapshot: () => aggregateUsage(proxy.metrics(), additionalUsage?.()),
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
  options: AcpRuntimeOptions,
): Promise<WorkflowAcpRuntime> {
  const scratchHome = resolve(homedir(), ".workflow", "acp-home");
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });

  const apiKey = loadOpencodeUpstreamApiKey();
  const upstream = process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai";
  // Hub-owned Auto Router pool (default on for OpenRouter upstreams): resolve
  // `~...-latest` aliases in the proxy so agents never need a client plugin.
  const autoLatest = autoLatestConfigFromEnv({ upstream });
  // W118: the downgrade axes are parsed once from the env; the downgrade
  // additionally requires budget caps to exist (no caps = nothing to warn
  // about). Absent either leaves the lanes without a downgrade (the
  // pass-through default).
  const budgetDowngradeConfig = budgetDowngradeFromEnv();
  const sessionBudget = sessionBudgetFromEnv();
  const budgetDowngrade = budgetDowngradeConfig !== undefined && sessionBudget !== undefined
    ? { ...budgetDowngradeConfig, budget: sessionBudget }
    : undefined;
  // P15 part (a): the OpenRouter lane composes the downgrade too — on the
  // Auto Router lane the proxy's narrowing variant carries it; the open pool
  // below keeps the W118 body-rewrite lane. The Cline/goose runtime sites
  // stay unwired (the W118 wiring breadth remains queued).
  // W181 (A5): the egress observation feed rides the same proxy. Env-gated
  // (WORKFLOW_EGRESS_AUDIT_FEED=1) and absent when the vendored ledger build
  // is missing, so the default composition is unchanged.
  const runtimeRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  const egressFeed = await createEgressRuntimeFeed({ root: runtimeRoot });
  let proxy: ModelUsageProxy;
  try {
    proxy = await createModelUsageProxy({
      upstream,
      apiKey,
      ...(autoLatest === undefined ? {} : { autoLatest }),
      ...(budgetDowngrade === undefined ? {} : { budgetDowngrade }),
      ...(egressFeed === undefined ? {} : { onEgressObservation: egressFeed.onEgressObservation }),
      ...(options.onEgressDenied === undefined ? {} : { onEgressDenied: options.onEgressDenied }),
      ...(options.payloadPolicy === undefined ? {} : { payloadPolicy: options.payloadPolicy }),
      ...(options.credentialEndpoints === undefined ? {} : { credentialEndpoints: options.credentialEndpoints }),
    });
  } catch (error) {
    // A construction failure must not leak the already-opened ledger client.
    await egressFeed?.close();
    throw error;
  }
  // W070a: compose the open-source vendors through their own loopback proxies
  // when their keys are present. With no vendor keys the pool stays empty and
  // the agent keeps the existing OpenRouter/Auto-Router surface unchanged
  // (the closed-model operator override path is untouched).
  const openKeys = loadOpenModelKeys();
  let openPool: OpenModelMeteringPool | undefined;
  try {
    openPool = Object.keys(openKeys.keys).length > 0
      ? await createOpenModelMeteringPool({ pool: openSourcePoolFromEnv(), keys: openKeys.keys, ...(budgetDowngrade === undefined ? {} : { budgetDowngrade }), ...(egressFeed === undefined ? {} : { onEgressObservation: egressFeed.onEgressObservation }), ...(options.onEgressDenied === undefined ? {} : { onEgressDenied: options.onEgressDenied }), ...(options.payloadPolicy === undefined ? {} : { payloadPolicy: options.payloadPolicy }) })
      : undefined;
  } catch (error) {
    // A misconfigured pool (unknown WORKFLOW_OPEN_MODEL_POOL id) must not leak
    // the already-started OpenRouter proxy listener or the ledger client.
    await proxy.close();
    await egressFeed?.close();
    throw error;
  }
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
    // W080 mount half: provision the generated workflow-toolbox skill into the
    // hub-owned delivery store, then compute the declared-connector mounts.
    // Provisioning is best-effort orientation (advisory, never enforcement): a
    // failed write degrades to no delivery with a visible log, never a failed
    // session. Operator-disabled connectors never mount from the declaration.
    let skillConnectors: readonly { readonly name: string; readonly serverPath: string }[] = [];
    if (skillsMount !== undefined) {
      try {
        const catalog = resolveToolboxCatalog();
        provisionToolboxSkill(skillsMount.skillsDir, catalog);
        const disabled = (options.settings?.mcpServers ?? [])
          .filter((server) => server.enabled === false)
          .map((server) => server.name);
        const operatorMounted = (options.settings?.mcpServers ?? [])
          .filter((server) => server.enabled)
          .map((server) => server.name);
        skillConnectors = skillConnectorMounts(catalog, {
          disabled,
          alreadyMounted: ["skills-mcp", ...operatorMounted],
        });
      } catch (error) {
        console.error(`workflow-toolbox skill delivery failed (continuing without it): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // W181 (A6): the posture-gated runtime-context instruction. The posture is
    // read from the environment NOW (the W178 policy engine / W180 reject tier
    // do not exist at this revision), so production stays `absent` and nothing
    // is written. When an enforcing posture is declared, the guidance is
    // written into the hub-owned config dir and referenced from the config.
    const egressGuidance = egressRuntimeContext(egressPostureFromEnv());
    let egressGuidancePath: string | undefined;
    if (egressGuidance !== undefined) {
      egressGuidancePath = join(configDir, "opencode", "egress-runtime-context.md");
      writeFileSync(egressGuidancePath, egressGuidance, { encoding: "utf8", mode: 0o600 });
    }
    const openSelection = openPool === undefined ? undefined : openSourceConfig(openPool);
    // An operator override that names a live open-source pool model is handled
    // by the open-source provider itself (defaultModel); any other override
    // (including a closed model) keeps riding the legacy provider unchanged.
    const envModel = process.env.WORKFLOW_OPENCODE_MODEL?.trim();
    const envModelDef = envModel === undefined || envModel === "" ? undefined : findOpenModel(envModel);
    const envModelProvider = envModelDef === undefined || openPool === undefined ? undefined : openPool.byFamily.get(envModelDef.family);
    const configModel =
      envModel !== undefined && envModel !== "" && envModelProvider !== undefined && envModelProvider.models.includes(envModel)
        ? undefined
        : process.env.WORKFLOW_OPENCODE_MODEL;
    const opencode = resolveOpencodeLaunch({
      envBinOverride: process.env.WORKFLOW_OPENCODE_BIN,
      opencodeOnPath: globalOpencodeBinary(),
    });
    // Version-aware composition: v1 keeps the historical provider shape and
    // `--pure`; v2 emits the v2 `providers` shape, reuses the built-in
    // `openrouter` provider for the metered route, and drops `--pure`.
    const acpMajor = await opencodeMajorVersion(opencode.executable);
    // v2 open-source vendor activation: like the built-in `openrouter` lane,
    // each vendor built-in is credential-activated, so the placeholder rides
    // the vendor's env key (OPENCODE_V2_VENDOR_BUILTINS) — still placeholder-
    // only, the real vendor key stays proxy-side. v1 keeps the placeholder in
    // the 0600 config file and composes none of this.
    const v2VendorEnv: Record<string, string> = {};
    if (acpMajor !== undefined && acpMajor >= 2 && openPool !== undefined) {
      for (const family of openPool.byFamily.keys()) {
        const builtin = OPENCODE_V2_VENDOR_BUILTINS[family];
        if (builtin !== undefined) v2VendorEnv[builtin.envKey] = METERED_PLACEHOLDER_KEY;
      }
    }
    const opencodeConfig = meteredOpencodeConfig({
      proxyUrl: proxy.url,
      model: configModel ?? options.settings?.agents.opencode?.model,
      opencodeMajor: acpMajor,
      // W082: the operator's autoCompact preference composes the
      // `compaction: { auto: true }` block into the hub-written config —
      // the config-side auto-compaction trigger (default off).
      ...(options.settings?.agents.opencode?.autoCompact === true ? { autoCompact: true } : {}),
      ...(autoLatest === undefined ? {} : { autoLatest: { aliases: autoLatest.aliases } }),
      ...(openSelection === undefined ? {} : { openSource: openSelection }),
      ...(skillsMount === undefined ? {} : { skills: skillsMount }),
      ...(skillConnectors.length === 0 ? {} : { skillConnectors }),
      ...(options.settings === undefined ? {} : { mcpServers: enabledMcpServers(options.settings) }),
      // W181 (A6): the posture-gated runtime-context instruction. Written into
      // the hub-owned config dir ONLY when an enforcing posture is declared;
      // the absent posture leaves both the file and the config key out.
      ...(egressGuidancePath === undefined ? {} : { instructions: [egressGuidancePath] }),
    });
    writeFileSync(
      join(configDir, "opencode", "opencode.json"),
      JSON.stringify(opencodeConfig),
      { encoding: "utf8", mode: 0o600 },
    );
    const resume = resumeFrom ?? process.env.WORKFLOW_ACP_RESUME;
    const driver = await AcpSessionDriver.contained({
      containment: new LinuxBubblewrapContainment(),
      launch: {
        executable: opencode.executable,
        args: [...opencodeAcpArgs(acpMajor)],
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
                // W080: the declared connectors' stdio entrypoints need the
                // same two-level pnpm binds (dist + app node_modules +
                // toolbox node_modules) or the agent's spawned MCP child
                // dies with ERR_MODULE_NOT_FOUND inside the boundary.
                ...connectorReadablePaths(skillConnectors.map((mount) => mount.serverPath)),
              ],
            }),
        environment: {
          // v1: the placeholder credential rides the 0600 per-runtime config
          // file (same posture as the Cline providers.json). v2: the built-in
          // `openrouter` provider is activated only by a credential env var, so
          // the placeholder rides here instead — still placeholder-only, the
          // real upstream key stays exclusively in the hub-side proxy. On v1
          // `--pure` also kept the operator's global plugins out of the
          // contained agent; on v2 the flag is gone (help page on stdout) and
          // the isolation rides on HOME/XDG_CONFIG_HOME alone — the hub-owned
          // config is the surface.
          XDG_CONFIG_HOME: configDir,
          ...(acpMajor !== undefined && acpMajor >= 2 ? { [OPENCODE_V2_METERED_ENV_KEY]: METERED_PLACEHOLDER_KEY } : {}),
          ...v2VendorEnv,
        },
      },
       authorize: options.permissionBroker === undefined
         ? application
         : (action: ProposedToolAction) =>
           options.permissionBroker!.intercept(action, (candidate) => application.authorize(candidate)),
        ...(options.permissionBroker === undefined ? {} : { permissionBroker: options.permissionBroker }),
        onToolOutcome: (sessionId, outcome, tool, reason) => application.recordToolOutcome(sessionId, outcome, tool, reason),
        onTodoUpdate: (entries) => application.mirrorNativeTodos(entries),
        workspace,
      workspaceSessionId: `acp-${randomBytes(4).toString("hex")}`,
      taskId,
      ...(resume !== undefined ? { resumeFrom: resume } : {}),
      // v2: pin the hub-chosen metered model (the config `model` is ignored
      // for the session default on v2; without the pin the session defaults to
      // a built-in `opencode/*` model and bypasses the proxy). The pin must be
      // a ref the v2 ACP picker accepts: a vendor built-in pool model is
      // translated to its catalog id (or the metered Auto Router when the
      // catalog has no faithful id — GLM on v2.0.10); every other ref passes
      // through unchanged.
      ...(acpMajor !== undefined && acpMajor >= 2 ? { selectModel: v2BuiltinModelRef(String(opencodeConfig.model)) } : {}),
      ...(guard === undefined ? {} : { guard }),
      ...(options.taskUsage === undefined ? {} : { taskUsage: options.taskUsage }),
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
      ...composeSessionWithBudget(driver, proxy, openPool === undefined ? undefined : () => openPool.metrics(), options.budgetOverride),
      usage: (): ModelUsageMetrics => proxy.metrics(),
      metrics: (): ModelUsageMetrics => proxy.metrics(),
      async dispose() {
        try {
          await driver.dispose();
        } finally {
          await proxy.close();
          await openPool?.close();
          await egressFeed?.close();
          rmSync(configDir, { recursive: true, force: true });
          console.log("metering proxy metrics:", JSON.stringify({ openRouter: proxy.metrics(), openSource: openPool?.metrics() }, null, 2));
        }
      },
    };
  } catch (error) {
    // A missing agent binary (the default first-run failure), an unwritable
    // config dir, or a containment failure must not leak the proxy listener
    // or the per-runtime config dir — mirror the Cline path's cleanup.
    await proxy.close();
    await openPool?.close();
    await egressFeed?.close();
    rmSync(configDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * W070a: builds the agent-visible provider entries for the composed
 * open-source pool. Labels come from the pool definitions; the default model
 * is the first available vendor's first model unless the operator explicitly
 * selected another live pool model.
 */
function openSourceConfig(openPool: OpenModelMeteringPool): {
  readonly providers: readonly MeteredVendorProvider[];
  readonly defaultModel: string;
} {
  const providers = openPool.providers.map((provider) => {
    // v2 routes the vendor through its BUILT-IN provider (a config-defined
    // custom provider is not registered on v2, #427); the family->built-in id
    // lives in opencode-agent-config.ts. A family absent from the map has no v2
    // built-in and is omitted from the v2 config (recorded, not fabricated).
    const builtin = OPENCODE_V2_VENDOR_BUILTINS[provider.family];
    return {
      id: provider.providerId,
      name: `Workflow metered (${provider.family})`,
      baseURL: provider.baseUrl,
      models: Object.fromEntries(provider.models.map((id) => [id, { name: findOpenModel(id)?.label ?? id }])),
      ...(builtin === undefined ? {} : { v2ProviderId: builtin.providerId }),
    };
  });
  const first = openPool.providers[0];
  const firstModel = first?.models[0];
  let defaultModel = first === undefined || firstModel === undefined ? `${OPENCODE_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}` : `${first.providerId}/${firstModel}`;
  const envModel = process.env.WORKFLOW_OPENCODE_MODEL?.trim();
  const envModelDef = envModel === undefined || envModel === "" ? undefined : findOpenModel(envModel);
  const envModelProvider = envModelDef === undefined ? undefined : openPool.byFamily.get(envModelDef.family);
  if (envModel !== undefined && envModel !== "" && envModelProvider !== undefined && envModelProvider.models.includes(envModel)) {
    defaultModel = `${envModelProvider.providerId}/${envModel}`;
  }
  return { providers, defaultModel };
}

async function createClineRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId | (() => TaskId),
  resumeFrom: string | undefined,
  guard: WorkflowGuardProvider | undefined,
  options: AcpRuntimeOptions,
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
  const proxy = await createModelUsageProxy({
    upstream,
    apiKey,
    ...(autoLatest === undefined ? {} : { autoLatest }),
    ...(options.onEgressDenied === undefined ? {} : { onEgressDenied: options.onEgressDenied }),
    ...(options.payloadPolicy === undefined ? {} : { payloadPolicy: options.payloadPolicy }),
    ...(options.credentialEndpoints === undefined ? {} : { credentialEndpoints: options.credentialEndpoints }),
  });
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
    const driver = await AcpSessionDriver.contained({
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
        ...(options.permissionBroker === undefined ? {} : { permissionBroker: options.permissionBroker }),
        onToolOutcome: (sessionId, outcome, tool, reason) => application.recordToolOutcome(sessionId, outcome, tool, reason),
        onTodoUpdate: (entries) => application.mirrorNativeTodos(entries),
        workspace,
      workspaceSessionId: `acp-${randomBytes(4).toString("hex")}`,
      taskId,
      ...(resume !== undefined ? { resumeFrom: resume } : {}),
      ...(guard === undefined ? {} : { guard }),
      ...(options.taskUsage === undefined ? {} : { taskUsage: options.taskUsage }),
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
      ...composeSessionWithBudget(driver, proxy, undefined, options.budgetOverride),
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
  options: AcpRuntimeOptions = {},
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

function loadOpencodeUpstreamApiKey(): string {
  try {
    return loadUpstreamApiKey();
  } catch (error) {
    try {
      const auth = JSON.parse(readFileSync(opencodeAuthPath(), "utf8"));
      const key = openrouterAuthKeyFromAuth(auth);
      if (key !== undefined) return key;
    } catch {
      // Fall through to the canonical upstream-key error.
    }
    throw error;
  }
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
/**
 * Blends the control plane's persisted goose model preference into the launch
 * environment as a default. Explicit operator env (`WORKFLOW_GOOSE_MODEL` /
 * `GOOSE_MODEL`) always wins; settings only fill the gap so a model chosen in
 * the settings page is pushed on the next session.
 */
function gooseLaunchSettingsEnv(env: NodeJS.ProcessEnv, settings: WorkflowSettings | undefined): NodeJS.ProcessEnv {
  const preferred = settings?.agents.goose?.model;
  if (preferred === undefined) return env;
  if ((env.WORKFLOW_GOOSE_MODEL ?? env.GOOSE_MODEL ?? "").trim().length > 0) return env;
  return { ...env, WORKFLOW_GOOSE_MODEL: preferred };
}

async function createGooseRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId | (() => TaskId),
  resumeFrom: string | undefined,
  guard: WorkflowGuardProvider | undefined,
  options: AcpRuntimeOptions,
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
    ? await createModelUsageProxy({
        upstream: process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai",
        apiKey: loadUpstreamApiKey(),
        // W182 (A7) / W184: the shared denial sink and the W180 policy tier ride
        // the goose OpenRouter lane too, so its refusals park on the same hub
        // surface. The azure_foundry lane composes no local proxy, so it has no
        // seam to carry.
        ...(options.onEgressDenied === undefined ? {} : { onEgressDenied: options.onEgressDenied }),
        ...(options.payloadPolicy === undefined ? {} : { payloadPolicy: options.payloadPolicy }),
        ...(options.credentialEndpoints === undefined ? {} : { credentialEndpoints: options.credentialEndpoints }),
      })
    : undefined;
  try {
    mkdirSync(join(configDir, "config"), { recursive: true, mode: 0o700 });
    const skillsMount = resolveSkillsMount();
    const configYaml = gooseConfigYaml({
      ...(skillsMount === undefined ? {} : {
        skillsServerScript: skillsMount.serverScript,
        skillsDir: skillsMount.skillsDir,
      }),
      ...(options.settings === undefined ? {} : { mcpServers: enabledMcpServers(options.settings) }),
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
    const driver = await AcpSessionDriver.contained({
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
          // The control plane's persisted model preference is a launch default
          // only: an explicit operator env var still wins.
          env: gooseLaunchSettingsEnv(process.env, options.settings),
        }),
      },
       authorize: options.permissionBroker === undefined
         ? application
         : (action: ProposedToolAction) =>
           options.permissionBroker!.intercept(action, (candidate) => application.authorize(candidate)),
        ...(options.permissionBroker === undefined ? {} : { permissionBroker: options.permissionBroker }),
        onToolOutcome: (sessionId, outcome, tool, reason) => application.recordToolOutcome(sessionId, outcome, tool, reason),
        onTodoUpdate: (entries) => application.mirrorNativeTodos(entries),
        workspace,
      workspaceSessionId: `acp-${randomBytes(4).toString("hex")}`,
      taskId,
      ...(resume !== undefined ? { resumeFrom: resume } : {}),
      ...(guard === undefined ? {} : { guard }),
      ...(options.taskUsage === undefined ? {} : { taskUsage: options.taskUsage }),
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
        : composeSessionWithBudget(driver, proxy, undefined, options.budgetOverride)),
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
