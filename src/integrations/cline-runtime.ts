import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ClineHostAdapter } from "../adapters/cline.js";
import { WorkflowCodingSession } from "../application/coding-session.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { WorkflowContainedProcess } from "../containment/workflow-process.js";
import { selectContainment } from "../containment/platform.js";
import { createDefaultToolboxGuardProvider } from "./mcp-toolbox-guard.js";
import { createWorkflowClinePlugin } from "./cline-plugin.js";
import { ClineSessionDriver } from "./cline-session.js";
import { createWorkflowClineShellExecutor } from "./cline-shell-executor.js";
import { createProjectMemoryClient, formatMemoryRecall, type ProjectMemory } from "./project-memory.js";
import { resolveStyleFromEnv, stylePromptAddendum, type SessionStyle } from "./response-style.js";

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
  setSessionStyle(style: SessionStyle): void;
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
  const guard = await createDefaultToolboxGuardProvider().catch((error) => {
    console.warn(`Workflow guard unavailable (advisory): ${error instanceof Error ? error.message : error}`);
    return undefined;
  });
  const shellExecutor = createWorkflowClineShellExecutor(
    new WorkflowContainedProcess(application, selectContainment(), guard),
    adapter,
    (exitCode, output) => new core.CommandExitError(exitCode, output),
  );
  // Compaction bridge: recall durable project memory at session start and
  // flush a bounded outcome record after each completed run, so context
  // compaction never loses durable state. Advisory: no memory server, no bridge.
  const memoryServer = resolve(fileURLToPath(import.meta.url), "../../../mcp-toolbox/apps/project-memory-mcp/dist/server.js");
  const memory: ProjectMemory | undefined = existsSync(memoryServer)
    ? await createProjectMemoryClient({ serverScript: memoryServer, workspaceRoot }).catch(() => undefined)
    : undefined;
  const memoryRecall = memory === undefined
    ? ""
    : formatMemoryRecall(await memory.recall("decisions constraints lessons", 8).catch(() => []), { maxChars: 2_000 });
  // Session style (caveman speech / ponytail build) is re-read per submission
  // so the TUI can switch styles live without restarting the runtime.
  const styleState: { current: SessionStyle } = { current: resolveStyleFromEnv(process.env) };
  const promptAddendum = (): string => {
    const parts = [memoryRecall, stylePromptAddendum(styleState.current)].filter((part) => part.length > 0);
    return parts.length === 0 ? "" : `\n\n${parts.join("\n\n")}`;
  };
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
        systemPrompt: core.getClineDefaultSystemPrompt({ rootPath: workspaceRoot, cwd: workspaceRoot, ide: "Terminal Shell", platform: platform(), mode: "act", providerId })
          + promptAddendum(),
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
      },
      localRuntime: { hooks: plugin.hooks, extraTools: [applyPatchTool] },
    }),
  });
  const session = new WorkflowCodingSession(driver);
  if (memory !== undefined) {
    const flush = memory;
    session.subscribe((event) => {
      if (event.type !== "completed" || event.result.trim().length < 100) return;
      const content = `Session outcome in ${workspaceRoot}: ${event.result.trim().slice(0, 400)}`;
      void flush.record("lesson", content).catch(() => undefined);
    });
  }
  return {
    session,
    setSessionStyle(style: SessionStyle): void {
      styleState.current = style;
    },
    dispose: () => Promise.all([cline.dispose(), guard?.close() ?? Promise.resolve(), memory?.close() ?? Promise.resolve()]).then(() => undefined),
  };
}

async function loadClineCore(): Promise<ClineRuntimeCore> {
  // Prefer the vendored, Workflow-patched Cline core: it carries the MCP
  // notification forwarding (progress/log streaming) that stock builds drop.
  // Fall back to the globally installed Cline CLI.
  const vendored = pathToFileURL(
    resolve(fileURLToPath(import.meta.url), "../../../.workflow-cline/cline/sdk/packages/sdk/dist/index.js"),
  );
  try {
    if (existsSync(vendored)) return await import(vendored.href) as ClineRuntimeCore;
  } catch {
    // Fall through to the global install.
  }
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
