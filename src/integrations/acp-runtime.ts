import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  try {
    const settingsPath = join(scratchHome, "providers.json");
    writeFileSync(settingsPath, JSON.stringify(meteredProviderSettings(proxy.url, provider)), { encoding: "utf8", mode: 0o600 });
    const model = process.env.CLINE_MODEL;
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
      ...(process.env.WORKFLOW_ACP_RESUME ? { resumeFrom: process.env.WORKFLOW_ACP_RESUME } : {}),
    });
    return {
      driver,
      session: new WorkflowCodingSession(driver),
      async dispose() {
        try {
          await driver.dispose();
        } finally {
          await proxy.close();
          console.log("metering proxy metrics:", JSON.stringify(proxy.metrics(), null, 2));
        }
      },
    };
  } catch (error) {
    await proxy.close();
    throw error;
  }
}
