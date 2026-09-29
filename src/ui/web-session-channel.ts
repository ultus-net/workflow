import type { WorkflowCodingSession } from "../application/coding-session.js";
import type { CodingSessionImage } from "../application/coding-session.js";
import type { CodingSessionState } from "../application/coding-session.js";
import type { AcpConfigOptionValue, AcpSessionConfig } from "../adapters/acp-subprocess.js";
import type { ModelUsageMetrics } from "../integrations/model-usage-proxy.js";
import { appendOperatorItem, projectOperatorSessionEvent, type OperatorSessionImage, type OperatorSessionItem } from "./operator-session.js";
import { sanitizeControlPlaneText } from "../application/text-hygiene.js";
import type { PermissionBroker, PermissionDecisionChoice, PermissionMode, PermissionPatterns, PendingPermissionRequest } from "./permission-broker.js";
import { normalizeConfigOptions, type WebConfigOption } from "./web-config-options.js";

/** Four images at ≤ 5 MB base64 payload each, plus the prompt body margin. */
export const PROMPT_BODY_LIMIT = 24 * 1024 * 1024;
export const MAX_PROMPT_IMAGES = 4;
const MAX_IMAGE_DATA_CHARS = 7_000_000;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export interface PromptImage {
  readonly mediaType: string;
  readonly data: string;
}

/** The session usage readout served to the webapp. Metered runtimes (Cline
 * through the usage proxy) carry the full counters; unmetered runtimes
 * (OpenCode, own provider auth) carry what the agent reports over ACP — the
 * usage_update context/cost plus the prompt-response token split. Absent
 * fields stay absent, because unknown is not zero. The `source` marker
 * matters for restart merges: metered counters are per-process (sum with the
 * persisted baseline), while agent-reported cost is session-cumulative in the
 * agent's own store (the live report supersedes the baseline). */
export interface SessionUsageReadout {
  readonly source?: "metered" | "agent" | undefined;
  readonly requests?: number;
  readonly usageEvents?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly latestPromptTokens?: number | undefined;
  readonly costUsd?: number;
  readonly contextWindowTokens?: number;
}

/** Bounded FIFO store so images stay fetchable without bloating the polled transcript. */
class ImageStore {
  #entries = new Map<string, { readonly mediaType: string; readonly data: string }>();
  #nextId = 0;

  get(id: string): { readonly mediaType: string; readonly data: string } | undefined {
    return this.#entries.get(id);
  }

  store(image: PromptImage): string {
    this.#nextId += 1;
    const id = `${this.#prefix}${this.#nextId}`;
    this.#entries.set(id, image);
    while (this.#entries.size > 24) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return id;
  }

  readonly #prefix: string;

  constructor(prefix: string) {
    this.#prefix = prefix;
  }
}

export function isPromptRequest(value: unknown): value is { prompt: string; images?: PromptImage[] } {
  if (typeof value !== "object" || value === null) return false;
  const prompt = (value as Record<string, unknown>).prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > 100_000) return false;
  const images = (value as Record<string, unknown>).images;
  if (images === undefined) return true;
  if (!Array.isArray(images) || images.length > MAX_PROMPT_IMAGES) return false;
  return images.every((image) =>
    typeof image === "object" && image !== null &&
    ALLOWED_IMAGE_TYPES.has((image as PromptImage).mediaType) &&
    typeof (image as PromptImage).data === "string" &&
    (image as PromptImage).data.length > 0 &&
    (image as PromptImage).data.length <= MAX_IMAGE_DATA_CHARS &&
    BASE64_PATTERN.test((image as PromptImage).data),
  );
}

/**
 * Minimal driver surface for session configuration. Optional: the
 * single-session server path has no ACP driver, and agents may advertise no
 * options at all — both yield an empty option list.
 */
export interface ConfigCapableDriver {
  config(): AcpSessionConfig | undefined;
  setConfigOption(configId: string, value: AcpConfigOptionValue): Promise<AcpSessionConfig>;
  /** Agent-reported context window size (ACP usage_update), when advertised. */
  contextWindowTokens?(): number | undefined;
  /** Agent-reported ACP usage (used/size/cost) for runtimes with no metering proxy. */
  acpUsageSnapshot?(): { readonly used?: number; readonly size?: number; readonly costUsd?: number };
  /** The ACP handshake's agent identity (name + version), once connected. */
  agentInfo?(): { readonly name: string; readonly version?: string } | undefined;
  /** Session management capabilities from the handshake (close/fork/list/resume). */
  sessionCapabilities?(): { readonly close: boolean; readonly fork: boolean; readonly list: boolean; readonly resume: boolean };
  /** Slash commands the agent advertised (available_commands_update). */
  availableCommands?(): readonly { readonly name: string; readonly description: string }[];
  /** This process's accumulated per-turn token split from prompt responses. */
  turnTokenTotals?(): { readonly input: number; readonly output: number; readonly turns: number };
  /** The workflow permission-correlation session id (the key parked prompts
   * carry) — distinct from the ACP agent session id. */
  permissionSessionKey?(): string | undefined;
  /** The ACP agent session id, when connected. */
  agentSessionId?(): string | undefined;
}

/** One stable permission key per driver: the workflow correlation id the
 * broker parks under, falling back to the agent session id for fakes. */
export function driverPermissionKey(driver: unknown): string | undefined {
  const candidate = driver as { permissionSessionKey?(): string | undefined; agentSessionId?(): string | undefined };
  return candidate.permissionSessionKey?.() ?? candidate.agentSessionId?.();
}

/**
 * One live chat channel: the operator transcript, turn serialization, and the
 * image store for a single coding session. The transcript records user turns
 * locally; assistant activity arrives through the session subscription.
 */
export class SessionChannel {
  #items: OperatorSessionItem[] = [];
  #turnInFlight = false;
  readonly #images = new ImageStore(`img-${Math.random().toString(36).slice(2, 8)}-`);
  readonly #driver: ConfigCapableDriver | undefined;
  readonly #usage: (() => ModelUsageMetrics | undefined) | undefined;
  readonly #budget: { readonly mechanism: () => string; readonly violation?: () => string | undefined } | undefined;
  readonly #broker: PermissionBroker | undefined;
  /** Scopes parked permission prompts to this channel's ACP session once the
   * driver knows its id (parallel runtimes park independently). */
  readonly #permissionKey: (() => string | undefined) | undefined;
  /** Persisted usage from an earlier process, merged so the meter survives restarts. */
  readonly #baselineUsage: SessionUsageReadout | undefined;
  #agentTitle: string | undefined;

  constructor(
    readonly session: WorkflowCodingSession,
    driver?: ConfigCapableDriver,
    usage?: () => ModelUsageMetrics | undefined,
    broker?: PermissionBroker,
    permissionKey?: () => string | undefined,
    budget?: { readonly mechanism: () => string; readonly violation?: () => string | undefined },
    baselineUsage?: SessionUsageReadout,
  ) {
    this.#driver = driver;
    this.#usage = usage;
    this.#budget = budget;
    this.#broker = broker;
    this.#permissionKey = permissionKey;
    this.#baselineUsage = baselineUsage;
    session.subscribe((event) => this.ingest(event));
  }

  /** W045: the budget enforcement mechanism active for this session's runtime. */
  budgetMechanism(): string | undefined {
    return this.#budget?.mechanism();
  }

  /** W045: the sticky session-budget violation, once crossed. */
  budgetViolation(): string | undefined {
    return this.#budget?.violation?.();
  }

  /** Agent-advertised configuration options (empty until the session exists / if none advertised). */
  configOptions(): WebConfigOption[] {
    return normalizeConfigOptions(this.#driver?.config());
  }

  /** Mutate one option on the live agent session; returns the full updated list. */
  async setConfigOption(configId: string, value: AcpConfigOptionValue): Promise<WebConfigOption[]> {
    if (this.#driver === undefined) throw new Error("session configuration unavailable");
    return normalizeConfigOptions(await this.#driver.setConfigOption(configId, value));
  }

  /** Latest agent-provided session title (session_info_update), if any. */
  agentTitle(): string | undefined {
    return this.#agentTitle;
  }

  /** The live ACP handshake's agent identity (name + handshake version), or
   * undefined when the session has not connected / does not report one. */
  agentInfo(): { readonly name: string; readonly version?: string } | undefined {
    return this.#driver?.agentInfo?.();
  }

  /** Session usage for the readout, merged with the persisted baseline so the
   * numbers survive server restarts. Live sources: metered runtimes (Cline
   * via the usage proxy) report full per-process counters; unmetered runtimes
   * (OpenCode) report the ACP usage_update (context/cost, session-cumulative
   * in the agent's own store) plus the prompt-response token split. Merge
   * rules: per-process counters sum with the baseline; point-in-time fields
   * (context used/window) prefer the live report. Cost is source-aware: when
   * both sides come from the agent's own store (same session, new process),
   * the live cumulative report supersedes the baseline; when the sources
   * differ (e.g. the session moved between agents), the spend is disjoint and
   * the honest total is the sum. */
  usage(): SessionUsageReadout | undefined {
    const live = this.#liveUsage();
    const base = this.#baselineUsage;
    if (base === undefined) return live;
    if (live === undefined) return base;
    const sum = (a: number | undefined, b: number | undefined): number | undefined =>
      a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    const requests = sum(live.requests, base.requests);
    const usageEvents = sum(live.usageEvents, base.usageEvents);
    const promptTokens = sum(live.promptTokens, base.promptTokens);
    const completionTokens = sum(live.completionTokens, base.completionTokens);
    const totalTokens = sum(live.totalTokens, base.totalTokens);
    const latestPromptTokens = live.latestPromptTokens ?? base.latestPromptTokens;
    const contextWindowTokens = live.contextWindowTokens ?? base.contextWindowTokens;
    const cost = live.source === "agent" && base.source === "agent"
      ? live.costUsd ?? base.costUsd
      : sum(live.costUsd, base.costUsd);
    return {
      source: live.source ?? base.source,
      ...(requests !== undefined ? { requests } : {}),
      ...(usageEvents !== undefined ? { usageEvents } : {}),
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(latestPromptTokens !== undefined ? { latestPromptTokens } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
    };
  }

  /** The live readout before baseline merging; undefined when nothing has
   * been reported this process. */
  #liveUsage(): SessionUsageReadout | undefined {
    const metrics = this.#usage?.();
    const contextWindowTokens = this.#driver?.contextWindowTokens?.();
    if (metrics !== undefined) {
      return {
        source: "metered",
        ...metrics,
        ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      };
    }
    const acp = this.#driver?.acpUsageSnapshot?.();
    const split = this.#driver?.turnTokenTotals?.();
    const hasSplit = split !== undefined && split.turns > 0;
    if ((acp === undefined || (acp.used === undefined && acp.costUsd === undefined)) && !hasSplit) return undefined;
    const window = contextWindowTokens ?? acp?.size;
    return {
      source: "agent",
      ...(hasSplit ? {
        requests: split.turns,
        promptTokens: split.input,
        completionTokens: split.output,
        totalTokens: split.input + split.output,
      } : {}),
      ...(acp?.used !== undefined ? { latestPromptTokens: acp.used } : {}),
      ...(acp?.costUsd !== undefined ? { costUsd: acp.costUsd } : {}),
      ...(window !== undefined ? { contextWindowTokens: window } : {}),
    };
  }

  /** Slash commands the live agent advertised (available_commands_update). */
  availableCommands(): readonly { readonly name: string; readonly description: string }[] {
    return this.#driver?.availableCommands?.() ?? [];
  }

  /** Session management capabilities the live agent advertised at initialize. */
  sessionCapabilities(): { readonly close: boolean; readonly fork: boolean; readonly list: boolean; readonly resume: boolean } | undefined {
    return this.#driver?.sessionCapabilities?.();
  }

  /** Operator permission-asking mode (auto when no broker is configured). */
  permissionMode(): PermissionMode {
    return this.#broker?.mode() ?? "auto";
  }

  /** Whether operator-controlled permission asking is wired to this channel. */
  permissionAskingAvailable(): boolean {
    return this.#broker !== undefined;
  }

  /** The parked permission request awaiting the operator for this session, if any. */
  pendingPermission(): PendingPermissionRequest | undefined {
    return this.#broker?.pendingRequest(this.#permissionKey?.());
  }

  /** Stored always-allow/always-reject tool patterns plus (W112) the grant
   * lifecycle records (additive only — the W115 transport-view discipline). */
  permissionPatterns(): PermissionPatterns {
    return this.#broker?.patterns() ?? { alwaysAllow: [], alwaysReject: [], grants: [] };
  }

  /** Switches the operator permission mode (guarded routes call this). */
  setPermissionMode(mode: PermissionMode): void {
    this.#broker?.setMode(mode);
  }

  /** Forgets stored always-allow/always-reject decisions. */
  resetPermissionPatterns(): void {
    this.#broker?.resetPatterns();
  }

  /** Answers the parked permission request; false when unknown/stale or
   * (W141) owned by another session's park. The channel's own permission key
   * scopes the answer — the poll is session-scoped, so the answer is too. */
  answerPermission(id: string, choice: PermissionDecisionChoice): boolean {
    return this.#broker?.answer(id, choice, this.#permissionKey?.()) ?? false;
  }

  /** Projects one raw session event into the transcript (used for session/load replays). */
  ingest(event: Parameters<typeof projectOperatorSessionEvent>[0]): void {
    if (event.type === "session-info") {
      this.#agentTitle = event.title;
      return;
    }
    const item = projectOperatorSessionEvent(event);
    if (item) this.#items = appendOperatorItem(this.#items, item);
  }

  items(): readonly OperatorSessionItem[] {
    return this.#items;
  }

  state(): CodingSessionState {
    return this.session.snapshot();
  }

  image(id: string): { readonly mediaType: string; readonly data: string } | undefined {
    return this.#images.get(id);
  }

  busy(): boolean {
    return this.#turnInFlight;
  }

  submit(prompt: string, images: readonly PromptImage[]): "accepted" | "busy" {
    if (this.#turnInFlight) return "busy";
    this.#turnInFlight = true;
    // W138: sanitize BEFORE the transcript stores and the session receives —
    // the operator's transcript shows exactly what the agent gets, never a
    // raw projection of text the strip removed. (The session's own submit
    // sanitizes again; the function is idempotent.)
    const { text } = sanitizeControlPlaneText(prompt);
    const stored = images.map((image) => ({ id: this.#images.store(image), mediaType: image.mediaType }));
    const userImages: readonly OperatorSessionImage[] = stored;
    this.#items = appendOperatorItem(this.#items, { kind: "user", text, ...(stored.length > 0 ? { images: userImages } : {}) });
    const wire: readonly CodingSessionImage[] = images;
    void this.session.submit(text, wire).finally(() => { this.#turnInFlight = false; });
    return "accepted";
  }

  async cancel(): Promise<void> {
    // A cancelled turn must not leave a permission prompt dangling: the
    // agent stops waiting, so the parked request resolves as a denial —
    // only this session's prompts, never a parallel session's.
    this.#broker?.cancelPending("turn cancelled by operator", this.#permissionKey?.());
    await this.session.cancel();
  }
}
