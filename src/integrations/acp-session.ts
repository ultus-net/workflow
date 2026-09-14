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
import { AcpSubprocessClient, type AcpPermissionDecision, type AcpSessionUpdate } from "../adapters/acp-subprocess.js";
import type { AcpPermissionRequestParams } from "../adapters/acp-permission.js";
import { createWorkflowAcpPermissionResolver } from "../adapters/acp-workflow-resolver.js";

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
  #agentSessionId?: string;
  #toolTitles = new Map<string, string>();
  #assistant: string[] = [];
  #emit: (event: CodingSessionEvent) => void = () => {};

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
    // notification before the first prompt still reach the surface.
    this.#client.onSessionUpdate((update) => {
      const event = this.#project(update, this.#assistant);
      if (event !== undefined) this.#emit(event);
    });
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

  async start(
    prompt: string,
    emit: (event: CodingSessionEvent) => void,
    images?: readonly CodingSessionImage[],
  ): Promise<void> {
    this.#emit = emit;
    this.#toolTitles.clear();
    if (!this.#initialized) {
      await this.#client.initialize();
      this.#initialized = true;
    }
    if (this.#agentSessionId === undefined) {
      if (this.#resumeFrom !== undefined) {
        await this.#client.loadSession({ sessionId: this.#resumeFrom, cwd: this.#workspace });
        this.#agentSessionId = this.#resumeFrom;
      } else {
        const session = await this.#client.newSession({ cwd: this.#workspace });
        this.#agentSessionId = session.sessionId;
      }
    }
    // Replay chunks were already projected as events; the completion result
    // is scoped to this prompt's assistant text.
    this.#assistant = [];
    const content = [
      { type: "text", text: prompt },
      ...(images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mediaType })),
    ];
    const result = (await this.#client.prompt({ sessionId: this.#agentSessionId, prompt: content })) as
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

  #project(update: AcpSessionUpdate, assistant: string[]): CodingSessionEvent | undefined {
    const kind = update.update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const content = update.update.content as { type?: string; text?: string; data?: string } | undefined;
      const text = typeof content?.text === "string" ? content.text : content?.data ?? "";
      assistant.push(text);
      return { type: "assistant", text };
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
    const toolName = request.toolCall?.title ?? "unknown";
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
