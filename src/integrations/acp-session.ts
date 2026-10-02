import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { CodingSessionDriver, CodingSessionEvent, CodingSessionImage } from "../application/coding-session.js";
import type { TaskId, PolicyDecision } from "../kernel/contracts.js";
import type { ProposedToolAction, ToolCapability } from "../adapters/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { fingerprintFile } from "../application/file-claim-ledger.js";
import type { ProcessContainment } from "../containment/contracts.js";
import { AcpHostAdapter } from "../adapters/acp.js";
import {
  launchContainedAcpAgent,
  launchContainedAcpAgentAsync,
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
import type { OperatorAskHold } from "./operator-ask-hold.js";
import type { PermissionBroker } from "../ui/permission-broker.js";
import { TaskUsageAttributor, type TaskUsageSummary } from "./task-usage.js";
import type { ModelUsageMetrics } from "./model-usage-proxy.js";

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
  /**
   * opencode v2 model pin. v2 ignores the config `model` for the session
   * default (`/api/model/default` behavior, migration spec §10) and defaults
   * to a built-in `opencode/*` model, which bypasses the hub proxy. When set,
   * the driver selects this model on the freshly created ACP session via
   * `session/set_config_option` so every turn rides the metered route.
   */
  #selectModel: string | undefined;
  #guard: WorkflowGuardProvider | undefined;
  /**
   * P6 seats (issue #285): the operator ask hold for the hub-implemented ACP fs
   * server. A guard `ask` on a delegated write parks here and the write waits
   * for the operator; absent → the ask fails closed (no operator channel).
   */
  #hold: OperatorAskHold | undefined;
  /** Monotonic synthesized ask id (the ACP fs wire carries no request id). */
  #fsAskSeq = 0;
  #onSkillRead: ((skill: string) => void) | undefined;
  #onToolOutcome: ((sessionId: string, outcome: "succeeded" | "failed", tool: string, reason?: string) => void) | undefined;
  #onReadFingerprint: ((fingerprint: import("../application/host.js").ReadFingerprint) => void) | undefined;
  #onTodoUpdate: ((entries: readonly { readonly id?: string; readonly content: string; readonly status: "pending" | "in_progress" | "completed" | "cancelled" }[]) => void) | undefined;
  /**
   * W111: the per-task attribution seam. When present, every `start()` turn
   * baselines the cumulative metering reading and, on a COMPLETED turn, reads
   * the active-task pointer at boundary time and publishes the delta. A
   * `failed`/`cancelled` turn publishes nothing (the `UsageTurnTracker`
   * honesty rule). Absent → the driver records no attribution.
   */
  #taskUsage: { usage: () => ModelUsageMetrics | undefined; record: (delta: Omit<TaskUsageSummary, "recordedAt">) => void } | undefined;
  #initialized = false;
  #canLoadSession = false;
  #agentInfo?: { readonly name: string; readonly version?: string } | undefined;
  #sessionCapabilities: Record<string, unknown> = {};
  #availableCommands: { readonly name: string; readonly description: string }[] = [];
  #turnTokenTotals = { input: 0, output: 0, turns: 0 };
  #agentSessionId?: string;
  #sessionConfig?: AcpSessionConfig;
  #contextWindowTokens?: number;
  #acpUsage: { used?: number; size?: number; costUsd?: number } = {};
  readonly #readFingerprints = new Map<string, import("../application/host.js").ReadFingerprint>();
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
    /**
     * opencode v2 model pin (see {@link AcpSessionDriver.#selectModel}). Set
     * only on v2 launches; absent on v1, where the config `model` selects the
     * session default.
     */
    selectModel?: string;
    adapter?: AcpHostAdapter;
    guard?: WorkflowGuardProvider;
    /**
     * P6 seats (issue #285): the operator ask hold for the hub-implemented ACP
     * fs server. When the guard returns `ask` on a delegated write, the seat
     * parks the ask here and completes the hold BEFORE performing the write
     * (approve → write; reject/timeout → refuse). Absent → the ask fails
     * closed, matching today's behavior but with honest ask provenance.
     */
    hold?: OperatorAskHold;
    /**
     * P6 (issue #285): the shared permission broker. When supplied (and no
     * explicit `hold` is), the driver backs the operator ask hold with the
     * broker's ONE answer transport — a held ask from either seat appears on
     * `/api/permission` and is answered by the same route that answers a
     * permission prompt. Scoped to this driver's `workspaceSessionId`, the key
     * the web channel polls and answers with.
     */
    permissionBroker?: PermissionBroker;
    onSkillRead?: (skill: string) => void;
    onToolOutcome?: (sessionId: string, outcome: "succeeded" | "failed", tool: string, reason?: string) => void;
    onReadFingerprint?: (fingerprint: import("../application/host.js").ReadFingerprint) => void;
    onTodoUpdate?: (entries: readonly { readonly id?: string; readonly content: string; readonly status: "pending" | "in_progress" | "completed" | "cancelled" }[]) => void;
    /**
     * W111: the per-task attribution seam (issue #283). When provided, a
     * `start()` turn baselines the cumulative metering reading and publishes
     * the per-task delta on a COMPLETED turn; `failed`/`cancelled` publish
     * nothing. The active-task pointer is the driver's existing lazy `taskId`
     * correlation, read AT boundary time (a throwing read records the
     * unattributed absence). Absent → no attribution (the lane is not wired).
     */
    taskUsage?: {
      usage: () => ModelUsageMetrics | undefined;
      record: (delta: Omit<TaskUsageSummary, "recordedAt">) => void;
    };
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
    this.#selectModel = options.selectModel;
    this.#guard = options.guard;
    // P6 (issue #285): an explicitly supplied hold wins (tests/embedding); a
    // broker-backed hold carries a seat's held ask on the broker's one answer
    // transport when a broker is composed.
    this.#hold = options.hold ?? options.permissionBroker?.askHold(options.workspaceSessionId);
    this.#onSkillRead = options.onSkillRead;
    this.#onToolOutcome = options.onToolOutcome ?? (typeof options.authorize === "function" ? undefined : (sessionId, outcome, tool, reason) => (options.authorize as WorkflowApplication).recordToolOutcome(sessionId, outcome, tool, reason));
    this.#onReadFingerprint = options.onReadFingerprint ?? (typeof options.authorize === "function" ? undefined : (fingerprint) => (options.authorize as WorkflowApplication).recordReadFingerprint(fingerprint));
    this.#onTodoUpdate = options.onTodoUpdate ?? (typeof options.authorize === "function" ? undefined : (entries) => (options.authorize as WorkflowApplication).mirrorNativeTodos(entries));
    this.#taskUsage = options.taskUsage;
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
      if (update.update.sessionUpdate === "usage_update") {
        // ACP usage_update carries context used, the window size, and cost;
        // capture them so surfaces can show how full the window is and what
        // the session cost — a meter, never a transcript message.
        const usage = update.update as { used?: unknown; size?: unknown; cost?: unknown };
        if (typeof usage.used === "number" && Number.isFinite(usage.used) && usage.used >= 0) this.#acpUsage.used = usage.used;
        if (typeof usage.size === "number" && Number.isFinite(usage.size) && usage.size > 0) {
          this.#acpUsage.size = usage.size;
          this.#contextWindowTokens = usage.size;
        }
        const cost = usage.cost as { amount?: unknown } | undefined;
        if (typeof cost?.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0) this.#acpUsage.costUsd = cost.amount;
      }
      if (update.update.sessionUpdate === "available_commands_update" && Array.isArray(update.update.availableCommands)) {
        // Slash commands the agent advertises (OpenCode: builtin init/review,
        // user commands, MCP prompts, skills). Tolerant parse: only
        // well-formed entries survive.
        this.#availableCommands = update.update.availableCommands.flatMap((command) => {
          if (typeof command !== "object" || command === null) return [];
          const entry = command as { name?: unknown; description?: unknown };
          return typeof entry.name === "string" && entry.name.length > 0
            ? [{ name: entry.name, description: typeof entry.description === "string" ? entry.description : "" }]
            : [];
        });
      }
      const event = this.#project(update, this.#assistant);
      if (event?.type === "tool") {
        if (event.status === "completed") this.#onToolOutcome?.(this.#workflowSessionId, "succeeded", event.title);
        else if (event.status === "error" || event.status === "cancelled") {
          this.#onToolOutcome?.(this.#workflowSessionId, "failed", event.title, event.status);
        }
      }
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
  static async contained(options: {
    containment: ProcessContainment;
    launch: ContainedAcpAgentLaunchOptions;
    authorize: WorkflowApplication | ((action: ProposedToolAction) => PolicyDecision | Promise<PolicyDecision>);
    workspace: string;
    workspaceSessionId: string;
    taskId: TaskId | (() => TaskId);
    resumeFrom?: string;
    /** opencode v2 model pin, passed through to the driver. */
    selectModel?: string;
    adapter?: AcpHostAdapter;
    guard?: WorkflowGuardProvider;
    /** P6 seats (issue #285): the operator ask hold, passed through to the driver. */
    hold?: OperatorAskHold;
    /** P6 (issue #285): the shared broker, passed through so the driver backs its ask hold on the broker's one answer transport. */
    permissionBroker?: PermissionBroker;
     onSkillRead?: (skill: string) => void;
      onToolOutcome?: (sessionId: string, outcome: "succeeded" | "failed", tool: string, reason?: string) => void;
      onTodoUpdate?: (entries: readonly { readonly id?: string; readonly content: string; readonly status: "pending" | "in_progress" | "completed" | "cancelled" }[]) => void;
      /** W111: the per-task attribution seam, passed through to the driver. */
      taskUsage?: {
        usage: () => ModelUsageMetrics | undefined;
        record: (delta: Omit<TaskUsageSummary, "recordedAt">) => void;
      };
   }): Promise<AcpSessionDriver> {
    // W183: prefer the async launch path so a proxied-capable backend can build
    // its forward proxy and network before the agent starts. Backends without
    // async spawn still use the synchronous path (unchanged posture).
    const child = options.containment.spawnAsync !== undefined
      ? await launchContainedAcpAgentAsync(options.containment, options.launch)
      : launchContainedAcpAgent(options.containment, options.launch);
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
      // The handshake's agentInfo is the authoritative agent identity — the
      // version string the operator surface displays as "opencode vX".
      this.#agentInfo = initialized.agentInfo;
      const sessionCapabilities = initialized.agentCapabilities["sessionCapabilities"];
      this.#sessionCapabilities = typeof sessionCapabilities === "object" && sessionCapabilities !== null
        ? sessionCapabilities as Record<string, unknown>
        : {};
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
        // opencode v2: `/api/model/default` ignores the config `model` and the
        // session otherwise defaults to a built-in `opencode/*` model that
        // bypasses the hub proxy (migration spec §10). Pin the hub-chosen
        // (metered) model explicitly so every turn rides the metered route.
        if (this.#selectModel !== undefined) {
          const pinned = await this.#client.setConfigOption({
            sessionId: session.sessionId,
            configId: "model",
            value: this.#selectModel,
          });
          this.#sessionConfig = { ...this.#sessionConfig, configOptions: pinned.configOptions };
        }
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
    // W111: the turn boundary. Baseline the lane's cumulative metering reading
    // at turn start; publish the per-task delta only on a completed turn end.
    // `failed`/`cancelled` publish nothing (the `UsageTurnTracker` rule). The
    // active-task pointer is read at `end`, never here.
    const attribution = this.#taskUsage === undefined
      ? undefined
      : new TaskUsageAttributor({
          usage: this.#taskUsage.usage,
          readTaskId: () => this.#correlatedTaskId(),
          record: this.#taskUsage.record,
        });
    attribution?.begin();
    const result = (await this.#prompt(agentSessionId, content)) as
      { stopReason?: string; failClosedReason?: string; usage?: unknown } | undefined;
    // The prompt response carries this turn's token split (OpenCode:
    // input/output/thought/cache). Per-turn deltas accumulate into session
    // totals here; the persisted baseline in the channel carries them across
    // process restarts.
    const turnUsage = result?.usage;
    if (typeof turnUsage === "object" && turnUsage !== null) {
      const split = turnUsage as Record<string, unknown>;
      const count = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
      const input = count(split["inputTokens"]);
      const output = count(split["outputTokens"]);
      if (input !== undefined) this.#turnTokenTotals.input += input;
      if (output !== undefined) this.#turnTokenTotals.output += output;
      if (input !== undefined || output !== undefined) this.#turnTokenTotals.turns += 1;
    }
    const stopReason = result?.stopReason;
    if (stopReason === "end_turn") {
      emit({ type: "completed", result: this.#assistant.join("") });
      attribution?.end(true);
    } else if (stopReason === "cancelled") {
      // W047 (G5): the wire carries the actionable cause — a fail-closed
      // permission denial (the agent had no reject option for the hub's
      // deny) reports WHY the turn died. Thread it; never discard it.
      const failClosed = typeof result?.failClosedReason === "string" && result.failClosedReason.length > 0
        ? ` (fail-closed: ${result.failClosedReason})`
        : "";
      emit({ type: "failed", reason: `ACP turn cancelled by the agent${failClosed}` });
      // W111: a cancelled turn publishes no delta (a partial bill is not an
      // honest per-turn figure) — the baseline is discarded, not recorded.
      attribution?.end(false);
    } else {
      emit({ type: "failed", reason: `ACP prompt returned unexpected stop reason: ${String(stopReason)}` });
      attribution?.end(false);
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

  /** The ACP handshake's agent identity (name + version), available once the
   * session exists. undefined until connect — honest when unknown. */
  agentInfo(): { readonly name: string; readonly version?: string } | undefined {
    return this.#agentInfo === undefined ? undefined : { ...this.#agentInfo };
  }

  /** Latest agent-reported context window size in tokens (ACP usage_update); undefined when the agent does not report it. */
  contextWindowTokens(): number | undefined {
    return this.#contextWindowTokens;
  }

  /** The key the workflow permission resolver correlates on — this runtime's
   * workspace session id. Parked permission prompts are keyed by exactly this
   * value (`ProposedToolAction.sessionId`), so the web surface must use it for
   * per-session pending/cancel lookups; the ACP agent session id is a
   * different namespace. */
  permissionSessionKey(): string {
    return this.#workflowSessionId;
  }

  /** Latest agent-reported ACP usage (context used, window size, cost) for
   * runtimes without a metering proxy (e.g. OpenCode, which manages its own
   * provider auth). */
  acpUsageSnapshot(): { readonly used?: number; readonly size?: number; readonly costUsd?: number } {
    return { ...this.#acpUsage };
  }

  /** Session management capabilities the agent advertised at initialize
   * (ACP sessionCapabilities: close/fork/list/resume on OpenCode). */
  sessionCapabilities(): { readonly close: boolean; readonly fork: boolean; readonly list: boolean; readonly resume: boolean } {
    const caps = this.#sessionCapabilities;
    return {
      close: caps["close"] !== undefined,
      fork: caps["fork"] !== undefined,
      list: caps["list"] !== undefined,
      resume: caps["resume"] !== undefined,
    };
  }

  /** Slash commands the agent advertised (available_commands_update); empty
   * until the agent sends the list. */
  availableCommands(): readonly { readonly name: string; readonly description: string }[] {
    return this.#availableCommands;
  }

  /** This process's accumulated per-turn token split from prompt responses
   * (deltas only — the channel's persisted baseline carries history). */
  turnTokenTotals(): { readonly input: number; readonly output: number; readonly turns: number } {
    return { ...this.#turnTokenTotals };
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
      try {
        this.#projectTodoUpdate(title, rawInput);
      } catch (error) {
        return { type: "status", status: `todo ledger update rejected: ${error instanceof Error ? error.message : String(error)}` };
      }
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
      // P6 (issue #285): the ACP permission-request seat parks a guard `ask`
      // on the same operator hold the fs seat uses (broker-backed when the
      // driver was composed with a broker).
      ...(this.#hold === undefined ? {} : { hold: this.#hold }),
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
         ...(mutating && this.#readFingerprints.has(path)
           ? { readFingerprints: [this.#readFingerprints.get(path)!] }
           : {}),
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
        if (guardDecision.decision === "ask") {
          // P6 seats (issue #285): a guard `ask` is a "human decides" verdict,
          // not a deny. This seat mutates in-process immediately after the guard
          // check, so the hold must complete BEFORE the write: park on the
          // operator hold, then perform the write on approval and refuse it
          // (throw, surfaced as a JSON-RPC error) on reject/timeout (fail
          // closed). With no hold attached there is no operator channel to
          // answer, so the ask fails closed (the brief's Q3 posture).
          if (this.#hold === undefined) {
            throw new Error(
              `${toolName} denied by guard policy '${guardDecision.policy}' (ask requires operator approval; no operator hold attached, failing closed): ${guardDecision.reason}`,
            );
          }
          const reply = await this.#hold.park({
            // The ACP fs wire carries no request id; the seat synthesizes one
            // and a surface answers from the hold's `pending` projection.
            requestId: `acp-fs-ask-${++this.#fsAskSeq}`,
            policy: guardDecision.policy,
            reason: guardDecision.reason,
            ...(guardDecision.matched === undefined ? {} : { matched: guardDecision.matched }),
          });
          if (reply === "reject") {
            throw new Error(
              `${toolName} denied by guard policy '${guardDecision.policy}' (operator reject or hold timeout, failing closed): ${guardDecision.reason}`,
            );
          }
          // Approved: fall through to perform the write below.
        } else if (guardDecision.decision !== "allow") {
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
      const content = await readFile(path, "utf8");
      try {
        const fingerprint = fingerprintFile(path);
        this.#readFingerprints.set(path, fingerprint);
        this.#onReadFingerprint?.(fingerprint);
      } catch { /* the next write gate remains fail-closed */ }
      return { content };
    }
    const entries = await readdir(path, { withFileTypes: true });
    return { entries: entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" })) };
  }

  /** Mirrors OpenCode's native todo tool into the canonical step bridge. */
  #projectTodoUpdate(title: string, rawInput: string | undefined): void {
    const tool = AcpSessionDriver.toolNameFromTitle(title).toLowerCase();
    if (tool !== "todo" && tool !== "todowrite") return;
    if (rawInput === undefined) return;
    let parsed: unknown;
    try { parsed = JSON.parse(rawInput) as unknown; } catch { return; }
    if (typeof parsed !== "object" || parsed === null) return;
    const todos = (parsed as Record<string, unknown>).todos;
    if (!Array.isArray(todos)) return;
    const entries = todos.flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const item = value as Record<string, unknown>;
      if (typeof item.content !== "string") return [];
      const status: "pending" | "in_progress" | "completed" | "cancelled" = item.status === "in_progress" || item.status === "completed" || item.status === "cancelled" ? item.status : "pending";
      return [{ ...(typeof item.id === "string" ? { id: item.id } : {}), content: item.content, status }];
    });
    if (entries.length > 0) this.#onTodoUpdate?.(entries);
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
