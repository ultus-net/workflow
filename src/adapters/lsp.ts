import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface NormalizedDiagnostic {
  readonly code: number;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface LspRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

export interface LspDiagnostic {
  readonly range?: LspRange;
  readonly severity?: number;
  readonly code?: number | string;
  readonly message?: string;
}

export interface PublishDiagnosticsParams {
  readonly uri: string;
  readonly diagnostics: readonly LspDiagnostic[];
}

export function encodeMessage(body: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const header = Buffer.from(
    `Content-Length: ${payload.length}\r\n\r\n`,
    "ascii",
  );
  return Buffer.concat([header, payload]);
}

export function createFrameDecoder(): (chunk: Buffer) => unknown[] {
  let buffer = Buffer.alloc(0);
  return (chunk: Buffer): unknown[] => {
    buffer = Buffer.concat([buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) {
        throw new Error(`invalid LSP frame header: ${header}`);
      }
      const lengthText = match[1];
      if (lengthText === undefined) {
        throw new Error(`invalid LSP frame header: ${header}`);
      }
      const length = Number.parseInt(lengthText, 10);
      const start = headerEnd + 4;
      if (buffer.length < start + length) break;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      messages.push(JSON.parse(body));
    }
    return messages;
  };
}

function normalizeCode(code: number | string | undefined): number {
  if (typeof code === "number") return code;
  if (typeof code === "string") {
    const parsed = Number.parseInt(code, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function normalizeDiagnostics(
  uri: string,
  params: PublishDiagnosticsParams,
): NormalizedDiagnostic[] {
  const file = fileURLToPath(uri);
  const result: NormalizedDiagnostic[] = [];
  for (const diagnostic of params.diagnostics) {
    if (!diagnostic.range) continue;
    result.push({
      code: normalizeCode(diagnostic.code),
      message: diagnostic.message ?? "",
      file,
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
    });
  }
  return result;
}

export interface StartLspClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly rootUri: string;
  readonly onDiagnostics: (diagnostics: readonly NormalizedDiagnostic[]) => void;
}

export interface LspClient {
  hover(filePath: string, line: number, character: number): Promise<unknown>;
  didOpen(filePath: string, languageId: string, text: string): Promise<void>;
  close(): Promise<void>;
}

interface JsonRpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export async function startLspClient(
  options: StartLspClientOptions,
): Promise<LspClient> {
  const child: ChildProcessWithoutNullStreams = spawn(options.command, [
    ...(options.args ?? []),
  ]);

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const decode = createFrameDecoder();

  child.stdout.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decode(chunk);
    } catch {
      return;
    }
    for (const raw of messages) {
      const message = raw as JsonRpcMessage;
      if (message.id !== undefined && message.method === undefined) {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) {
            entry.reject(
              new Error(
                `LSP error ${message.error.code}: ${message.error.message}`,
              ),
            );
          } else {
            entry.resolve(message.result);
          }
        }
        continue;
      }
      if (message.method === "textDocument/publishDiagnostics") {
        const params = message.params as PublishDiagnosticsParams;
        options.onDiagnostics(normalizeDiagnostics(params.uri, params));
      }
    }
  });

  child.on("exit", () => {
    for (const entry of pending.values()) {
      entry.reject(new Error("LSP server exited"));
    }
    pending.clear();
  });

  function send(body: unknown): void {
    child.stdin.write(encodeMessage(body));
  }

  function request(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method: string, params: unknown): void {
    send({ jsonrpc: "2.0", method, params });
  }

  await request("initialize", {
    processId: process.pid,
    rootUri: options.rootUri,
    capabilities: {},
  });
  notify("initialized", {});

  return {
    hover(filePath: string, line: number, character: number): Promise<unknown> {
      return request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(filePath).href },
        position: { line: line - 1, character: character - 1 },
      });
    },

    didOpen(filePath: string, languageId: string, text: string): Promise<void> {
      notify("textDocument/didOpen", {
        textDocument: {
          uri: pathToFileURL(filePath).href,
          languageId,
          version: 1,
          text,
        },
      });
      return Promise.resolve();
    },

    async close(): Promise<void> {
      try {
        await request("shutdown", null);
      } catch {
        // Server may already be gone; proceed to exit/kill.
      }
      notify("exit", null);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

