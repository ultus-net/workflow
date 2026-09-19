import { LIMITS } from "./bounds.js";

/**
 * Minimal Chrome DevTools Protocol client.
 *
 * The only transport is CDP over a single WebSocket. There is no shell, no
 * `Runtime.evaluate` surface exposed to the caller, and no browser download:
 * the connection targets a user-provided Chrome (or one the operator points
 * at via BROWSER_VERIFICATION_CHROME_PATH).
 */

export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

export interface CdpSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (error?: Error) => void): void;
  onError(handler: (error: Error) => void): void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface Waiter {
  readonly resolve: (event: CdpEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly filter: ((event: CdpEvent) => boolean) | undefined;
}

export class CdpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "CdpError";
  }
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(event: CdpEvent) => void>>();
  private readonly waiters = new Set<Waiter>();
  private closed = false;

  constructor(private readonly socket: CdpSocket, private readonly defaultTimeoutMs: number = LIMITS.defaultCommandTimeoutMs) {
    socket.onMessage((data) => this.handleMessage(data));
    socket.onClose((error) => this.failAll(error ?? new Error("CDP connection closed.")));
    socket.onError((error) => this.failAll(error));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  on(method: string, handler: (event: CdpEvent) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(handler);
    this.listeners.set(method, set);
    return () => {
      set.delete(handler);
    };
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("CDP connection is closed."));
    const id = this.nextId;
    this.nextId += 1;
    const timeout = Math.min(timeoutMs ?? this.defaultTimeoutMs, LIMITS.maxCommandTimeoutMs);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command ${method} timed out after ${timeout}ms.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, ...(sessionId === undefined ? {} : { sessionId }), ...(Object.keys(params).length === 0 ? {} : { params }) }));
    });
  }

  waitFor(method: string, options: { timeoutMs?: number; filter?: (event: CdpEvent) => boolean } = {}): Promise<CdpEvent> {
    if (this.closed) return Promise.reject(new Error("CDP connection is closed."));
    const timeout = Math.min(options.timeoutMs ?? this.defaultTimeoutMs, LIMITS.maxNavigationTimeoutMs);
    return new Promise<CdpEvent>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        filter: options.filter,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for CDP event ${method} after ${timeout}ms.`));
        }, timeout),
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.socket.close();
    this.failAll(new Error("CDP connection closed."));
  }

  private handleMessage(data: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      this.failAll(new Error("CDP sent a non-JSON message."));
      return;
    }
    const id = message.id;
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        const error = message.error as { message?: unknown; code?: unknown };
        const text = typeof error.message === "string" ? error.message : "CDP command failed.";
        pending.reject(typeof error.code === "number" ? new CdpError(text, error.code) : new CdpError(text));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const event: CdpEvent = {
      method: message.method,
      params: (message.params as Record<string, unknown> | undefined) ?? {},
      sessionId: typeof message.sessionId === "string" ? message.sessionId : undefined,
    };
    for (const waiter of [...this.waiters]) {
      if (waiter.filter && !waiter.filter(event)) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
    for (const listener of this.listeners.get(event.method) ?? []) listener(event);
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

/** Discover the browser-level WebSocket URL from a Chrome remote-debugging endpoint. */
export async function discoverChromeWebSocket(cdpUrl: string, signal?: AbortSignal): Promise<string> {
  let endpoint: URL;
  try {
    endpoint = new URL(cdpUrl);
  } catch {
    throw new Error("BROWSER_VERIFICATION_CDP_URL must be an absolute http(s) URL.");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("BROWSER_VERIFICATION_CDP_URL must use http or https.");
  const versionUrl = new URL("/json/version", endpoint.origin);
  const response = await fetch(versionUrl, { signal: signal ?? null });
  if (!response.ok) throw new Error(`Chrome discovery failed with HTTP ${response.status}.`);
  const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== "string" || !body.webSocketDebuggerUrl.startsWith("ws")) {
    throw new Error("Chrome discovery did not return a WebSocket debugger URL.");
  }
  return body.webSocketDebuggerUrl;
}

class WebSocketCdpSocket implements CdpSocket {
  constructor(private readonly socket: WebSocket) {}

  send(data: string): void {
    this.socket.send(data);
  }
  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closing.
    }
  }
  onMessage(handler: (data: string) => void): void {
    this.socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") handler(event.data);
    });
  }
  onClose(handler: (error?: Error) => void): void {
    this.socket.addEventListener("close", () => handler());
  }
  onError(handler: (error: Error) => void): void {
    this.socket.addEventListener("error", () => handler(new Error("CDP WebSocket error.")));
  }
}

export async function connectWebSocketCdp(wsUrl: string, commandTimeoutMs?: number, openTimeoutMs = LIMITS.defaultCommandTimeoutMs): Promise<CdpClient> {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out opening the CDP WebSocket.")), openTimeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Failed to open the CDP WebSocket."));
    });
  });
  return new CdpClient(new WebSocketCdpSocket(socket), commandTimeoutMs);
}