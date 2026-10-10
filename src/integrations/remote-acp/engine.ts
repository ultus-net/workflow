/**
 * Minimal HTTP/SSE client for a remote/attached OpenCode server.
 *
 * Deliberately dependency-free: Workflow does not depend on `@opencode-ai/sdk`.
 * The bridge is the ACP agent side; this client is the upstream. Route and
 * event shapes mirror the local OpenCode checkout (see
 * `docs/OPENCODE_REMOTE_ACP_SPEC.md`).
 *
 * Advisory posture: this client makes no enforcement claim. Enforcement is a
 * property of the remote ruleset emitting `ask` plus probe evidence; see the
 * spec, section 3.
 */

import { isHealthyOpencodeBody } from "../opencode-health.js";

export type RemoteEngineReply = "once" | "always" | "reject";

export interface RemoteEnginePermissionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly save?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly tool?: { readonly callID?: string };
}

export interface RemotePartState {
  readonly status?: string;
  readonly input?: unknown;
  readonly output?: string;
  readonly title?: string;
  readonly metadata?: unknown;
}

export interface RemotePart {
  readonly id?: string;
  readonly type?: string;
  readonly sessionID?: string;
  readonly messageID?: string;
  readonly text?: string;
  readonly callID?: string;
  readonly tool?: string;
  /** V1-shaped tool parts carry the tool name here; v2 uses `tool` (guard handoff §1). */
  readonly name?: string;
  readonly state?: RemotePartState;
}

export interface RemoteMessage {
  readonly info?: {
    readonly id?: string;
    readonly role?: string;
    readonly sessionID?: string;
  };
  readonly parts?: readonly RemotePart[];
}

export interface RemoteSession {
  readonly id: string;
  readonly title?: string;
  readonly parentID?: string;
  readonly time?: { readonly updated?: number; readonly created?: number };
}

export interface RemoteAgent {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly mode?: string;
  readonly hidden?: boolean;
}

export interface RemoteModelVariant {
  readonly id: string;
  readonly name?: string;
}

export interface RemoteModel {
  readonly id: string;
  readonly name?: string;
  readonly variants: readonly RemoteModelVariant[];
}

export interface RemoteProvider {
  readonly id: string;
  readonly name?: string;
  readonly models: readonly RemoteModel[];
}

export interface RemoteCommand {
  readonly name: string;
  readonly description?: string;
}

export type RemoteEngineEvent =
  | { readonly type: "permission.asked"; readonly properties: RemoteEnginePermissionRequest }
  | { readonly type: "session.status"; readonly properties: { readonly sessionID: string; readonly status?: { readonly type?: string } } }
  | { readonly type: "message.part.updated"; readonly properties: { readonly sessionID?: string; readonly part?: RemotePart } }
  | { readonly type: "message.part.delta"; readonly properties: { readonly sessionID: string; readonly messageID?: string; readonly partID?: string; readonly field?: string; readonly delta?: string } }
  | { readonly type: string; readonly properties: Record<string, unknown> };

export interface RemotePromptInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly text: string;
  /** Agent/mode to run the turn with, when the caller selected one. */
  readonly agent?: string;
  /** Model selection, when the caller selected one. */
  readonly model?: { readonly providerID: string; readonly modelID: string; readonly variant?: string };
}

export interface RemoteEngine {
  health(): Promise<{ readonly healthy: boolean; readonly version?: string }>;
  createSession(input: { readonly cwd: string; readonly title?: string }): Promise<{ readonly id: string }>;
  getSession(input: { readonly sessionId: string; readonly cwd: string }): Promise<RemoteSession | undefined>;
  listSessions(input: { readonly cwd: string }): Promise<readonly RemoteSession[]>;
  deleteSession(input: { readonly sessionId: string; readonly cwd: string }): Promise<void>;
  messages(input: { readonly sessionId: string; readonly cwd: string }): Promise<readonly RemoteMessage[]>;
  agents(input: { readonly cwd: string }): Promise<readonly RemoteAgent[]>;
  providers(input: { readonly cwd: string }): Promise<readonly RemoteProvider[]>;
  commands(input: { readonly cwd: string }): Promise<readonly RemoteCommand[]>;
  config(input: { readonly cwd: string }): Promise<Record<string, unknown> | undefined>;
  prompt(input: RemotePromptInput): Promise<void>;
  abort(input: { readonly sessionId: string; readonly cwd: string }): Promise<void>;
  replyPermission(input: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly reply: RemoteEngineReply;
    readonly cwd: string;
  }): Promise<void>;
  /**
   * The server event subscription. An implementation reconnects a dropped
   * stream within its own bound, so the stream ends (or throws) only when the
   * caller aborts, when the route cannot be opened at all, or when that bound is
   * spent — never because a single connection died.
   */
  events(input: { readonly cwd: string; readonly signal: AbortSignal }): AsyncIterable<RemoteEngineEvent>;
}

/**
 * Bounded reconnect for the event subscription.
 *
 * A gateway keepalive (`src/integrations/opencode-server-gateway.ts`) reduces
 * ingress drops, it does not prevent them: a `content-encoding: gzip` stream
 * gets no keepalive by design, and a proxy may destroy an idle response
 * anyway. A one-shot subscription turns such a drop into a silently dead
 * session — the generator ends and nothing reports it — so `events()` re-opens
 * the route instead, bounded by an attempt count and a capped backoff. The
 * bound matters as much as the retry: a server that is genuinely gone must end
 * the subscription (taking the authority loss with it) rather than retry
 * forever or hot-loop.
 *
 * ADVISORY: transport liveness only. A re-opened route is never evidence that
 * upstream is healthy, that the hub is the authority, or that no event was
 * lost while the route was down — an SSE resume does not replay the gap.
 */
export const DEFAULT_EVENT_RECONNECT_ATTEMPTS = 10;
export const DEFAULT_EVENT_RECONNECT_BACKOFF_MS = 250;
export const EVENT_RECONNECT_MAX_BACKOFF_MS = 5_000;

/** Reconnect backoff for `attempt` (0-based): the base doubled per attempt, capped. */
export function eventReconnectBackoffMs(attempt: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** attempt, EVENT_RECONNECT_MAX_BACKOFF_MS);
}

export interface HttpRemoteEngineOptions {
  /** Base URL of the OpenCode server, e.g. `http://127.0.0.1:4096`. */
  readonly baseUrl: string;
  /** Workspace directory sent as the `directory` routing query. */
  readonly cwd: string;
  /** Basic-auth username (defaults to OpenCode's `opencode`). */
  readonly username?: string;
  /** Basic-auth password (`OPENCODE_SERVER_PASSWORD`). Never logged. */
  readonly password?: string;
  /** Injectable fetch, for tests. */
  readonly fetch?: typeof fetch;
  /**
   * Reconnect bounds for {@link HttpRemoteEngine.events}. Defaults to
   * `DEFAULT_EVENT_RECONNECT_ATTEMPTS` reconnects spaced by
   * `DEFAULT_EVENT_RECONNECT_BACKOFF_MS`. A non-integer or negative value
   * falls back to the default rather than arming a broken bound; `maxAttempts:
   * 0` restores the one-shot subscription (no reconnect at all).
   */
  readonly eventReconnect?: {
    readonly maxAttempts?: number | undefined;
    readonly backoffMs?: number | undefined;
  } | undefined;
}

/** HTTP/SSE implementation of {@link RemoteEngine}. */
export class HttpRemoteEngine implements RemoteEngine {
  readonly #baseUrl: string;
  readonly #defaultCwd: string;
  readonly #auth: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #eventReconnectAttempts: number;
  readonly #eventReconnectBackoffMs: number;

  constructor(options: HttpRemoteEngineOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#defaultCwd = options.cwd;
    this.#auth = options.password === undefined || options.password === ""
      ? undefined
      : `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password}`).toString("base64")}`;
    this.#fetch = options.fetch ?? fetch;
    const reconnect = options.eventReconnect ?? {};
    this.#eventReconnectAttempts = boundOrDefault(reconnect.maxAttempts, DEFAULT_EVENT_RECONNECT_ATTEMPTS);
    this.#eventReconnectBackoffMs = boundOrDefault(reconnect.backoffMs, DEFAULT_EVENT_RECONNECT_BACKOFF_MS);
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    // v2 answers the authenticated liveness envelope on /api/info; v1 answered
    // {healthy: true} on /global/health (v2 serves its web-UI HTML catch-all
    // there — a 200 that must never parse as healthy). A 401/403 rejects: a
    // wrong credential must surface, never degrade to unhealthy.
    let networkError: unknown;
    for (const path of ["/api/info", "/global/health"] as const) {
      let response: Response;
      try {
        response = await this.#fetch(this.#url(path, this.#defaultCwd), { method: "GET", headers: this.#headers() });
      } catch (error) {
        networkError = error;
        continue;
      }
      networkError = undefined;
      if (response.status === 401 || response.status === 403) {
        throw new Error(`remote engine GET ${path} failed (${response.status})`);
      }
      if (!response.ok) continue;
      const body: unknown = await response.json().catch(() => undefined);
      if (isHealthyOpencodeBody(path, body)) {
        const version = isRecord(body) && typeof body.version === "string" ? body.version : undefined;
        return version === undefined ? { healthy: true } : { healthy: true, version };
      }
      // 200 non-JSON (the v2 HTML catch-all) or an unexpected envelope: fall
      // through to the v1 route.
    }
    if (networkError !== undefined) throw networkError;
    return { healthy: false };
  }

  async createSession(input: { cwd: string; title?: string }): Promise<{ id: string }> {
    const body = await this.#json("POST", "/session", {
      cwd: input.cwd,
      body: input.title === undefined ? {} : { title: input.title },
    });
    if (!isRecord(body) || typeof body.id !== "string" || body.id.length === 0) {
      throw new TypeError("remote engine returned an invalid session");
    }
    return { id: body.id };
  }

  async getSession(input: { sessionId: string; cwd: string }): Promise<RemoteSession | undefined> {
    const body = await this.#json("GET", `/session/${encodeURIComponent(input.sessionId)}`, { cwd: input.cwd });
    return parseSession(body);
  }

  async listSessions(input: { cwd: string }): Promise<readonly RemoteSession[]> {
    const body = await this.#json("GET", "/session", { cwd: input.cwd });
    return asArray(body).flatMap((entry) => {
      const session = parseSession(entry);
      return session === undefined ? [] : [session];
    });
  }

  async deleteSession(input: { sessionId: string; cwd: string }): Promise<void> {
    await this.#json("DELETE", `/session/${encodeURIComponent(input.sessionId)}`, { cwd: input.cwd });
  }

  async messages(input: { sessionId: string; cwd: string }): Promise<readonly RemoteMessage[]> {
    const body = await this.#json("GET", `/session/${encodeURIComponent(input.sessionId)}/message`, { cwd: input.cwd });
    return asArray(body).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const parts = asArray(entry.parts).flatMap((part) => (isRecord(part) ? [part as RemotePart] : []));
      return [{ ...(isRecord(entry.info) ? { info: entry.info } : {}), parts }];
    });
  }

  async agents(input: { cwd: string }): Promise<readonly RemoteAgent[]> {
    const body = await this.#json("GET", "/agent", { cwd: input.cwd });
    return asArray(body).flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return [];
      return [{
        id: entry.id,
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(typeof entry.mode === "string" ? { mode: entry.mode } : {}),
        ...(typeof entry.hidden === "boolean" ? { hidden: entry.hidden } : {}),
      }];
    });
  }

  async providers(input: { cwd: string }): Promise<readonly RemoteProvider[]> {
    const body = await this.#json("GET", "/config/providers", { cwd: input.cwd });
    if (!isRecord(body)) return [];
    return asArray(body.providers).flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return [];
      const models = isRecord(entry.models)
        ? Object.values(entry.models).flatMap((model) => {
            if (!isRecord(model) || typeof model.id !== "string" || model.id.length === 0) return [];
            return [{
              id: model.id,
              ...(typeof model.name === "string" ? { name: model.name } : {}),
              variants: parseVariants(model.variants),
            }];
          })
        : [];
      return [{ id: entry.id, ...(typeof entry.name === "string" ? { name: entry.name } : {}), models }];
    });
  }

  async commands(input: { cwd: string }): Promise<readonly RemoteCommand[]> {
    const body = await this.#json("GET", "/command", { cwd: input.cwd });
    return asArray(body).flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) return [];
      return [{ name: entry.name, ...(typeof entry.description === "string" ? { description: entry.description } : {}) }];
    });
  }

  async config(input: { cwd: string }): Promise<Record<string, unknown> | undefined> {
    const body = await this.#json("GET", "/config", { cwd: input.cwd });
    return isRecord(body) ? body : undefined;
  }

  async prompt(input: RemotePromptInput): Promise<void> {
    await this.#json("POST", `/session/${encodeURIComponent(input.sessionId)}/message`, {
      cwd: input.cwd,
      body: {
        parts: [{ type: "text", text: input.text }],
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : {
          model: {
            providerID: input.model.providerID,
            modelID: input.model.modelID,
            ...(input.model.variant === undefined ? {} : { variant: input.model.variant }),
          },
        }),
      },
    });
  }

  async abort(input: { sessionId: string; cwd: string }): Promise<void> {
    await this.#json("POST", `/session/${encodeURIComponent(input.sessionId)}/abort`, { cwd: input.cwd, body: {} });
  }

  async replyPermission(input: {
    sessionId: string;
    requestId: string;
    reply: RemoteEngineReply;
    cwd: string;
  }): Promise<void> {
    // Live v2 (pinned 2.0.10) requires the field `decision`, not `reply`:
    // GET /openapi.json advertises requestBody `{ decision, message? }` with
    // required:["decision"] and additionalProperties:false, and the in-binary
    // client sends `{ decision }`. Sending `{ reply }` is a 400 (empty body),
    // which leaves the mutating tool hung `running`. The user-facing name in
    // this API stays `reply`; only the wire field maps to `decision`.
    await this.#json(
      "POST",
      `/api/session/${encodeURIComponent(input.sessionId)}/permission/${encodeURIComponent(input.requestId)}/reply`,
      { cwd: input.cwd, body: { decision: input.reply } },
    );
  }

  async *events(input: { cwd: string; signal: AbortSignal }): AsyncIterable<RemoteEngineEvent> {
    // v2 moved the JSON API (and the SSE stream) under `/api/*`; the bare
    // `/global/event` spelling is v1 and now answers with the web UI's HTML
    // catch-all — a 200 that is NOT an event stream. Try the documented v2
    // route first and fall back to the v1 spelling by content type, so the
    // subscription is live on either pinned generation. The fallback is
    // re-evaluated on every attempt, so a reconnect never inherits a stale
    // route choice.
    const open = async (path: string): Promise<Response> =>
      this.#fetch(this.#url(path, input.cwd), {
        method: "GET",
        headers: { ...this.#headers(), accept: "text/event-stream" },
        signal: input.signal,
      });
    const openStream = async (): Promise<ReadableStream<Uint8Array>> => {
      let response = await open("/api/event");
      if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        response = await open("/global/event");
      }
      if (!response.ok || response.body === null) {
        throw new Error(`remote engine event stream failed (${response.status})`);
      }
      return response.body;
    };
    for (let reconnect = 0; ; reconnect += 1) {
      const body = await openStream();
      // A dropped connection surfaces either as a clean premature end or as a
      // read error (a proxy that resets the socket mid-stream), so both are the
      // same fault here: a subscription that stopped without being told to.
      let failure: unknown;
      try {
        for await (const data of sseData(body, input.signal)) {
          const payload = parseEventPayload(data);
          if (payload !== undefined) yield payload;
        }
      } catch (error) {
        failure = error;
      }
      // A caller abort is never a fault, so it never re-opens the route.
      if (input.signal.aborted) return;
      if (reconnect >= this.#eventReconnectAttempts) {
        // The bound is reached: end the subscription. A fault is rethrown, never
        // swallowed, so the caller's stream-error path stays honest.
        if (failure !== undefined) throw failure;
        return;
      }
      await delay(eventReconnectBackoffMs(reconnect, this.#eventReconnectBackoffMs), input.signal);
      if (input.signal.aborted) return;
    }
  }

  #url(path: string, cwd: string): string {
    const url = new URL(`${this.#baseUrl}${path}`);
    url.searchParams.set("directory", cwd);
    return url.toString();
  }

  #headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.#auth === undefined ? {} : { authorization: this.#auth }),
    };
  }

  async #json(method: string, path: string, input: { cwd: string; body?: unknown }): Promise<unknown> {
    const response = await this.#fetch(this.#url(path, input.cwd), {
      method,
      headers: this.#headers(),
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`remote engine ${method} ${path} failed (${response.status})${text === "" ? "" : `: ${text.slice(0, 300)}`}`);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new TypeError(`remote engine ${method} ${path} returned invalid JSON`);
    }
  }
}

/** A reconnect bound that is not a non-negative integer is ignored, not clamped. */
function boundOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isInteger(value) || value < 0 ? fallback : value;
}

/**
 * Sleeps for the reconnect backoff, resolving early when the caller's signal
 * aborts. The timer is deliberately NOT `unref()`ed: it is always awaited, and
 * an unref'd one would let a quiet daemon exit mid-backoff.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Parses `text/event-stream` bytes into `data:` payload strings. */
export async function* sseData(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    if (signal.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data.length > 0) yield data;
      index = buffer.indexOf("\n\n");
    }
  }
}

/**
 * Normalizes the observed OpenCode event envelopes into the contract shape
 * `{ type, properties }`. Three generations are in the field:
 *
 *  - v1 (contract shape): `{ type, properties }`.
 *  - v1 SSE wrapper: `{ payload: { type, properties } }` — the historical
 *    `/global/event` spelling the transport tests pinned.
 *  - v2 (live, opencode v2.0.10): `{ id, type, location, data, durable }` — the
 *    payload rides **`data`**, never `properties`. Grounded in the v2 docs
 *    (`GET /api/session/{sessionID}/permission/{requestID}` → `{ data: Request }`)
 *    and `packages/core/src/permission.ts` (`Event.Asked` payload =
 *    `Permission.Request`). The M0.3 "pin the exact wire type by probe" item
 *    deferred this (it needed a real model turn); a live plane turn resolved it.
 *
 * Every consumer that reads the HTTP engine's stream (the authority broker, the
 * ACP projection, the event journal) reads ONLY the contract shape, so the
 * mapping happens here, once. (A separate driver, `opencode-session.ts`, has its
 * own client and does not route through this parser — see the playbook's honest
 * residuals.) A record with no string `type` returns `undefined` so a caller
 * fails closed on a malformed frame rather than the parser inventing an event.
 */
export function normalizeEventEnvelope(value: unknown): RemoteEngineEvent | undefined {
  if (!isRecord(value)) return undefined;
  // The historical `payload` wrapper may itself wrap a v2 `data` envelope, so
  // unwrap it first, then resolve the properties source on the inner record.
  const envelope = isRecord(value.payload) ? value.payload : value;
  if (typeof envelope.type !== "string") return undefined;
  const properties = isRecord(envelope.properties)
    ? envelope.properties
    : isRecord(envelope.data)
      ? envelope.data
      : isRecord(value.properties)
        ? value.properties
        : isRecord(value.data)
          ? value.data
          : {};
  return { type: envelope.type, properties } as RemoteEngineEvent;
}

function parseEventPayload(data: string): RemoteEngineEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
  return normalizeEventEnvelope(parsed);
}

/**
 * Narrows an engine event to a permission request. Accepts both wire spellings
 * the server generation may use: `permission.asked` (observed live on v2.0.10;
 * `packages/core/src/permission.ts` `Event.Asked`) and `permission.v2.asked`
 * (the sibling spelling the migration spec §2.3 recorded). Their payloads are
 * the same `Permission.Request` shape, so one handler serves both.
 */
export function isPermissionAsked(
  event: RemoteEngineEvent,
): event is { readonly type: "permission.asked"; readonly properties: RemoteEnginePermissionRequest } {
  return event.type === "permission.asked" || event.type === "permission.v2.asked";
}

/**
 * The tool-call id a permission request is about. The broker keys delivered-allow
 * coverage on it so completion observation can match the tool activity back to
 * its decision. Two wire shapes carry it:
 *
 *  - v1/ACP: `request.tool.callID` (the contract field).
 *  - v2 (live, 2.0.10): `request.source.id` — grounded in the v2 docs
 *    (`Permission.Source = { type: "tool", messageID, id }`) and the live
 *    permission event. This is the SAME value the `session.tool.*` events carry
 *    as `data.id`, so coverage correlations hold on v2.
 *
 * Returns `undefined` when neither is present; the broker falls back to a
 * session+tool coverage key, so a missing callID still covers exactly one ask.
 */
export function permissionToolCallId(request: RemoteEnginePermissionRequest): string | undefined {
  if (typeof request.tool?.callID === "string" && request.tool.callID.length > 0) return request.tool.callID;
  const source = (request as { readonly source?: unknown }).source;
  if (isRecord(source) && typeof source.id === "string" && source.id.length > 0) return source.id;
  return undefined;
}

function parseSession(value: unknown): RemoteSession | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return undefined;
  const time = isRecord(value.time) ? value.time : undefined;
  return {
    id: value.id,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.parentID === "string" ? { parentID: value.parentID } : {}),
    ...(time === undefined ? {} : {
      time: {
        ...(typeof time.created === "number" ? { created: time.created } : {}),
        ...(typeof time.updated === "number" ? { updated: time.updated } : {}),
      },
    }),
  };
}

function parseVariants(value: unknown): readonly RemoteModelVariant[] {
  const entries = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  return entries.flatMap((variant) => {
    if (!isRecord(variant) || typeof variant.id !== "string" || variant.id.length === 0) return [];
    return [{ id: variant.id, ...(typeof variant.name === "string" ? { name: variant.name } : {}) }];
  });
}

function asArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.data)) return value.data;
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
