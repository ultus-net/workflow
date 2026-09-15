import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { CodingSessionDriver, CodingSessionEvent, CodingSessionImage } from "../application/coding-session.js";
import type { TaskId, PolicyDecision } from "../kernel/contracts.js";
import type { ProposedToolAction, ToolCapability } from "../adapters/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import type { ProcessContainment } from "../containment/contracts.js";
import { AcpHostAdapter } from "../adapters/acp.js";
import {
  launchContainedAcpAgent,
  type ContainedAcpAgentLaunchOptions,
} from "../adapters/acp-contained-agent.js";
import {
  AcpSubprocessClient,
  type AcpConfigOptionValue,
  type AcpPermissionDecision,
  type AcpSessionConfig,
  type AcpSessionUpdate,
} from "../adapters/acp-subprocess.js";
import type { AcpPermissionRequestParams } from "../adapters/acp-permission.js";
import { createWorkflowAcpPermissionResolver } from "../adapters/acp-workflow-resolver.js";

/**
 * Plan Task B2: config options that would switch the agent into a
 * bypass/auto-approve-everything mode alter the session's enforcement level.
 * Client-set values are denied before any wire call; agent-applied values
 * are rejected from retained config with a visible denial — an `advisory`
 * degradation must never happen silently on an `enforced` surface.
 */
const ENFORCEMENT_ALTERING_TOKENS: ReadonlySet<string> = new Set([
  "bypass",
  "bypasspermissions",
  "autoapprove",
  "skippermissions",
  "neverask",
  "donotask",
  "dangerousskip",
  "unrestricted",
  "allowall",
  "yolo",
]);

export function isEnforcementAlteringConfigOption(configId: string): boolean {
  const normalized = configId.toLowerCase().replace(/[-_\s]/g, "");
  for (const token of ENFORCEMENT_ALTERING_TOKENS) {
    if (normalized === token || normalized.includes(token)) return true;
  }
  return false;
}

function enforcementAlteringOptionIds(options: readonly unknown[]): string[] {
  return options.flatMap((option) => {
    if (typeof option !== "object" || option === null) return [];
    const id = (option as { id?: unknown }).id;
    return typeof id === "string" && isEnforcementAlteringConfigOption(id) ? [id] : [];
  });
}

/**
 * Clean-surface ACP session driver. A prompt runs through the host-neutral
 * CodingSessionDriver contract while permission interception is wired into
 * WorkflowApplication.authorize (the hub authority); session/update
 * notifications are a UX projection only. The default spawn path is
 * whole-agent containment via launchContainedAcpAgent (fails closed on
 * policy-only backends); tests may pass any spawned child.
 */
export class AcpSessionDriver implements CodingSessionDriver {
  #client: AcpSubprocessClient;
  #authorize: (action: ProposedToolAction) => PolicyDecision | Promise<PolicyDecision>;
  #adapter: AcpHostAdapter;
  #workspace: string;
  #workflowSessionId: string;
  #taskId: TaskId;
  #resumeFrom: string | undefined;
  #initialized = false;
  #canLoadSession = false;
  #agentSessionId?: string;
  #sessionConfig?: AcpSessionConfig;
  #toolTitles = new Map<string, string>();
  #assistant: string[] = [];
  #emit: (event: CodingSessionEvent) => void = () => {};
  #listeners = new Set<(event: CodingSessionEvent) => void>();

  constructor(options: {
    child: ChildProcessWithoutNullStreams;
    authorize: WorkflowApplication | ((action: ProposedToolAction) => PolicyDecision | Promise<PolicyDecision>);
    workspace: string;
    workspaceSessionId: string;
    taskId: TaskId;
    resumeFrom?: string;
    adapter?: AcpHostAdapter;
  }) {
    const authorize = typeof options.authorize === "function"
      ? options.authorize
      : (action: ProposedToolAction) => (options.authorize as WorkflowApplication).authorize(action);
    this.#authorize = authorize;
    this.#adapter = options.adapter ?? new AcpHostAdapter({ authoritativePermissions: true });
    this.#workspace = options.workspace;
    this.#workflowSessionId = options.workspaceSessionId;
    this.#taskId = options.taskId;
    this.#resumeFrom = options.resumeFrom;
    this.#client = new AcpSubprocessClient({
      child: options.child,
      resolvePermission: (request) => this.#resolvePermission(request),
    });
    // Projection is registered once: replays from session/load and any
    // notification before the first prompt still reach the surface. Turn
    // prompts receive events through start()'s emit; explicit subscribers
    // (e.g. a resume loader) receive every projection event via #listeners.
    this.#client.onSessionUpdate((update) => {
      if (update.update.sessionUpdate === "config_option_update" && Array.isArray(update.update.configOptions)) {
        // Plan Task B2: an agent-applied bypass/auto-approve option must not
        // silently enter retained config — the update is rejected whole and
        // the denial surfaces as a visible status event.
        const denied = enforcementAlteringOptionIds(update.update.configOptions);
        if (denied.length > 0) {
          const denial: CodingSessionEvent = {
            type: "status",
            status: `denied agent-applied enforcement-altering config option(s): ${denied.join(", ")}`,
          };
          this.#emit(denial);
          for (const listener of this.#listeners) listener(denial);
          return;
        }
        this.#sessionConfig = { ...this.#sessionConfig, configOptions: update.update.configOptions };      }
      const event = this.#project(update, this.#assistant);
      if (event !== undefined) {
        this.#emit(event);
        for (const listener of this.#listeners) listener(event);
      }
    });
  }

  /**
   * Receives every projected session event, including session/load replays
   * outside any prompt turn. Surfaces with their own event channel subscribe
   * for the duration of a resume and then unsubscribe.
   */
  subscribe(listener: (event: CodingSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Default spawn path: launch the agent process itself under an enforced
   * containment boundary (the lead surface's launch mode).
   */
  static contained(options: {
    containment: ProcessContainment;
    launch: ContainedAcpAgentLaunchOptions;
    authorize: WorkflowApplication | ((action: ProposedToolAction) => PolicyDecision | Promise<PolicyDecision>);
    workspace: string;
    workspaceSessionId: string;
    taskId: TaskId;
    resumeFrom?: string;
    adapter?: AcpHostAdapter;
  }): AcpSessionDriver {
    const child = launchContainedAcpAgent(options.containment, options.launch);
    return new AcpSessionDriver({ ...options, child });
  }

  /**
   * Establishes the ACP session eagerly: initializes the connection and
   * creates (or loads, when resuming) the agent session. start() invokes it
   * lazily; surfaces resuming history call it directly so the session/load
   * replay reaches listeners before the next prompt.
   */
  async connect(): Promise<void> {
    if (!this.#initialized) {
      const initialized = await this.#client.initialize();
      this.#canLoadSession = initialized.agentCapabilities.loadSession === true;
      this.#initialized = true;
    }
    if (this.#agentSessionId === undefined) {
      if (this.#resumeFrom !== undefined) {
        if (!this.#canLoadSession) throw new Error("ACP agent does not advertise session/load support");
        const loadedConfig = await this.#client.loadSession({ sessionId: this.#resumeFrom, cwd: this.#workspace });
        if (Object.keys(loadedConfig).length > 0) this.#sessionConfig = { ...this.#sessionConfig, ...loadedConfig };
        this.#agentSessionId = this.#resumeFrom;
      } else {
        const session = await this.#client.newSession({ cwd: this.#workspace });
        this.#agentSessionId = session.sessionId;
        this.#sessionConfig = session.config;
      }
      // Project the agent session id so the operator can resume it later.
      this.#emit({ type: "status", status: `agent session id: ${this.#agentSessionId}` });
      if (this.#sessionConfig !== undefined) {
        this.#emit({ type: "status", status: AcpSessionDriver.configSummary(this.#sessionConfig) });
      }
    }
  }

  async start(
    prompt: string,
    emit: (event: CodingSessionEvent) => void,
    images?: readonly CodingSessionImage[],
  ): Promise<void> {
    this.#emit = emit;
    this.#toolTitles.clear();
    await this.connect();
    const agentSessionId = this.#agentSessionId;
    if (agentSessionId === undefined) throw new Error("ACP session was not established");
    // Replay chunks were already projected as events; the completion result
    // is scoped to this prompt's assistant text.
    this.#assistant = [];
    const content = [
      { type: "text", text: prompt },
      ...(images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mediaType })),
    ];
    const result = (await this.#client.prompt({ sessionId: agentSessionId, prompt: content })) as
      { stopReason?: string } | undefined;
    const stopReason = result?.stopReason;
    if (stopReason === "end_turn") {
      emit({ type: "completed", result: this.#assistant.join("") });
    } else if (stopReason === "cancelled") {
      emit({ type: "failed", reason: "ACP turn cancelled by the agent" });
    } else {
      emit({ type: "failed", reason: `ACP prompt returned unexpected stop reason: ${String(stopReason)}` });
    }
  }

  async cancel(): Promise<void> {
    if (this.#agentSessionId === undefined) return;
    await this.#client.cancel({ sessionId: this.#agentSessionId });
  }

  /** Terminate the agent process; surfaces must call this on exit. */
  async dispose(): Promise<void> {
    await this.#client.close();
  }

  /** Agent-side ACP session id (undefined until the first prompt creates/loads it). */
  agentSessionId(): string | undefined {
    return this.#agentSessionId;
  }

  /** Config captured from session/new (undefined until the first session is created). */
  config(): AcpSessionConfig | undefined {
    return this.#sessionConfig;
  }

  /** Mutate configuration on the existing ACP session and retain the agent's complete returned state. */
  async setConfigOption(configId: string, value: AcpConfigOptionValue): Promise<AcpSessionConfig> {
    // Plan Task B2: enforcement-altering options are denied client-side
    // before any wire call — the operator-visible enforcement level must
    // never silently change under an `enforced` surface.
    if (isEnforcementAlteringConfigOption(configId)) {
      throw new TypeError(`denied: config option '${configId}' alters the session's enforcement level`);
    }
    if (this.#agentSessionId === undefined) throw new Error("ACP session has not been created");
    const updated = await this.#client.setConfigOption({ sessionId: this.#agentSessionId, configId, value });
    this.#sessionConfig = { ...this.#sessionConfig, ...updated };
    return this.#sessionConfig;
  }

  /** Readable one-line summary of a captured session/new config. */
  static configSummary(config: AcpSessionConfig): string {
    const parts: string[] = [];
    if (Array.isArray(config.availableModes)) parts.push(`modes=${JSON.stringify(config.availableModes)}`);
    if (Array.isArray(config.availableModels)) parts.push(`models=${JSON.stringify(config.availableModels)}`);
    if (Array.isArray(config.configOptions)) parts.push(`options(${config.configOptions.length})`);
    return parts.length > 0 ? `session config: ${parts.join(" ")}` : "session config: none advertised";
  }

  #project(update: AcpSessionUpdate, assistant: string[]): CodingSessionEvent | undefined {
    const kind = update.update.sessionUpdate;
    if (kind === "config_option_update" && Array.isArray(update.update.configOptions)) {
      return { type: "status", status: AcpSessionDriver.configSummary({ configOptions: update.update.configOptions }) };
    }
    if (kind === "agent_message_chunk") {
      const content = update.update.content as { type?: string; text?: string; data?: string } | undefined;
      const text = typeof content?.text === "string" ? content.text : content?.data ?? "";
      assistant.push(text);
      return { type: "assistant", text };
    }
    if (kind === "user_message_chunk") {
      // Replayed history (session/load) includes the operator's own turns.
      const content = update.update.content as { type?: string; text?: string; data?: string } | undefined;
      const text = typeof content?.text === "string" ? content.text : content?.data ?? "";
      return { type: "user", text };
    }
    if (kind === "agent_thought_chunk") {
      const content = update.update.content as { type?: string; text?: string } | undefined;
      return { type: "log", level: "info", message: content?.text ?? "", source: "agent-thought" };
    }
    if (kind === "tool_call") {
      const title = this.#toolTitle(update);
      this.#toolTitles.set(String(update.update.toolCallId), title);
      return { type: "tool-proposal", tool: title, subjects: this.#locations(update) };
    }
    if (kind === "tool_call_update") {
      const status = String(update.update.status ?? "");
      const subject = this.#toolTitles.get(String(update.update.toolCallId)) ?? String(update.update.toolCallId ?? "unknown");
      if (status === "completed") return { type: "tool-outcome", tool: subject, outcome: "succeeded" };
      if (status === "failed") return { type: "tool-outcome", tool: subject, outcome: "failed", detail: status };
      return { type: "status", status: `tool ${subject}: ${status || "unknown"}` };
    }
    if (kind === "session_info_update") return { type: "status", status: String(update.update.title ?? update.update.sessionUpdate) };
    return undefined;
  }

  #toolTitle(update: AcpSessionUpdate): string {
    const value = update.update.title;
    return typeof value === "string" && value.length > 0 ? value : "unknown";
  }

  #locations(update: AcpSessionUpdate): string[] {
    const locations = update.update.locations;
    if (!Array.isArray(locations)) return [];
    return locations.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const path = (entry as { path?: unknown }).path;
      return typeof path === "string" ? [path] : [];
    });
  }

  async #resolvePermission(request: AcpPermissionRequestParams): Promise<AcpPermissionDecision> {
    if (this.#agentSessionId === undefined) {
      throw new TypeError("ACP permission request before session creation");
    }
    const toolName = AcpSessionDriver.toolNameFromTitle(request.toolCall?.title);
    const resolver = createWorkflowAcpPermissionResolver({
      adapter: this.#adapter,
      correlation: {
        sessionId: this.#workflowSessionId,
        agentSessionId: this.#agentSessionId,
        taskId: this.#taskId,
        toolName,
        capability: AcpSessionDriver.classify(toolName),
      },
      authorize: (action) => this.#authorize(action),
    });
    return resolver(request);
  }

  /**
   * Cline titles carry details (`run_commands: ls -la …`); the tool name is
   * the first token. An unrecognized remainder still resolves, and the
   * resolver fails closed on unknown names.
   */
  static toolNameFromTitle(title: string | undefined): string {
    if (title === undefined) return "unknown";
    const name = /^[^\s:]+/.exec(title)?.[0];
    return name !== undefined && name.length > 0 ? name : "unknown";
  }

  /** Title classification is fail-closed: unknown tools map to the mutation capability. */
  static classify(toolName: string): ToolCapability {
    if (["read_file", "read_files", "list_files", "list_code_definition_names", "search_files", "search_codebase"].includes(toolName)) {
      return "read";
    }
    if (["run_commands", "execute_command", "shell", "bash"].includes(toolName)) {
      return "process";
    }
    if (["fetch_web_content", "web_fetch", "web_search"].includes(toolName)) {
      return "network";
    }
    return "mutation";
  }
}
