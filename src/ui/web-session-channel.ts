import type { WorkflowCodingSession } from "../application/coding-session.js";
import type { CodingSessionImage } from "../application/coding-session.js";
import type { CodingSessionState } from "../application/coding-session.js";
import type { AcpConfigOptionValue, AcpSessionConfig } from "../adapters/acp-subprocess.js";
import type { ModelUsageMetrics } from "../integrations/model-usage-proxy.js";
import { appendOperatorItem, projectOperatorSessionEvent, type OperatorSessionImage, type OperatorSessionItem } from "./operator-session.js";
import type { PermissionBroker, PermissionDecisionChoice, PermissionMode, PendingPermissionRequest } from "./permission-broker.js";
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
  readonly #broker: PermissionBroker | undefined;
  #agentTitle: string | undefined;

  constructor(
    readonly session: WorkflowCodingSession,
    driver?: ConfigCapableDriver,
    usage?: () => ModelUsageMetrics | undefined,
    broker?: PermissionBroker,
  ) {
    this.#driver = driver;
    this.#usage = usage;
    this.#broker = broker;
    session.subscribe((event) => this.ingest(event));
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

  /** Cumulative metering-proxy metrics for the session's runtime, when metered.
   * The agent-reported context window (ACP usage_update) rides along so the
   * surface can show how full the window is. */
  usage(): (ModelUsageMetrics & { readonly contextWindowTokens?: number }) | undefined {
    const metrics = this.#usage?.();
    if (metrics === undefined) return undefined;
    const contextWindowTokens = this.#driver?.contextWindowTokens?.();
    return contextWindowTokens === undefined ? metrics : { ...metrics, contextWindowTokens };
  }

  /** Operator permission-asking mode (auto when no broker is configured). */
  permissionMode(): PermissionMode {
    return this.#broker?.mode() ?? "auto";
  }

  /** Whether operator-controlled permission asking is wired to this channel. */
  permissionAskingAvailable(): boolean {
    return this.#broker !== undefined;
  }

  /** The parked permission request awaiting the operator, if any. */
  pendingPermission(): PendingPermissionRequest | undefined {
    return this.#broker?.pendingRequest();
  }

  /** Stored always-allow/always-reject tool patterns. */
  permissionPatterns(): { readonly alwaysAllow: readonly string[]; readonly alwaysReject: readonly string[] } {
    return this.#broker?.patterns() ?? { alwaysAllow: [], alwaysReject: [] };
  }

  /** Switches the operator permission mode (guarded routes call this). */
  setPermissionMode(mode: PermissionMode): void {
    this.#broker?.setMode(mode);
  }

  /** Forgets stored always-allow/always-reject decisions. */
  resetPermissionPatterns(): void {
    this.#broker?.resetPatterns();
  }

  /** Answers the parked permission request; false when unknown/stale. */
  answerPermission(id: string, choice: PermissionDecisionChoice): boolean {
    return this.#broker?.answer(id, choice) ?? false;
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
    const stored = images.map((image) => ({ id: this.#images.store(image), mediaType: image.mediaType }));
    const userImages: readonly OperatorSessionImage[] = stored;
    this.#items = appendOperatorItem(this.#items, { kind: "user", text: prompt, ...(stored.length > 0 ? { images: userImages } : {}) });
    const wire: readonly CodingSessionImage[] = images;
    void this.session.submit(prompt, wire).finally(() => { this.#turnInFlight = false; });
    return "accepted";
  }

  async cancel(): Promise<void> {
    // A cancelled turn must not leave a permission prompt dangling: the
    // agent stops waiting, so the parked request resolves as a denial.
    this.#broker?.cancelPending("turn cancelled by operator");
    await this.session.cancel();
  }
}
