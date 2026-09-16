import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProposedToolAction } from "../application/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { WorkflowCodingSession } from "../application/coding-session.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import type { TaskId } from "../kernel/contracts.js";
import { AcpSessionDriver } from "./acp-session.js";
import { globalClineEntrypoint, resolveClineLaunch } from "./cline-launch.js";
import {
  globalOpencodeBinary,
  meteredOpencodeConfig,
  resolveOpencodeLaunch,
} from "./opencode-agent-config.js";
import type { PermissionBroker } from "../ui/permission-broker.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import { METERED_PLACEHOLDER_KEY, type ModelUsageMetrics, createModelUsageProxy, meteredProviderSettings } from "./model-usage-proxy.js";

export interface WorkflowAcpRuntime {
  readonly driver: AcpSessionDriver;
  readonly session: WorkflowCodingSession;
  /** Cumulative metering-proxy usage for this runtime (tokens + cost). */
  metrics?(): ModelUsageMetrics;
  dispose(): Promise<void>;
  /** Cumulative metering-proxy metrics; absent for unmetered runtimes. */
  usage?(): ModelUsageMetrics;
}

export type AcpAgentKind = "opencode" | "cline";

/**
 * Lead-agent selection. Since the 2026-09-16 pivot (`docs/ACP_DECISION.md`)
 * the hub's lead surface is stock-ACP OpenCode: spawn gateable at the hub,
 * hub-written config honored, session resume restoring model context, no
 * vendored patch — all probe-proven (`docs/HOST_ADAPTERS.md`). WORKFLOW_ACP_AGENT
 * selects the Cline fallback (vendored patched binary; stock Cline cannot
 * run headless) for compatibility and dogfooding.
 */
export function acpAgentKind(): AcpAgentKind {
  const raw = process.env.WORKFLOW_ACP_AGENT?.trim();
  if (raw === undefined || raw === "" || raw === "opencode") return "opencode";
  if (raw === "cline") return "cline";
  throw new Error(`WORKFLOW_ACP_AGENT must be "opencode" or "cline" (got ${JSON.stringify(raw)})`);
}

export async function createConfiguredAcpRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId,
  resumeFrom?: string,
  guard?: WorkflowGuardProvider,
  options: { readonly permissionBroker?: PermissionBroker | undefined } = {},
): Promise<WorkflowAcpRuntime> {
  return acpAgentKind() === "opencode"
    ? createOpencodeRuntime(application, workspace, taskId, resumeFrom, guard, options)
    : createClineRuntime(application, workspace, taskId, resumeFrom, guard, options);
}

async function createOpencodeRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId,
  resumeFrom: string | undefined,
  guard: WorkflowGuardProvider | undefined,
  options: { readonly permissionBroker?: PermissionBroker | undefined },
): Promise<WorkflowAcpRuntime> {
  const scratchHome = resolve(homedir(), ".workflow", "acp-home");
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });

  const apiKey = loadUpstreamApiKey();
  const upstream = process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai";
  const proxy = await createModelUsageProxy({ upstream, apiKey });
  // Each runtime owns a private config dir: the metering proxy port is
  // ephemeral and the config points the agent at it, so runtimes must never
  // share one config (a dead proxy port would strand later agents). Unique
  // per runtime, not per process: one hub process creates a reviewer runtime
  // per auto-review, and concurrent runtimes must never clobber each other.
  pruneStaleRuntimeArtifacts(scratchHome);
  const configDir = join(scratchHome, `config.${process.pid}.${randomUUID()}`);
  mkdirSync(join(configDir, "opencode"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, "opencode", "opencode.json"),
    JSON.stringify(meteredOpencodeConfig({ proxyUrl: proxy.url, model: process.env.WORKFLOW_OPENCODE_MODEL })),
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
    session: new WorkflowCodingSession(driver),
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
}

async function createClineRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId,
  resumeFrom: string | undefined,
  guard: WorkflowGuardProvider | undefined,
  options: { readonly permissionBroker?: PermissionBroker | undefined },
): Promise<WorkflowAcpRuntime> {
  const scratchHome = resolve(homedir(), ".workflow", "acp-home");
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });

  const workflowRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  const launchCline = resolveClineLaunch({
    workflowRoot,
    envBinOverride: process.env.WORKFLOW_CLINE_BIN,
    clineOnPath: globalClineEntrypoint(),
  });
  const apiKey = loadUpstreamApiKey();
  const provider = process.env.CLINE_PROVIDER ?? "openrouter";
  const upstream = process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai";
  const proxy = await createModelUsageProxy({ upstream, apiKey });
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
      session: new WorkflowCodingSession(driver),
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

/**
 * The upstream (OpenRouter) key for the hub-side metering proxy. This key
 * never enters the agent's environment or config files: the proxy holds it
 * and injects it upstream. Env override first, then the key file shared
 * with the gated probes.
 */
function loadUpstreamApiKey(): string {
  const apiKey = process.env.CLINE_API_KEY?.trim() || readKeyFile();
  if (!apiKey) {
    throw new Error("ACP driver requires CLINE_API_KEY or ~/.config/workflow/cline-api-key (the upstream key for the metering proxy)");
  }
  return apiKey;
}

function readKeyFile(): string | undefined {
  try {
    return readFileSync(resolve(homedir(), ".config", "workflow", "cline-api-key"), "utf8").trim();
  } catch {
    return undefined;
  }
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
