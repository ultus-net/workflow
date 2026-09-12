import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  createFrameDecoder,
  encodeMessage,
  normalizeDiagnostics,
  startLspClient,
} from "../src/adapters/lsp.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "fake-lsp-server.mjs");

test("encodeMessage produces a Content-Length framed JSON-RPC message", () => {
  const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  const frame = encodeMessage(body);
  const text = frame.toString("utf8");
  const payload = JSON.stringify(body);
  assert.equal(
    text,
    `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`,
  );
});

test("encodeMessage counts multi-byte characters in bytes", () => {
  const body = { jsonrpc: "2.0", method: "é" };
  const frame = encodeMessage(body);
  const header = frame.subarray(0, frame.indexOf("\r\n\r\n")).toString("ascii");
  assert.match(header, /Content-Length: (\d+)/);
  const declaredText = /Content-Length: (\d+)/.exec(header)?.[1];
  assert.ok(declaredText !== undefined);
  const declared = Number.parseInt(declaredText, 10);
  assert.equal(declared, Buffer.byteLength(JSON.stringify(body), "utf8"));
});

test("frame decoder parses a single complete message", () => {
  const decode = createFrameDecoder();
  const messages = decode(encodeMessage({ jsonrpc: "2.0", id: 1, result: null }));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { jsonrpc: "2.0", id: 1, result: null });
});

test("frame decoder parses multiple messages in one chunk", () => {
  const decode = createFrameDecoder();
  const chunk = Buffer.concat([
    encodeMessage({ jsonrpc: "2.0", id: 1, result: "a" }),
    encodeMessage({ jsonrpc: "2.0", id: 2, result: "b" }),
  ]);
  const messages = decode(chunk);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { jsonrpc: "2.0", id: 1, result: "a" });
  assert.deepEqual(messages[1], { jsonrpc: "2.0", id: 2, result: "b" });
});

test("frame decoder handles messages split across chunks at arbitrary boundaries", () => {
  const decode = createFrameDecoder();
  const frame = encodeMessage({ jsonrpc: "2.0", id: 7, result: "split-é" });
  const messages: unknown[] = [];
  for (let i = 0; i < frame.length; i += 3) {
    messages.push(...decode(frame.subarray(i, i + 3)));
  }
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { jsonrpc: "2.0", id: 7, result: "split-é" });
});

test("frame decoder buffers header split from body", () => {
  const decode = createFrameDecoder();
  const frame = encodeMessage({ jsonrpc: "2.0", id: 9 });
  const headerEnd = frame.indexOf("\r\n\r\n") + 2;
  assert.deepEqual(decode(frame.subarray(0, headerEnd)), []);
  const rest = decode(frame.subarray(headerEnd));
  assert.equal(rest.length, 1);
});

test("normalizeDiagnostics converts uri and 0-based positions to DiagnosticInput shape", () => {
  const uri = pathToFileURL("/tmp/project/src/main.ts").href;
  const result = normalizeDiagnostics(uri, {
    uri,
    diagnostics: [
      {
        range: {
          start: { line: 1, character: 4 },
          end: { line: 1, character: 9 },
        },
        severity: 1,
        code: 2322,
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ],
  });
  assert.equal(result.length, 1);
  const diag = result[0];
  assert.ok(diag !== undefined);
  assert.equal(diag.file, "/tmp/project/src/main.ts");
  assert.equal(diag.line, 2);
  assert.equal(diag.column, 5);
  assert.equal(diag.code, 2322);
  assert.equal(
    diag.message,
    "Type 'string' is not assignable to type 'number'.",
  );
});

test("normalizeDiagnostics maps severity/code variants", () => {
  const uri = pathToFileURL("/tmp/a.rs").href;
  const mk = (diag: Record<string, unknown>) => ({
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    message: "m",
    ...diag,
  });
  const result = normalizeDiagnostics(uri, {
    uri,
    diagnostics: [
      mk({ code: 2345, severity: 1 }),
      mk({ code: "E0308", severity: 2 }),
      mk({ code: "42", severity: 3 }),
      mk({ severity: 4 }),
    ],
  });
  assert.equal(result[0]?.code, 2345);
  // Non-numeric string codes have no stable numeric mapping.
  assert.equal(result[1]?.code, 0);
  assert.equal(result[2]?.code, 42);
  assert.equal(result[3]?.code, 0);
  assert.equal(result.length, 4);
});

test("normalizeDiagnostics skips diagnostics without ranges", () => {
  const uri = pathToFileURL("/tmp/b.py").href;
  const result = normalizeDiagnostics(uri, {
    uri,
    diagnostics: [{ message: "no range", code: 1 }],
  });
  assert.equal(result.length, 0);
});

test("lsp client performs initialize handshake, hover, didOpen diagnostics, and close", async () => {
  const diagnostics: Array<{ code: number; message: string; file: string; line: number; column: number }> = [];
  const client = await startLspClient({
    command: process.execPath,
    args: [fixturePath],
    rootUri: pathToFileURL("/tmp/project").href,
    onDiagnostics: (batch) => diagnostics.push(...batch),
  });

  const filePath = "/tmp/project/src/main.ts";
  await client.didOpen(filePath, "typescript", "const x: number = 'hi';\n");
  const hover = await client.hover(filePath, 1, 2);
  assert.deepEqual(hover, {
    contents: { kind: "markdown", value: "hover-result" },
  });

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (diagnostics.length > 0) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.file, filePath);
  assert.equal(diagnostics[0]?.line, 2);
  assert.equal(diagnostics[0]?.column, 5);
  assert.equal(diagnostics[0]?.code, 2322);

  await client.close();
});
