import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ensureDiscovery,
  opencodeAttachArgs,
  parseAttachArgs,
  resolveDaemonSpawnCandidates,
  terminateProcessGroup,
} from "../src/cli/opencode-attach.js";
import {
  opencodeServerDiscoveryPath,
  probeOpencodeServerGateway,
  readOpencodeServerDiscovery,
  removeOpencodeServerDiscovery,
  writeOpencodeServerDiscovery,
  type OpencodeServerDiscovery,
} from "../src/integrations/opencode-server-discovery.js";

/**
 * W071 — launcher discovery and the stock-TUI argv.
 *
 * The discovery file is the only thing the launcher trusts, and it must never
 * carry the upstream credential (only the gateway URL + client password). The
 * launcher must fail closed rather than invent a server.
 */

async function stubGateway(password: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const auth = (request.headers.authorization ?? "").match(/^Basic\s+(.+)$/);
    const creds = auth === null ? undefined : Buffer.from(auth[1]!, "base64").toString("utf8");
    if (creds !== `opencode:${password}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ healthy: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) };
}

test("W071 discovery: round-trips and is written 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-disc-"));
  try {
    const path = opencodeServerDiscoveryPath(dir, "/tmp/alpha");
    writeOpencodeServerDiscovery(path, {
      protocol: 1, pid: 42, workspace: "/tmp/alpha",
      gatewayUrl: "http://127.0.0.1:5", tuiUsername: "opencode", tuiPassword: "secret", version: "1.18.31",
    });
    const read = readOpencodeServerDiscovery(path);
    assert.deepEqual(read, {
      protocol: 1, pid: 42, workspace: "/tmp/alpha",
      gatewayUrl: "http://127.0.0.1:5", tuiUsername: "opencode", tuiPassword: "secret", version: "1.18.31",
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    removeOpencodeServerDiscovery(path);
    assert.equal(readOpencodeServerDiscovery(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W071 discovery: malformed entries are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-disc-bad-"));
  try {
    const path = opencodeServerDiscoveryPath(dir, "/tmp/alpha");
    writeOpencodeServerDiscovery(path, { protocol: 1, pid: 1, workspace: "/tmp/alpha", gatewayUrl: "http://x", tuiUsername: "u", tuiPassword: "p" });
    chmodSync(path, 0o600);
    // Corrupt the stored JSON: readers must fail closed, not throw.
    writeFileSync(path, "{ not json");
    assert.equal(readOpencodeServerDiscovery(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W071 discovery: the gateway probe honors the client password", async (t) => {
  const gateway = await stubGateway("tuipw");
  t.after(() => void gateway.close());
  const discovery: OpencodeServerDiscovery = {
    protocol: 1, pid: 1, workspace: "/tmp/alpha", gatewayUrl: gateway.url, tuiUsername: "opencode", tuiPassword: "tuipw",
  };
  assert.equal(await probeOpencodeServerGateway(discovery), true);
  assert.equal(await probeOpencodeServerGateway({ ...discovery, tuiPassword: "wrong" }), false);
});

test("W071 launcher: parses args and builds the stock-client argv", () => {
  assert.deepEqual(parseAttachArgs(["--workspace", "/tmp/w"]), { workspace: "/tmp/w", autostart: true });
  assert.deepEqual(parseAttachArgs(["--no-autostart"]), { workspace: process.cwd(), autostart: false });
  const discovery: OpencodeServerDiscovery = {
    protocol: 1, pid: 1, workspace: "/tmp/w", gatewayUrl: "http://127.0.0.1:7", tuiUsername: "opencode", tuiPassword: "pw",
  };
  // The password rides the child ENV, never argv (review P3l).
  assert.deepEqual(opencodeAttachArgs(discovery), ["attach", "http://127.0.0.1:7", "--dir", "/tmp/w"]);
});

test("W071 launcher: discovery is only trusted for a loopback gateway (review P3i)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-ensure-nonloop-"));
  try {
    const path = opencodeServerDiscoveryPath(dir, "/tmp/alpha");
    writeOpencodeServerDiscovery(path, {
      protocol: 1, pid: process.pid, workspace: "/tmp/alpha", gatewayUrl: "http://203.0.113.9:7", tuiUsername: "opencode", tuiPassword: "tuipw",
    });
    const result = await ensureDiscovery({
      workspace: "/tmp/alpha", stateHome: dir, autostart: false,
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ healthy: true }), { status: 200 }))) as typeof fetch,
    });
    assert.equal(result, undefined, "a non-loopback gateway URL must never be attached to");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W071 launcher: no candidates fails closed", () => {
  assert.deepEqual(resolveDaemonSpawnCandidates({ PATH: "/nonexistent" }, "/nonexistent-root"), []);
  terminateProcessGroup(undefined);
  terminateProcessGroup(-1);
});

test("W071 launcher: ensureDiscovery fails closed without a live daemon", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-ensure-"));
  try {
    const result = await ensureDiscovery({
      workspace: "/tmp/alpha",
      stateHome: dir,
      autostart: false,
      fetchImpl: (() => Promise.reject(new Error("no server"))) as typeof fetch,
    });
    assert.equal(result, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W071 launcher: ensureDiscovery returns a probed live gateway", async (t) => {
  const gateway = await stubGateway("tuipw");
  t.after(() => void gateway.close());
  const dir = mkdtempSync(join(tmpdir(), "wf-ensure-live-"));
  try {
    const path = opencodeServerDiscoveryPath(dir, "/tmp/alpha");
    writeOpencodeServerDiscovery(path, {
      protocol: 1, pid: process.pid, workspace: "/tmp/alpha", gatewayUrl: gateway.url, tuiUsername: "opencode", tuiPassword: "tuipw",
    });
    const result = await ensureDiscovery({ workspace: "/tmp/alpha", stateHome: dir, autostart: false });
    assert.equal(result?.gatewayUrl, gateway.url);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W071 daemon: env mode parsers accept defaults and reject malformed values (review P3-6)", async () => {
  const { authorityModeFromEnv, enforcementFromEnv } = await import("../src/cli/opencode-server.js");
  assert.equal(authorityModeFromEnv({}), "auto-resolve");
  assert.equal(authorityModeFromEnv({ WORKFLOW_OPENCODE_AUTHORITY_MODE: "ask-me" }), "ask-me");
  assert.throws(() => authorityModeFromEnv({ WORKFLOW_OPENCODE_AUTHORITY_MODE: "yolo" }), /must be "auto-resolve" or "ask-me"/);
  assert.equal(enforcementFromEnv({}), "advisory");
  assert.equal(enforcementFromEnv({ WORKFLOW_OPENCODE_ENFORCEMENT: "enforced" }), "enforced");
  assert.throws(() => enforcementFromEnv({ WORKFLOW_OPENCODE_ENFORCEMENT: "on" }), /must be "advisory" or "enforced"/);
});