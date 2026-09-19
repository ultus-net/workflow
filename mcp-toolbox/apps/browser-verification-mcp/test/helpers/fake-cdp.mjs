// Test-only fake Chrome DevTools Protocol endpoint: an HTTP /json/version
// discovery response plus a minimal WebSocket server that speaks just enough
// CDP for browser-verification-mcp. It is a mock CDP target, never a real
// browser, so these tests live-verify protocol handling and bounds without
// requiring Chrome.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

// Parse one client frame from the buffer. Returns { frame, rest } or undefined
// when more bytes are needed. Client frames are always masked.
function decodeFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) === 0x80;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
  if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { frame: { opcode, payload, fin: (first & 0x80) === 0x80 }, rest: buffer.subarray(offset + maskLength + length) };
}

export function createBrowserModel(options = {}) {
  const state = {
    url: options.url ?? "https://app.test/",
    title: options.title ?? "Fixture",
    nodes: options.nodes ?? [
      { role: "RootWebArea", name: "Fixture", value: "" },
      { role: "StaticText", name: "Hello world", value: "" },
      { role: "textbox", name: "Name", value: "" },
    ],
    consoleMessages: options.consoleMessages ?? [{ type: "log", args: [{ value: "hello" }] }],
    networkRequests: options.networkRequests ?? [{ requestId: "r1", url: "https://app.test/" }],
    traceEvents: options.traceEvents ?? [{ name: "RunTask" }],
  };
  const elements = new Map();
  let nextNodeId = 2;
  for (const [selector, value] of Object.entries(options.elements ?? {})) {
    elements.set(selector, { nodeId: nextNodeId, attributes: [], quads: [10, 10, 30, 10, 30, 30, 10, 30], ...value });
    nextNodeId += 1;
  }
  return {
    state,
    handle(method, params = {}, sessionId) {
      if ((options.hangMethods ?? []).includes(method)) return { hang: true };
      switch (method) {
        case "Target.createTarget":
          return { result: { targetId: "T1" } };
        case "Target.attachToTarget":
          return { result: { sessionId: "S1" } };
        case "Page.enable":
        case "DOM.enable":
        case "Accessibility.enable":
          return { result: {} };
        case "Target.getTargetInfo":
          return { result: { targetInfo: { targetId: "T1", url: state.url, title: state.title } } };
        case "Target.closeTarget":
          return { result: {} };
        case "Page.navigate": {
          state.url = typeof params.url === "string" ? params.url : state.url;
          state.title = options.navigateTitle ?? state.title;
          return { result: { frameId: "F1" }, events: [{ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId }] };
        }
        case "Page.getNavigationHistory":
          return { result: { currentIndex: 0, entries: [{ url: state.url, title: state.title }] } };
        case "DOM.getDocument":
          return { result: { root: { nodeId: 1 } } };
        case "DOM.querySelector": {
          const element = elements.get(params.selector);
          return { result: { nodeId: element ? element.nodeId : 0 } };
        }
        case "DOM.getContentQuads": {
          const element = [...elements.values()].find((candidate) => candidate.nodeId === params.nodeId);
          return { result: { quads: [element ? element.quads : [10, 10, 30, 10, 30, 30, 10, 30]] } };
        }
        case "DOM.getAttributes": {
          const element = [...elements.values()].find((candidate) => candidate.nodeId === params.nodeId);
          return { result: { attributes: element ? element.attributes : [] } };
        }
        case "DOM.focus":
        case "Input.dispatchMouseEvent":
        case "Input.dispatchKeyEvent":
        case "Input.insertText":
          return { result: {} };
        case "Accessibility.getFullAXTree":
          return { result: { nodes: state.nodes.map((node, index) => ({ nodeId: index + 1, ignored: false, role: { value: node.role }, name: { value: node.name }, value: { value: node.value } })) } };
        case "Page.captureScreenshot":
          return { result: { data: options.screenshotBase64 ?? TINY_PNG_BASE64 } };
        case "Runtime.enable":
          return { result: {}, events: state.consoleMessages.map((message) => ({ method: "Runtime.consoleAPICalled", params: { type: message.type, args: message.args }, sessionId })) };
        case "Network.enable":
          return { result: {}, events: state.networkRequests.map((request) => ({ method: "Network.requestWillBeSent", params: { requestId: request.requestId, request: { url: request.url } }, sessionId })) };
        case "Tracing.start":
          return { result: {} };
        case "Tracing.end":
          return {
            result: {},
            events: [
              { method: "Tracing.dataCollected", params: { value: { traceEvents: state.traceEvents } }, sessionId },
              { method: "Tracing.tracingComplete", params: {}, sessionId },
            ],
          };
        default:
          return { error: { code: -32601, message: `Method not found: ${method}` } };
      }
    },
  };
}

export async function startFakeCdpServer(model) {
  const commands = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.url === "/json/version") {
      const port = server.address().port;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Browser: "FakeChrome/1.0", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/FAKE` }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    const send = (message) => socket.write(encodeTextFrame(JSON.stringify(message)));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const decoded = decodeFrame(buffer);
        if (!decoded) break;
        buffer = decoded.rest;
        const { opcode, payload } = decoded.frame;
        if (opcode === 0x8) {
          socket.end(encodeControlFrame(0x8));
          return;
        }
        if (opcode === 0x9) {
          socket.write(encodeControlFrame(0xa, payload));
          continue;
        }
        if (opcode !== 0x1) continue;
        let message;
        try {
          message = JSON.parse(payload.toString("utf8"));
        } catch {
          continue;
        }
        if (typeof message.id !== "number" || typeof message.method !== "string") continue;
        const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
        commands.push({ method: message.method, params: message.params ?? {}, sessionId });
        const outcome = model.handle(message.method, message.params ?? {}, sessionId) ?? {};
        if (outcome.hang) continue;
        if (outcome.error) {
          send({ id: message.id, error: outcome.error });
        } else {
          send({ id: message.id, result: outcome.result ?? {} });
        }
        for (const event of outcome.events ?? []) send({ method: event.method, params: event.params ?? {}, ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }) });
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    commands,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export { TINY_PNG_BASE64 };