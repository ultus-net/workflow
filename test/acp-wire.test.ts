import assert from "node:assert/strict";
import test from "node:test";

import { AcpNdjsonDecoder, encodeAcpMessage, parseAcpMessage } from "../src/adapters/acp-wire.js";

test("ACP wire encodes one JSON-RPC message per NDJSON line", () => {
  const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } };

  assert.equal(encodeAcpMessage(message), `${JSON.stringify(message)}\n`);
});

test("ACP wire decoder parses messages split across arbitrary chunk boundaries", () => {
  const decoder = new AcpNdjsonDecoder();
  const encoded = encodeAcpMessage({ jsonrpc: "2.0", id: "request-é", result: { protocolVersion: 1 } });
  const first = encoded.slice(0, 7);
  const second = encoded.slice(7, -3);
  const third = encoded.slice(-3);

  assert.deepEqual(decoder.push(first), []);
  assert.deepEqual(decoder.push(second), []);
  assert.deepEqual(decoder.push(third), [{ jsonrpc: "2.0", id: "request-é", result: { protocolVersion: 1 } }]);
});

test("ACP wire decoder rejects malformed NDJSON lines fail-closed", () => {
  const decoder = new AcpNdjsonDecoder();

  assert.throws(() => decoder.push('{"jsonrpc":"2.0","id":1\n'), /invalid ACP NDJSON/);
});

test("ACP wire parses the minimal spike request methods", () => {
  assert.deepEqual(parseAcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }), {
    kind: "request",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  assert.equal(
    parseAcpMessage({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/repo" } }).kind,
    "request",
  );
  assert.equal(
    parseAcpMessage({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s" } }).kind,
    "request",
  );
  assert.equal(
    parseAcpMessage({ jsonrpc: "2.0", id: 4, method: "session/cancel", params: { sessionId: "s" } }).kind,
    "request",
  );
  assert.equal(
    parseAcpMessage({ jsonrpc: "2.0", id: 5, method: "session/request_permission", params: { sessionId: "s" } }).kind,
    "request",
  );
});

test("ACP wire parses session update as a notification", () => {
  assert.deepEqual(
    parseAcpMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } },
    }),
    {
      kind: "notification",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      },
    },
  );
});

test("ACP wire rejects unknown or malformed safety-relevant messages", () => {
  assert.throws(() => parseAcpMessage({ jsonrpc: "2.0", id: 1, method: "session/delete" }), /unsupported ACP method/);
  assert.throws(() => parseAcpMessage({ jsonrpc: "2.0", method: "session/update" }), /invalid ACP notification/);
  assert.throws(() => parseAcpMessage({ jsonrpc: "2.0", id: true, method: "initialize", params: {} }), /invalid ACP request id/);
});
