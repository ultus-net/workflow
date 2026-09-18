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
  readonly state?: RemotePartState;
}

export type RemoteEngineEvent =
  | { readonly type: "permission.asked"; readonly properties: RemoteEnginePermissionRequest }
  | { readonly type: "session.status"; readonly properties: { readonly sessionID: string; readonly status?: { readonly type?: string } } }
  | { readonly type: "message.part.updated"; readonly properties: { readonly sessionID?: string; readonly part?: RemotePart } }
  | { readonly type: "message.part.delta"; readonly properties: { readonly sessionID: string; readonly messageID?: string; readonly partID?: string; readonly field?: string; readonly delta?: string } }
  | { readonly type: string; readonly properties: Record<string, unknown> };

export interface RemoteEngine {
  health(): Promise<{ readonly healthy: boolean; readonly version?: string }>;
  createSession(input: { readonly cwd: string; readonly title?: string }): Promise<{ readonly id: string }>;
  prompt(input: { readonly sessionId: string; readonly cwd: string; readonly text: string }): Promise<void>;
  abort(input: { readonly sessionId: string; readonly cwd: string }): Promise<void>;
  replyPermission(input: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly reply: RemoteEngineReply;
    readonly cwd: string;
  }): Promise<void>;
  events(input: { readonly cwd: string; readonly signal: AbortSignal }): AsyncIterable<RemoteEngineEvent>;
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
}

/** HTTP/SSE implementation of {@link RemoteEngine}. */
export class HttpRemoteEngine implements RemoteEngine {
  readonly #baseUrl: string;
  readonly #defaultCwd: string;
  readonly #auth: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: HttpRemoteEngineOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#defaultCwd = options.cwd;
    this.#auth = options.password === undefined || options.password === ""
      ? undefined
      : `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password}`).toString("base64")}`;
    this.#fetch = options.fetch ?? fetch;
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    const body = await this.#json("GET", "/global/health", { cwd: this.#defaultCwd });
    return isRecord(body) && body.healthy === true
      ? { healthy: true, ...(typeof body.version === "string" ? { version: body.version } : {}) }
      : { healthy: false };
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

  async prompt(input: { sessionId: string; cwd: string; text: string }): Promise<void> {
    await this.#json("POST", `/session/${encodeURIComponent(input.sessionId)}/message`, {
      cwd: input.cwd,
      body: { parts: [{ type: "text", text: input.text }] },
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
    await this.#json(
      "POST",
      `/api/session/${encodeURIComponent(input.sessionId)}/permission/${encodeURIComponent(input.requestId)}/reply`,
      { cwd: input.cwd, body: { reply: input.reply } },
    );
  }

  async *events(input: { cwd: string; signal: AbortSignal }): AsyncIterable<RemoteEngineEvent> {
    const response = await this.#fetch(this.#url("/global/event", input.cwd), {
      method: "GET",
      headers: { ...this.#headers(), accept: "text/event-stream" },
      signal: input.signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`remote engine event stream failed (${response.status})`);
    }
    for await (const data of sseData(response.body, input.signal)) {
      const payload = parseEventPayload(data);
      if (payload !== undefined) yield payload;
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

function parseEventPayload(data: string): RemoteEngineEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
  const envelope = isRecord(parsed) && isRecord(parsed.payload) ? parsed.payload : parsed;
  if (!isRecord(envelope) || typeof envelope.type !== "string") return undefined;
  const properties = isRecord(envelope.properties) ? envelope.properties : {};
  return { type: envelope.type, properties } as RemoteEngineEvent;
}

/** Narrows an engine event to a permission request. */
export function isPermissionAsked(
  event: RemoteEngineEvent,
): event is { readonly type: "permission.asked"; readonly properties: RemoteEnginePermissionRequest } {
  return event.type === "permission.asked";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
