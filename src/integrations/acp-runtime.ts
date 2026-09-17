import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

export async function createConfiguredAcpRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId,
  resumeFrom?: string,
  guard?: WorkflowGuardProvider,
  options: { readonly permissionBroker?: PermissionBroker | undefined } = {},
): Promise<WorkflowAcpRuntime> {
  const scratchHome = resolve(homedir(), ".workflow", "acp-home");
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });

  const workflowRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  const launchCline = resolveClineLaunch({
    workflowRoot,
    envBinOverride: process.env.WORKFLOW_CLINE_BIN,
    clineOnPath: globalClineEntrypoint(),
  });
  let apiKey = process.env.CLINE_API_KEY;
  if (apiKey === undefined) {
    try {
      apiKey = readFileSync(resolve(homedir(), ".config", "workflow", "cline-api-key"), "utf8").trim();
    } catch {
      // Report one actionable configuration error below.
    }
  }
  if (!apiKey) throw new Error("ACP driver requires CLINE_API_KEY or ~/.config/workflow/cline-api-key");

  const provider = process.env.CLINE_PROVIDER ?? "openrouter";
  const upstream = process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai";
  const proxy = await createModelUsageProxy({ upstream, apiKey });
  // Each runtime owns a private provider-settings file: the metering proxy
  // port is ephemeral, so a shared providers.json let one runtime's agent
  // end up pointed at another runtime's (possibly dead) proxy. Cline writes
  // back to the same path, which must therefore be per-runtime.
  pruneStaleProviderSettings(scratchHome);
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

/** Resolves the self-contained `opencode` binary (env override, else PATH). */
function resolveOpencodeExecutable(): string {
  const override = process.env.WORKFLOW_OPENCODE_BIN;
  if (override !== undefined) return realpathSync(override);
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "opencode");
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error("opencode binary not found on PATH (set WORKFLOW_OPENCODE_BIN)");
}

/** Path to the operator's OpenCode credential store, when present. */
export function opencodeAuthPath(): string {
  return resolve(homedir(), ".local", "share", "opencode", "auth.json");
}

/**
 * OpenCode over ACP, launched contained like Cline. OpenCode manages its own
 * provider auth (no metering proxy), so the runtime carries no usage meter;
 * the surface falls back to the driver's ACP usage_update for context/cost.
 * Its credential store and a minimal, plugin-free config are bound into a
 * private scratch HOME so the contained agent never sees the operator's real
 * home, session database, or guard plugin.
 */
export async function createConfiguredOpencodeAcpRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId,
  resumeFrom?: string,
  options: { readonly permissionBroker?: PermissionBroker | undefined } = {},
): Promise<WorkflowAcpRuntime> {
  const executable = resolveOpencodeExecutable();
  const authSource = opencodeAuthPath();
  if (!existsSync(authSource)) {
    throw new Error("OpenCode credentials not found (~/.local/share/opencode/auth.json)");
  }
  // Sweep homes left by crashed processes before writing a fresh credential
  // copy — a live credential must never linger in a dead runtime's scratch.
  const acpHome = resolve(homedir(), ".workflow", "acp-home");
  pruneStaleOpencodeHomes(acpHome);
  // The home name encodes the pid so the sweep can distinguish live owners.
  const home = join(acpHome, `opencode-${process.pid}-${randomUUID()}`);
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), readFileSync(authSource), { mode: 0o600 });
  mkdirSync(join(home, ".config", "opencode"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), "{}\n", { encoding: "utf8", mode: 0o600 });

  const resume = resumeFrom ?? process.env.WORKFLOW_ACP_RESUME;
  const driver = AcpSessionDriver.contained({
    containment: new LinuxBubblewrapContainment(),
    launch: {
      executable,
      args: ["acp"],
      workspace,
      home,
      environment: { PATH: process.env.PATH ?? "" },
    },
    authorize: options.permissionBroker === undefined
      ? application
      : (action: ProposedToolAction) =>
        options.permissionBroker!.intercept(action, (candidate) => application.authorize(candidate)),
    workspace,
    workspaceSessionId: `acp-opencode-${randomBytes(4).toString("hex")}`,
    taskId,
    ...(resume !== undefined ? { resumeFrom: resume } : {}),
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
    async dispose() {
      try {
        await driver.dispose();
      } finally {
        // The scratch HOME holds a copy of the credential store; never leave it.
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Removes opencode scratch homes whose owning process is gone, so a crashed
 * runtime cannot leave a live credential copy behind. Homes belonging to live
 * processes (a concurrent web service or TUI) are preserved.
 */
function pruneStaleOpencodeHomes(acpHome: string): void {
  if (!existsSync(acpHome)) return;
  for (const entry of readdirSync(acpHome)) {
    const match = /^opencode-(\d+)-/.exec(entry);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch {
      rmSync(join(acpHome, entry), { recursive: true, force: true });
    }
  }
}

/**
 * Removes per-runtime provider-settings files whose owning process is gone,
 * so crashed runtimes cannot leave stale configs behind. Files belonging to
 * live processes (e.g. a concurrent TUI or the web service) are preserved.
 */
function pruneStaleProviderSettings(scratchHome: string): void {
  for (const entry of readdirSync(scratchHome)) {
    const match = /^providers\.(\d+)(?:\.[0-9a-f-]+)?\.json$/.exec(entry);
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
      rmSync(join(scratchHome, entry), { force: true });
    }
  }
}
