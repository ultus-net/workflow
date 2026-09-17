import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

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
import { guardInputFromToolCall, type WorkflowGuardProvider } from "./mcp-toolbox-guard.js";

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
  "approveall",
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
  // W046: a fixed id (hub runs, reviewer, web sessions) or a lazy getter
  // (interactive surfaces read the application's active-task pointer at
  // proposal time, mirroring the Cline adapter's correlation).
  #taskId: TaskId | (() => TaskId);
  #resumeFrom: string | undefined;
  #guard: WorkflowGuardProvider | undefined;
  #onSkillRead: ((skill: string) => void) | undefined;
  #initialized = false;
  #canLoadSession = false;
  #agentSessionId?: string;
  #sessionConfig?: AcpSessionConfig;
  #toolTitles = new Map<string, string>();
  #toolCalls = new Map<string, { title: string; toolKind: string; subjects: string[]; rawInput?: string }>();
  #assistant: string[] = [];
  #emit: (event: CodingSessionEvent) => void = () => {};
  #listeners = new Set<(event: CodingSessionEvent) => void>();

  constructor(options: {
    child: ChildProcessWithoutNullStreams;
    authorize: WorkflowApplication | ((action: ProposedToolAction) => PolicyDecision | Promise<PolicyDecision>);
    workspace: string;
    workspaceSessionId: string;
    taskId: TaskId | (() => TaskId);
    resumeFrom?: string;
    adapter?: AcpHostAdapter;
    guard?: WorkflowGuardProvider;
    onSkillRead?: (skill: string) => void;
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
    this.#guard = options.guard;
    this.#onSkillRead = options.onSkillRead;
    this.#client = new AcpSubprocessClient({
      child: options.child,
      resolvePermission: (request) => this.#resolvePermission(request),
      // The hub-implemented ACP fs server: agents that delegate file
      // operations to the client (OpenCode's `--pure` ACP mode) cross hub
      // authorization + guard on every call, then the hub performs the
      // operation itself — the write literally passes through the authority.
      fsServer: {
        readTextFile: (params) => this.#resolveFs("fs/read_text_file", "read", false, params),
        writeTextFile: (params) => this.#resolveFs("fs/write_text_file", "mutation", true, params),
        listDirectory: (params) => this.#resolveFs("fs/list_directory", "read", false, params),
      },
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
        this.#sessionConfig = { ...this.#sessionConfig, configOptions: update.update.configOptions };
      }
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
    taskId: TaskId | (() => TaskId);
    resumeFrom?: string;
    adapter?: AcpHostAdapter;
    guard?: WorkflowGuardProvider;
    onSkillRead?: (skill: string) => void;
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
    this.#toolCalls.clear();
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
    const result = (await this.#prompt(agentSessionId, content)) as
      { stopReason?: string; failClosedReason?: string } | undefined;
    const stopReason = result?.stopReason;
    if (stopReason === "end_turn") {
      emit({ type: "completed", result: this.#assistant.join("") });
    } else if (stopReason === "cancelled") {
      // W047 (G5): the wire carries the actionable cause — a fail-closed
      // permission denial (the agent had no reject option for the hub's
      // deny) reports WHY the turn died. Thread it; never discard it.
      const failClosed = typeof result?.failClosedReason === "string" && result.failClosedReason.length > 0
        ? ` (fail-closed: ${result.failClosedReason})`
        : "";
      emit({ type: "failed", reason: `ACP turn cancelled by the agent${failClosed}` });
    } else {
      emit({ type: "failed", reason: `ACP prompt returned unexpected stop reason: ${String(stopReason)}` });
    }
  }

  /** Prompt with the optional W047 turn watchdog armed (env-gated, off by default). */
  async #prompt(
    sessionId: string,
    content: readonly { readonly type: string; readonly text?: string; readonly data?: string; readonly mimeType?: string }[],
  ): Promise<unknown> {
    const timeoutMs = turnTimeoutMs();
    if (timeoutMs === undefined) return this.#client.prompt({ sessionId, prompt: content });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#client.prompt({ sessionId, prompt: content }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`ACP turn exceeded WORKFLOW_ACP_TURN_TIMEOUT_MS=${timeoutMs}ms — the agent neither finished nor died; cancel the turn or restart the session`));
            void this.cancel().catch(() => undefined);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
      return { type: "thought", text: content?.text ?? "" };
    }
    if (kind === "plan") {
      const entries = AcpSessionDriver.planEntries(update.update.entries);
      return entries.length > 0 ? { type: "plan", entries } : undefined;
    }
    if (kind === "tool_call") {
      const title = this.#toolTitle(update);
      const callId = String(update.update.toolCallId ?? "unknown");
      const toolKind = typeof update.update.kind === "string" ? update.update.kind : "other";
      const subjects = this.#locations(update);
      const rawInput = rawWireText(update.update.rawInput);
      this.#toolTitles.set(callId, title);
      this.#toolCalls.set(callId, { title, toolKind, subjects, ...(rawInput !== undefined ? { rawInput } : {}) });
      return {
        type: "tool",
        callId,
        title,
        toolKind,
        status: "pending",
        subjects,
        ...(rawInput !== undefined ? { rawInput } : {}),
      };
    }
    if (kind === "tool_call_update") {
      const status = AcpSessionDriver.toolStatus(update.update.status);
      const callId = String(update.update.toolCallId ?? "unknown");
      const rawOutput = rawWireText(update.update.rawOutput);
      const known = this.#toolCalls.get(callId);
      if (known === undefined) {
        // Update without a matching call (permission-phase echo): keep the
        // legacy projection so surfaces still see the outcome.
        const subject = this.#toolTitles.get(callId) ?? callId;
        if (status === "completed") return { type: "tool-outcome", tool: subject, outcome: "succeeded" };
        if (status === "error" || status === "cancelled") {
          return { type: "tool-outcome", tool: subject, outcome: "failed", detail: status };
        }
        return { type: "status", status: `tool ${subject}: ${status}` };
      }
      return {
        type: "tool",
        callId,
        title: known.title,
        toolKind: known.toolKind,
        status,
        subjects: known.subjects,
        ...(known.rawInput !== undefined ? { rawInput: known.rawInput } : {}),
        ...(rawOutput !== undefined ? { rawOutput } : {}),
      };
    }
    if (kind === "session_info_update") {
      const title = update.update.title;
      return typeof title === "string" && title.length > 0 ? { type: "session-info", title } : undefined;
    }
    // W047 (G7 context visibility): every other well-formed kind — standard
    // ones this projection doesn't specialize (e.g. usage_update) and all
    // agent-custom kinds — projects into the session record as advisory
    // context. Visibility only; never upgraded to control.
    return { type: "agent-context", kind, payload: update.update };
  }

  /** Tolerant ACP plan-entry parse: only well-formed entries survive. */
  static planEntries(value: unknown): { id: string; content: string; status: "pending" | "in_progress" | "completed" }[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as { id?: unknown; content?: unknown; status?: unknown };
      if (typeof record.id !== "string" || typeof record.content !== "string") return [];
      const status = record.status === "in_progress" || record.status === "completed" ? record.status : "pending";
      return [{ id: record.id, content: record.content, status }];
    });
  }

  /** Maps ACP tool statuses; unknown values stay pending so cards never guess. */
  static toolStatus(value: unknown): "pending" | "in_progress" | "completed" | "error" | "cancelled" {
    // Cline 3.0.61 sends "failed" where the ACP spec says "error"; accept both.
    if (value === "in_progress" || value === "completed" || value === "cancelled") return value;
    if (value === "error" || value === "failed") return "error";
    return "pending";
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
        taskId: this.#correlatedTaskId(),
        toolName,
        // OpenCode titles edit-permission requests with the target path, so
        // the title-derived name can be unrecognized; the ACP kind field (the
        // protocol's own discriminator) classifies those before the
        // fail-closed mutation default applies.
        capability: AcpSessionDriver.classify(toolName, request.toolCall?.kind),
      },
      authorize: (action) => this.#authorize(action),
      // Plan Task G2: the guard dispatcher gates ACP sessions identically to
      // the /before-tool route when a provider is composed into the runtime.
      ...(this.#guard === undefined ? {} : { guard: this.#guard }),
      workspaceRoot: this.#workspace,
      // Plan Task F1/F3: journal skill delivery on allowed read_skill calls.
      ...(this.#onSkillRead === undefined ? {} : { onSkillRead: this.#onSkillRead }),
    });
    return resolver(request);
  }

  /**
   * The hub-implemented ACP fs server: every delegated file operation
   * authorizes through the same proposal pipeline as a permission request
   * (subjects = the path, capability by method), passes the guard dispatcher
   * with policy parity, and only then is performed by the hub itself.
   * Rejections throw and surface to the agent as JSON-RPC errors — a denied
   * delegation is a normal outcome, exactly like a denied permission.
   */
  async #resolveFs(
    toolName: "fs/read_text_file" | "fs/write_text_file" | "fs/list_directory",
    capability: ToolCapability,
    mutating: boolean,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (typeof params.path !== "string" || params.path.trim().length === 0) {
      throw new TypeError(`ACP ${toolName} request has no path`);
    }
    const path = params.path;
    // The authorized subject and the performed path must be the identical
    // string: a relative path would be workspace-joined for authorization
    // but resolved against the hub process's cwd for the actual operation —
    // a scoping divergence. The ACP fs server spec uses absolute paths;
    // anything else fails closed here.
    if (!isAbsolute(path)) {
      throw new TypeError(`ACP ${toolName} request path must be absolute: ${path}`);
    }
    const proposal = this.#adapter.proposalFromBeforeTool({
      sessionId: this.#workflowSessionId,
      taskId: this.#correlatedTaskId(),
      toolCall: {
        name: toolName,
        kind: mutating ? "edit" : "read",
        capability,
        rawInput: params,
        locations: [{ path }],
      },
    });
    const decision = await this.#authorize(proposal);
    if (decision.kind !== "allow") {
      throw new Error(`${toolName} denied: ${decision.reason}`);
    }
    if (this.#guard !== undefined) {
      const guardInput = guardInputFromToolCall(toolName, params, this.#workspace);
      if (guardInput !== undefined) {
        let guardDecision;
        try {
          guardDecision = await this.#guard.guardCheck(guardInput);
        } catch (error) {
          throw new Error(
            `${toolName} denied (guard unavailable, fail closed): ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        if (guardDecision.decision !== "allow") {
          throw new Error(`${toolName} denied by guard policy '${guardDecision.policy}': ${guardDecision.reason}`);
        }
      }
    }
    if (toolName === "fs/write_text_file") {
      if (typeof params.content !== "string") {
        throw new TypeError("fs/write_text_file requires string content");
      }
      await writeFile(path, params.content, "utf8");
      return {};
    }
    if (toolName === "fs/read_text_file") {
      return { content: await readFile(path, "utf8") };
    }
    const entries = await readdir(path, { withFileTypes: true });
    return { entries: entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" })) };
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

  /** W046: lazy correlation — interactive surfaces re-read the application's
   * active-task pointer at proposal time. A getter that throws (no active
   * task, or the active task left IN_PROGRESS) fails the correlation, which
   * the resolver and fs path surface as a fail-closed denial — the same
   * posture as the Cline adapter's lazy correlation. */
  #correlatedTaskId(): TaskId {
    return typeof this.#taskId === "function" ? this.#taskId() : this.#taskId;
  }

  /** Title classification is fail-closed: unknown tools map to the mutation
   * capability. When the title carries no recognized tool name (OpenCode, for
   * example, titles its edit-permission requests with the target path), the
   * ACP kind field — the protocol's own discriminator — classifies the call
   * before the fail-closed default applies; unknown kinds still fail closed
   * to mutation. */
  static classify(toolName: string, kind?: string): ToolCapability {
    if (["read_file", "read_files", "list_files", "list_code_definition_names", "search_files", "search_codebase"].includes(toolName)) {
      return "read";
    }
    if (["run_commands", "execute_command", "shell", "bash"].includes(toolName)) {
      return "process";
    }
    if (["fetch_web_content", "web_fetch", "web_search"].includes(toolName)) {
      return "network";
    }
    // Skill delivery (plan Task F1) is a read: list/read tools must pass the
    // unknown-mutation fail-closed check so the delivery observation can be
    // journaled. Exact names plus the explicit skills-mcp prefix only — a
    // broad suffix match would let any server's tool dodge the
    // unknown-mutation fail-closed by naming itself *__read_skill.
    const lowered = toolName.toLowerCase();
    if (
      lowered === "list_skills" || lowered === "read_skill" ||
      lowered === "skills-mcp__list_skills" || lowered === "skills-mcp__read_skill"
    ) {
      return "read";
    }
    const kindCapability = kind !== undefined ? acpKindCapabilities[kind] : undefined;
    if (kindCapability !== undefined) return kindCapability;
    return "mutation";
  }
}

/** ACP toolCall.kind → capability. The kind is the protocol's own
 * discriminator, used when the title-derived tool name is unrecognized.
 * `other` and unknown kinds are absent on purpose: they fail closed. */
const acpKindCapabilities: Readonly<Record<string, ToolCapability>> = {
  read: "read",
  search: "read",
  think: "read",
  edit: "mutation",
  delete: "mutation",
  move: "mutation",
  execute: "process",
  fetch: "network",
};

/** Displayed tool I/O cap: cards ride the 1 s /api/session poll, so whole-file
 * dumps must not balloon every response payload. */
const RAW_WIRE_TEXT_LIMIT = 8 * 1024;

/**
 * Agents send raw tool input/output as strings OR structured JSON (Cline:
 * rawInput is a command object, rawOutput a result array); keep both as
 * displayable text without inventing content for absent fields, capped so a
 * single verbose tool call cannot dominate the polled transcript payload.
 */
function rawWireText(value: unknown): string | undefined {
  let text: string | undefined;
  if (typeof value === "string") {
    text = value.length > 0 ? value : undefined;
  } else if (typeof value === "object" && value !== null) {
    const encoded = JSON.stringify(value, null, 2);
    text = encoded.length === 0 || encoded === "{}" || encoded === "[]" ? undefined : encoded;
  }
  if (text === undefined) return undefined;
  return text.length > RAW_WIRE_TEXT_LIMIT ? `${text.slice(0, RAW_WIRE_TEXT_LIMIT)}\n… truncated` : text;
}

/** Exposed for tests: the display projection of raw tool I/O. */
export const displayRawToolText = rawWireText;

/**
 * W047 turn watchdog: an OPTIONAL, operator-armed liveness bound for agent
 * turns (a hung agent — no exit, no response — is the one failure that
 * produces no event at all). Off by default: a wrong timeout would abort
 * legitimate long turns, so the operator arms it deliberately; a malformed
 * value throws — a broken watchdog never degrades to a silent one.
 */
export function turnTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.WORKFLOW_ACP_TURN_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`WORKFLOW_ACP_TURN_TIMEOUT_MS must be a positive number of milliseconds (got ${JSON.stringify(raw)})`);
  }
  return value;
}
