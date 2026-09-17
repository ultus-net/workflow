export type AcpRequestId = number | string;

export type AcpSpikeMethod =
  | "initialize"
  | "authenticate"
  | "session/new"
  | "session/prompt"
  | "session/cancel"
  | "session/request_permission"
  | "fs/read_text_file"
  | "fs/write_text_file"
  | "fs/list_directory";

export type AcpNotificationMethod = "session/update";

export interface AcpWireRequest {
  readonly kind: "request";
  readonly id: AcpRequestId;
  readonly method: AcpSpikeMethod;
  readonly params?: unknown;
}

export interface AcpWireNotification {
  readonly kind: "notification";
  readonly method: AcpNotificationMethod;
  readonly params: unknown;
}

export type AcpWireMessage = AcpWireRequest | AcpWireNotification;

const spikeMethods = new Set<AcpSpikeMethod>([
  "initialize",
  "authenticate",
  "session/new",
  "session/prompt",
  "session/cancel",
  "session/request_permission",
  "fs/read_text_file",
  "fs/write_text_file",
  "fs/list_directory",
]);

export function encodeAcpMessage(message: Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`;
}

export class AcpNdjsonDecoder {
  #buffer = "";

  push(chunk: string): Record<string, unknown>[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) throw new Error("message is not an object");
          return parsed;
        } catch (error) {
          throw new TypeError(`invalid ACP NDJSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      });
  }
}

export function parseAcpMessage(message: Record<string, unknown>): AcpWireMessage {
  if (message.jsonrpc !== "2.0") throw new TypeError("invalid ACP JSON-RPC version");

  if ("method" in message) {
    if (typeof message.method !== "string") throw new TypeError("invalid ACP method");
    if ("id" in message) {
      if (typeof message.id !== "number" && typeof message.id !== "string") {
        throw new TypeError("invalid ACP request id");
      }
      const method = message.method as AcpSpikeMethod;
      if (!spikeMethods.has(method)) throw new TypeError(`unsupported ACP method: ${method}`);
      return { kind: "request", id: message.id, method, params: message.params };
    }
    if (message.method !== "session/update") throw new TypeError(`unsupported ACP method: ${message.method}`);
    if (!("params" in message)) throw new TypeError("invalid ACP notification");
    return { kind: "notification", method: "session/update", params: message.params };
  }

  throw new TypeError("unsupported ACP message");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
