import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import { AcpNdjsonDecoder, encodeAcpMessage } from "./acp-wire.js";
import type { AcpPermissionRequestParams } from "./acp-permission.js";

export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities: Record<string, unknown>;
  readonly agentInfo?: { readonly name: string; readonly version?: string };
}

export interface AcpSessionUpdate {
  readonly sessionId: string;
  readonly update: { readonly sessionUpdate: string; readonly [key: string]: unknown };
}

/** Agent-supplied option lists from `session/new`; unknown shapes pass through untouched. */
export interface AcpSessionConfig {
  readonly availableModes?: unknown;
  readonly availableModels?: unknown;
  readonly configOptions?: unknown;
}

export interface AcpNewSessionResult {
  readonly sessionId: string;
  readonly config: AcpSessionConfig;
}

export type AcpConfigOptionValue = string | boolean;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export type AcpPermissionDecision = { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: string };

interface AcpSubprocessClientOptions {
  readonly child: ChildProcessWithoutNullStreams;
  readonly resolvePermission?: (request: AcpPermissionRequestParams) => Promise<AcpPermissionDecision> | AcpPermissionDecision;
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
    const result = await this.#request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
      clientInfo: { name: "workflow-hub-acp-spike", version: "0.0.0" },
    });
    const record = requireRecord(result, "invalid ACP initialize result");
    if (record.protocolVersion !== 1) {
      throw new TypeError("invalid ACP initialize result");
    }
    const initialized: AcpInitializeResult = {
      protocolVersion: 1,
      agentCapabilities: isRecord(record.agentCapabilities) ? record.agentCapabilities : {},
    };
    if (record.agentInfo === undefined) return initialized;
    const agentInfo = requireRecord(record.agentInfo, "invalid ACP agent info");
    if (typeof agentInfo.name !== "string") throw new TypeError("invalid ACP agent info");
    return {
      ...initialized,
      agentInfo: typeof agentInfo.version === "string" ? { name: agentInfo.name, version: agentInfo.version } : { name: agentInfo.name },
    };
  }

  async authenticate(options: { readonly methodId: string }): Promise<void> {
    await this.#request("authenticate", options);
  }

  async newSession(options: { readonly cwd: string }): Promise<AcpNewSessionResult> {
    const result = await this.#request(methods.agent.session.new, { cwd: options.cwd, mcpServers: [] });
    const record = requireRecord(result, "invalid ACP session result");
    if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
      throw new TypeError("invalid ACP session result");
    }
    // G2's slash-command replacement: agent-supplied mode/model/config
    // selections pass through untouched so surfaces can enumerate them.
    const config: AcpSessionConfig = {
      ...(record.availableModes !== undefined ? { availableModes: record.availableModes } : {}),
      ...(record.availableModels !== undefined ? { availableModels: record.availableModels } : {}),
      ...(record.configOptions !== undefined ? { configOptions: record.configOptions } : {}),
    };
    return { sessionId: record.sessionId, config };
  }

  /**
   * Loads a persisted session; per spec the agent replays the full
   * conversation as session/update notifications before resolving, so
   * listeners registered via onSessionUpdate observe the replayed history.
   */
  async loadSession(options: { readonly sessionId: string; readonly cwd: string }): Promise<AcpSessionConfig> {
    const result = await this.#request(methods.agent.session.load, { sessionId: options.sessionId, cwd: options.cwd, mcpServers: [] });
    if (result === null || result === undefined) return {};
    const record = requireRecord(result, "invalid ACP session/load result");
    return {
      ...(record.availableModes !== undefined ? { availableModes: record.availableModes } : {}),
      ...(record.availableModels !== undefined ? { availableModels: record.availableModels } : {}),
      ...(record.configOptions !== undefined ? { configOptions: record.configOptions } : {}),
    };
  }

  async setConfigOption(options: {
    readonly sessionId: string;
    readonly configId: string;
    readonly value: AcpConfigOptionValue;
  }): Promise<AcpSessionConfig> {
    const result = requireRecord(await this.#request(methods.agent.session.setConfigOption, options), "invalid ACP config result");
    if (!Array.isArray(result.configOptions)) throw new TypeError("invalid ACP config result");
    return { configOptions: result.configOptions };
  }

  prompt(options: {
    readonly sessionId: string;
    readonly prompt: readonly { readonly type: string; readonly text?: string; readonly data?: string; readonly mimeType?: string }[];
  }): Promise<unknown> {
    return this.#request(methods.agent.session.prompt, options);
  }

  async cancel(options: { readonly sessionId: string }): Promise<void> {
    this.#send({ jsonrpc: "2.0", method: methods.agent.session.cancel, params: options });
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
    if (this.#closed) throw new Error("ACP client is closed");
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
      try {
        validateInboundEnvelope(message);
        if (message.method === methods.client.session.update) {
          const params = requireRecord(message.params, "invalid ACP session update");
          const update = requireRecord(params.update, "invalid ACP session update");
          if (typeof params.sessionId !== "string" || typeof update.sessionUpdate !== "string") {
            throw new TypeError("invalid ACP session update");
          }
          if (update.sessionUpdate === "config_option_update" && !Array.isArray(update.configOptions)) {
            throw new TypeError("invalid ACP config option update");
          }
          const projected = { sessionId: params.sessionId, update } as AcpSessionUpdate;
          this.#updates.push(projected);
          for (const listener of this.#updateListeners) listener(projected);
          continue;
        }
        const id = message.id;
        if (message.method === methods.client.session.requestPermission) {
          if (typeof id !== "number" && typeof id !== "string") throw new TypeError("invalid ACP permission request id");
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
      } catch (error) {
        this.#failAll(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  async #answerPermission(id: number | string, message: Record<string, unknown>): Promise<void> {
    try {
      // Resolvers receive the ACP RequestPermissionRequest params (sessionId,
      // toolCall, options), not the JSON-RPC envelope. The resolver's own
      // correlation layer validates the shape; the envelope-vs-params
      // distinction is what this type boundary enforces.
      const params = requireRecord(message.params, "invalid ACP permission request");
      const decision = await this.#resolvePermission(params as unknown as AcpPermissionRequestParams);
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
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.destroy();
    this.#child.kill();
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

function validateInboundEnvelope(message: Record<string, unknown>): void {
  if (message.jsonrpc !== "2.0") throw new TypeError("invalid ACP JSON-RPC version");
  if ("method" in message) {
    if (typeof message.method !== "string") throw new TypeError("invalid ACP method");
    if (message.method !== "session/update" && message.method !== "session/request_permission") {
      throw new TypeError(`unsupported ACP method: ${message.method}`);
    }
    if (message.method === "session/update" && "id" in message) throw new TypeError("invalid ACP notification");
    if (message.method === "session/request_permission" && typeof message.id !== "number" && typeof message.id !== "string") {
      throw new TypeError("invalid ACP permission request id");
    }
    return;
  }
  if (typeof message.id !== "number") throw new TypeError("invalid ACP response id");
  if (("result" in message) === ("error" in message)) throw new TypeError("invalid ACP response");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
