import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ClineHostAdapter } from "../adapters/cline.js";
import { WorkflowCodingSession } from "../application/coding-session.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import { WorkflowContainedProcess } from "../containment/workflow-process.js";
import { createDefaultToolboxGuardProvider } from "./mcp-toolbox-guard.js";
import { createWorkflowClinePlugin } from "./cline-plugin.js";
import { ClineSessionDriver } from "./cline-session.js";
import { createWorkflowClineShellExecutor } from "./cline-shell-executor.js";

interface ClineRuntimeCore {
  readonly ProviderSettingsManager: new () => { getLastUsedProviderConfig(): Record<string, unknown> };
  readonly ClineCore: { create(input: unknown): Promise<ClineCoreInstance> };
  readonly CommandExitError: new (exitCode: number, output: string) => Error;
  createApplyPatchExecutor(input: { readonly restrictToCwd: boolean }): unknown;
  createDefaultTools(input: unknown): Array<{ readonly name: string }>;
  getClineDefaultSystemPrompt(input: unknown): string;
}

interface ClineCoreInstance {
  start(input: unknown): Promise<{ readonly sessionId: string; readonly result?: { readonly text?: string } }>;
  subscribe(listener: (event: { readonly type: string; readonly payload?: unknown }) => void): () => void;
  stop(sessionId: string): Promise<void>;
  readMessages(sessionId: string): Promise<unknown[]>;
  dispose(): Promise<void>;
}

export interface WorkflowClineRuntime {
  readonly session: WorkflowCodingSession;
  dispose(): Promise<void>;
}

export async function createConfiguredClineRuntime(application: WorkflowApplication, workspaceRoot: string): Promise<WorkflowClineRuntime> {
  application.startInteractiveTask();
  const core = await loadClineCore();
  const providerConfig = new core.ProviderSettingsManager().getLastUsedProviderConfig();
  const providerId = stringValue(providerConfig.providerId);
  const modelId = stringValue(providerConfig.modelId);
  if (providerId === undefined || modelId === undefined) throw new Error("Workflow TUI requires a configured Cline model provider");

  const adapter = new ClineHostAdapter({
    sessionId: "workflow-tui",
    taskId: () => application.activeTaskId(),
    isMutatingTool: () => false,
    authoritativePreMutation: true,
  });
  const plugin = createWorkflowClinePlugin(application, adapter, (tool, reason, toolCallId) => driver?.recordToolDenial(tool, reason, toolCallId));
  const containment = new LinuxBubblewrapContainment();
  const guard = await createDefaultToolboxGuardProvider().catch((error) => {
    console.warn(`Workflow guard unavailable (advisory): ${error instanceof Error ? error.message : error}`);
    return undefined;
  });
  const shellExecutor = createWorkflowClineShellExecutor(
    new WorkflowContainedProcess(application, containment, guard),
    adapter,
    (exitCode, output) => new core.CommandExitError(exitCode, output),
  );
  const applyPatchTool = core.createDefaultTools({
    executors: { applyPatch: core.createApplyPatchExecutor({ restrictToCwd: true }) },
    cwd: workspaceRoot,
    enableReadFiles: false,
    enableSearch: false,
    enableBash: false,
    enableWebFetch: false,
    enableApplyPatch: true,
    enableEditor: false,
    enableSkills: false,
    enableAskQuestion: false,
  }).find(({ name }) => name === "apply_patch");
  if (applyPatchTool === undefined) throw new Error("installed Cline runtime does not expose apply_patch through its public tool factory");
  const cline = await core.ClineCore.create({
    clientName: "workflow-tui",
    backendMode: "local",
    capabilities: { toolExecutors: { bash: shellExecutor } },
  });
  const driver = new ClineSessionDriver({
    core: cline,
    hostAdapter: adapter,
    ...(application.codingSessionCorrelation === undefined ? {} : { resumeSessionId: application.codingSessionCorrelation }),
    onSessionId: (sessionId) => application.setCodingSessionCorrelation(sessionId),
    startInput: (prompt, initialMessages, userImages) => ({
      prompt,
      userImages,
      interactive: false,
      initialMessages,
      config: {
        providerId,
        modelId,
        providerConfig,
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        cwd: workspaceRoot,
        workspaceRoot,
        systemPrompt: core.getClineDefaultSystemPrompt({ rootPath: workspaceRoot, cwd: workspaceRoot, ide: "Terminal Shell", platform: platform(), mode: "act", providerId }),
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
      },
      localRuntime: { hooks: plugin.hooks, extraTools: [applyPatchTool] },
    }),
  });
  return { session: new WorkflowCodingSession(driver), dispose: () => Promise.all([cline.dispose(), guard?.close() ?? Promise.resolve()]).then(() => undefined) };
}

async function loadClineCore(): Promise<ClineRuntimeCore> {
  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const url = pathToFileURL(join(npmRoot, "cline", "node_modules", "@cline", "sdk", "dist", "index.js"));
    return await import(url.href) as ClineRuntimeCore;
  } catch (error) {
    throw new Error("Workflow TUI requires the Cline CLI with @cline/core installed globally", { cause: error });
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
