import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { WorkflowApplication } from "../application/workflow.js";
import { WorkflowCodingSession } from "../application/coding-session.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import type { TaskId } from "../kernel/contracts.js";
import { AcpSessionDriver } from "./acp-session.js";
import { METERED_PLACEHOLDER_KEY, createModelUsageProxy, meteredProviderSettings } from "./model-usage-proxy.js";

export interface WorkflowAcpRuntime {
  readonly driver: AcpSessionDriver;
  readonly session: WorkflowCodingSession;
  dispose(): Promise<void>;
}

export async function createConfiguredAcpRuntime(
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId,
  resumeFrom?: string,
): Promise<WorkflowAcpRuntime> {
  const scratchHome = resolve(homedir(), ".workflow", "acp-home");
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });

  const clineBin = realpathSync(execFileSync("/usr/bin/which", ["cline"], { encoding: "utf8" }).trim());
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
        executable: process.execPath,
        script: clineBin,
        args: ["--acp", "--auto-approve", "false", ...(model ? ["--model", model] : [])],
        workspace,
        home: scratchHome,
        environment: {
          CLINE_API_KEY: METERED_PLACEHOLDER_KEY,
          CLINE_PROVIDER: provider,
          CLINE_PROVIDER_SETTINGS_PATH: settingsPath,
        },
      },
      authorize: application,
      workspace,
      workspaceSessionId: `acp-${randomBytes(4).toString("hex")}`,
      taskId,
      ...(resume !== undefined ? { resumeFrom: resume } : {}),
    });
    return {
      driver,
      session: new WorkflowCodingSession(driver),
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
 * Removes per-runtime provider-settings files whose owning process is gone,
 * so crashed runtimes cannot leave stale configs behind. Files belonging to
 * live processes (e.g. a concurrent TUI or the web service) are preserved.
 */
function pruneStaleProviderSettings(scratchHome: string): void {
  for (const entry of readdirSync(scratchHome)) {
    const match = /^providers\.(\d+)\.json$/.exec(entry);
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
