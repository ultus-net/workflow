// Minimal fake LSP server for tests: framed JSON-RPC over stdio.
let buffer = Buffer.alloc(0);

function send(body) {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  process.stdout.write(`Content-Length: ${json.length}\r\n\r\n`);
  process.stdout.write(json);
}

function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { capabilities: { hoverProvider: true } },
    });
    return;
  }
  if (msg.method === "textDocument/didOpen") {
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: msg.params.textDocument.uri,
        diagnostics: [
          {
            range: {
              start: { line: 1, character: 4 },
              end: { line: 1, character: 9 },
            },
            severity: 1,
            code: 2322,
            message: "Type 'string' is not assignable to type 'number'.",
            source: "ts",
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "textDocument/hover") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { contents: { kind: "markdown", value: "hover-result" } },
    });
    return;
  }
  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "exit") {
    process.exit(0);
  }
}

function tryParse() {
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length: (\d+)/i.exec(header);
    if (!match) throw new Error("missing Content-Length");
    const length = Number.parseInt(match[1], 10);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    handleMessage(JSON.parse(body));
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  tryParse();
});
