import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { AcpNdjsonDecoder, encodeAcpMessage } from "./acp-wire.js";

export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities: Record<string, unknown>;
  readonly agentInfo: { readonly name: string; readonly version?: string };
}

export interface AcpSessionUpdate {
  readonly sessionId: string;
  readonly update: { readonly sessionUpdate: string; readonly [key: string]: unknown };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export type AcpPermissionDecision = { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: string };

interface AcpSubprocessClientOptions {
  readonly child: ChildProcessWithoutNullStreams;
  readonly resolvePermission?: (request: Record<string, unknown>) => Promise<AcpPermissionDecision> | AcpPermissionDecision;
}

export class AcpSubprocessClient {
  #child: ChildProcessWithoutNullStreams;
  #decoder = new AcpNdjsonDecoder();
  #utf8 = new StringDecoder("utf8");
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #updateListeners: ((update: AcpSessionUpdate) => void)[] = [];
  #updates: AcpSessionUpdate[] = [];
  #closed = false;
  #resolvePermission: NonNullable<AcpSubprocessClientOptions["resolvePermission"]>;

  constructor(options: AcpSubprocessClientOptions) {
    this.#child = options.child;
    this.#resolvePermission = options.resolvePermission ?? (() => ({ kind: "deny", reason: "no ACP permission resolver configured" }));
    this.#child.stdout.on("data", (chunk: Buffer) => this.#read(this.#utf8.write(chunk)));
    this.#child.on("exit", (code, signal) => this.#failAll(new Error(`ACP agent exited (${code ?? signal ?? "unknown"})`)));
    this.#child.on("error", (error) => this.#failAll(error));
  }

  onSessionUpdate(listener: (update: AcpSessionUpdate) => void): void {
    this.#updateListeners.push(listener);
  }

  async initialize(): Promise<AcpInitializeResult> {
    const result = await this.#request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "workflow-hub-acp-spike", version: "0.0.0" },
    });
    const record = requireRecord(result, "invalid ACP initialize result");
    const agentInfo = requireRecord(record.agentInfo, "invalid ACP agent info");
    if (record.protocolVersion !== 1 || typeof agentInfo.name !== "string") {
      throw new TypeError("invalid ACP initialize result");
    }
    return {
      protocolVersion: 1,
      agentCapabilities: isRecord(record.agentCapabilities) ? record.agentCapabilities : {},
      agentInfo: typeof agentInfo.version === "string" ? { name: agentInfo.name, version: agentInfo.version } : { name: agentInfo.name },
    };
  }

  async authenticate(options: { readonly methodId: string }): Promise<void> {
    await this.#request("authenticate", options);
  }

  async newSession(options: { readonly cwd: string }): Promise<{ readonly sessionId: string }> {
    const result = await this.#request("session/new", { cwd: options.cwd, mcpServers: [] });
    const record = requireRecord(result, "invalid ACP session result");
    if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
      throw new TypeError("invalid ACP session result");
    }
    return { sessionId: record.sessionId };
  }

  prompt(options: {
    readonly sessionId: string;
    readonly prompt: readonly { readonly type: string; readonly text: string }[];
  }): Promise<unknown> {
    return this.#request("session/prompt", options);
  }

  async cancel(options: { readonly sessionId: string }): Promise<void> {
    this.#send({ jsonrpc: "2.0", method: "session/cancel", params: options });
  }

  async waitForUpdates(count: number, timeoutMs = 1000): Promise<void> {
    const started = Date.now();
    while (this.#updates.length < count) {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${count} ACP session updates`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    this.#child.kill();
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  #send(message: Record<string, unknown>): void {
    if (this.#closed) throw new Error("ACP client is closed");
    this.#child.stdin.write(encodeAcpMessage(message));
  }

  #read(chunk: string): void {
    let messages: Record<string, unknown>[];
    try {
      messages = this.#decoder.push(chunk);
    } catch (error) {
      this.#failAll(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const message of messages) {
      if (message.method === "session/update") {
        const params = requireRecord(message.params, "invalid ACP session update");
        const update = requireRecord(params.update, "invalid ACP session update");
        if (typeof params.sessionId !== "string" || typeof update.sessionUpdate !== "string") {
          this.#failAll(new TypeError("invalid ACP session update"));
          continue;
        }
        const projected = { sessionId: params.sessionId, update } as AcpSessionUpdate;
        this.#updates.push(projected);
        for (const listener of this.#updateListeners) listener(projected);
        continue;
      }
      const id = message.id;
      if (message.method === "session/request_permission" && (typeof id === "number" || typeof id === "string")) {
        void this.#answerPermission(id, message);
        continue;
      }
      if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        if ("error" in message) {
          pending.reject(new Error(`ACP request failed: ${JSON.stringify(message.error)}`));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  async #answerPermission(id: number | string, message: Record<string, unknown>): Promise<void> {
    try {
      // Resolvers receive the ACP RequestPermissionRequest params (sessionId,
      // toolCall, options), not the JSON-RPC envelope.
      const params = requireRecord(message.params, "invalid ACP permission request");
      const decision = await this.#resolvePermission(params);
      const options = Array.isArray(params.options) ? params.options : [];
      const selected = selectPermissionOption(options, decision.kind);
      const outcome = selected ? { outcome: "selected", optionId: selected } : { outcome: "cancelled" };
      this.#send({ jsonrpc: "2.0", id, result: { outcome } });
    } catch (error) {
      this.#send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      this.#failAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function selectPermissionOption(options: unknown[], kind: "allow" | "deny"): string | undefined {
  const wanted = kind === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const option of options) {
    if (!isRecord(option)) throw new TypeError("invalid ACP permission option");
    if (typeof option.optionId === "string" && option.optionId.length > 0 && wanted.includes(String(option.kind))) {
      return option.optionId;
    }
  }
  return undefined;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
