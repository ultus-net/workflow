import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AcpSubprocessClient } from "../src/adapters/acp-subprocess.js";

test("ACP subprocess client preserves multi-byte UTF-8 split across stdout byte chunks", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const child = new PassThrough() as unknown as ConstructorParameters<typeof AcpSubprocessClient>[0]["child"];
  Object.defineProperties(child, {
    stdout: { value: stdout },
    stdin: { value: stdin },
    on: { value: () => child },
    kill: { value: () => true },
  });
  stdin.resume();

  const client = new AcpSubprocessClient({ child });
  const initialize = client.initialize();
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "fake-é-agent", version: "0.0.0" },
    },
  }) + "\n";
  const bytes = Buffer.from(payload, "utf8");
  const utf8Bytes = Buffer.from("é", "utf8");
  const splitAt = bytes.indexOf(utf8Bytes[0]!) + 1;
  stdout.write(bytes.subarray(0, splitAt));
  stdout.write(bytes.subarray(splitAt));

  const initialized = await initialize;
  assert.equal(initialized.agentInfo?.name, "fake-é-agent");
});
