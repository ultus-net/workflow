import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createOpencodeServerGateway } from "../src/integrations/opencode-server-gateway.js";
import {
  MIN_CLIENT_PASSWORD_LENGTH,
  PLANE_GATEWAY_HOST,
  PLANE_GATEWAY_PORT,
  resolvePlaneConfig,
} from "../src/cli/plane-config.js";
import { PLANE_ENV_KEYS, planeChildSpecs, planeChildEnv, planeEnv, supervisePlane } from "../src/cli/plane.js";

// ---- plane config: fail-closed resolution ---------------------------------

test("resolvePlaneConfig requires WORKFLOW_PLANE=1 (never a silent public bind)", () => {
  assert.throws(() => resolvePlaneConfig({}, "/w"), /WORKFLOW_PLANE=1/);
});

test("resolvePlaneConfig requires a stable client password (no random-per-roll)", () => {
  assert.throws(
    () => resolvePlaneConfig({ WORKFLOW_PLANE: "1" }, "/w"),
    /WORKFLOW_PLANE_CLIENT_PASSWORD/,
  );
  assert.throws(
    () => resolvePlaneConfig({ WORKFLOW_PLANE: "1", WORKFLOW_PLANE_CLIENT_PASSWORD: "short" }, "/w"),
    /WORKFLOW_PLANE_CLIENT_PASSWORD/,
  );
});

test("resolvePlaneConfig accepts a short operator password at the floor", () => {
  // The floor is a truncation guard, not a strength policy: an operator-chosen
  // credential exactly at the floor resolves (e.g. an 11-char passphrase), and
  // anything one char below it fails closed.
  const atFloor = "a".repeat(MIN_CLIENT_PASSWORD_LENGTH);
  const config = resolvePlaneConfig(
    { WORKFLOW_PLANE: "1", WORKFLOW_PLANE_CLIENT_PASSWORD: atFloor },
    "/w",
  );
  assert.equal(config.clientPassword, atFloor);
  assert.throws(
    () => resolvePlaneConfig({ WORKFLOW_PLANE: "1", WORKFLOW_PLANE_CLIENT_PASSWORD: atFloor.slice(1) }, "/w"),
    /WORKFLOW_PLANE_CLIENT_PASSWORD/,
  );
});

test("resolvePlaneConfig rejects a non-absolute workspace and a bad port", () => {
  assert.throws(
    () => resolvePlaneConfig({ WORKFLOW_PLANE: "1", WORKFLOW_PLANE_CLIENT_PASSWORD: "0123456789abcdef", WORKFLOW_PLANE_WORKSPACE: "rel/path" }, "/w"),
    /absolute path/,
  );
  assert.throws(
    () => resolvePlaneConfig({ WORKFLOW_PLANE: "1", WORKFLOW_PLANE_CLIENT_PASSWORD: "0123456789abcdef", WORKFLOW_PLANE_GATEWAY_PORT: "0" }, "/w"),
    /WORKFLOW_PLANE_GATEWAY_PORT/,
  );
});

test("resolvePlaneConfig defaults to the C0 front door (0.0.0.0:4096)", () => {
  const config = resolvePlaneConfig(
    { WORKFLOW_PLANE: "1", WORKFLOW_PLANE_CLIENT_PASSWORD: "0123456789abcdef" },
    "/workspace",
  );
  assert.equal(config.gatewayHost, PLANE_GATEWAY_HOST);
  assert.equal(config.gatewayPort, PLANE_GATEWAY_PORT);
  assert.equal(config.workspace, "/workspace");
});

// ---- plane supervisor wiring ----------------------------------------------
test("planeChildSpecs supervises the hub and the opencode server daemon, passing the workspace", () => {
  const config = resolvePlaneConfig(
    { WORKFLOW_PLANE: "1", WORKFLOW_PLANE_CLIENT_PASSWORD: "0123456789abcdef" },
    "/workspace",
  );
  const specs = planeChildSpecs(config, (name) => ({ script: `/x/${name}.js`, execArgv: [] }));
  assert.deepEqual(specs.map((spec) => spec.name), ["hub", "opencode-server"]);
  assert.deepEqual(specs[1]!.args, ["--workspace", "/workspace"]);
  // The hub keeps its own default args (loopback bridge; the gateway is the
  // only ingress listener).
  assert.deepEqual(specs[0]!.args, []);
});

test("planeEnv carries the opt-in, the bind, and the stable credential to the daemon", () => {
  const config = resolvePlaneConfig(
    { WORKFLOW_PLANE: "1", WORKFLOW_PLANE_CLIENT_PASSWORD: "0123456789abcdef", WORKFLOW_PLANE_GATEWAY_PORT: "5000" },
    "/workspace",
  );
  assert.deepEqual(planeEnv(config), {
    WORKFLOW_PLANE: "1",
    WORKFLOW_PLANE_WORKSPACE: "/workspace",
    WORKFLOW_PLANE_GATEWAY_HOST: "0.0.0.0",
    WORKFLOW_PLANE_GATEWAY_PORT: "5000",
    WORKFLOW_PLANE_CLIENT_PASSWORD: "0123456789abcdef",
  });
});

// ---- gateway bind option (the plane's fixed front door) -------------------

test("gateway bind defaults to ephemeral loopback (byte-identical to pre-C1)", async () => {
  const gateway = await createOpencodeServerGateway({
    upstream: "http://127.0.0.1:9",
    upstreamPassword: "up",
    tuiPassword: "client",
  });
  try {
    assert.match(gateway.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await gateway.close();
  }
});

test("gateway accepts an explicit host/port bind and a stable client password", async () => {
  const gateway = await createOpencodeServerGateway({
    upstream: "http://127.0.0.1:9",
    upstreamPassword: "up",
    tuiPassword: "0123456789abcdef",
    // Bind loopback on a fixed port in the test (never 0.0.0.0 in the suite);
    // the option is the same one the plane sets to 0.0.0.0:4096.
    host: "127.0.0.1",
    port: 0,
  });
  try {
    assert.equal(gateway.password, "0123456789abcdef");
    // Unauthenticated request is rejected with 401 (the auth split holds at
    // the new bind too).
    const response = await fetch(`${gateway.url}/global/health`);
    assert.equal(response.status, 401);
    await response.text();
  } finally {
    await gateway.close();
  }
});

test("gateway proxies /api/info for an authenticated client (the plane's health route)", async () => {
  // A stub upstream that only answers with the hub credential, mirroring the
  // real `opencode serve`: the gateway must forward under the hub credential,
  // never the client's.
  const upstream = createServer((request, response) => {
    const auth = request.headers.authorization ?? "";
    if (auth !== `Basic ${Buffer.from("up:secret").toString("base64")}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ healthy: true, version: "stub" }));
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => { upstream.off("error", reject); resolve(); });
  });
  const upstreamPort = (upstream.address() as { port: number }).port;
  const gateway = await createOpencodeServerGateway({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "0123456789abcdef",
    host: "127.0.0.1",
    port: 0,
  });
  try {
    const auth = `Basic ${Buffer.from("opencode:0123456789abcdef").toString("base64")}`;
    const response = await fetch(`${gateway.url}/api/info`, { headers: { authorization: auth } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { healthy: true, version: "stub" });
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

// ---- supervised lifecycle (reap + exit code) -------------------------------

interface FakeChild {
  readonly child: {
    kill(signal: NodeJS.Signals): unknown;
    on(event: string, listener: (...args: never[]) => void): unknown;
  };
  readonly killed: NodeJS.Signals[];
  exit(code: number | null, signal: NodeJS.Signals | null): void;
  fail(error: Error): void;
}

function fakeChild(): FakeChild {
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  const killed: NodeJS.Signals[] = [];
  return {
    child: {
      kill: (signal: NodeJS.Signals) => { killed.push(signal); },
      on: (event: string, listener: (...args: never[]) => void) => {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      },
    },
    killed,
    exit: (code, signal) => { for (const listener of listeners.get("exit") ?? []) (listener as (c: number | null, s: NodeJS.Signals | null) => void)(code, signal); },
    fail: (error) => { for (const listener of listeners.get("error") ?? []) (listener as (e: Error) => void)(error); },
  };
}

function planeConfigForTest() {
  return resolvePlaneConfig(
    { WORKFLOW_PLANE: "1", WORKFLOW_PLANE_CLIENT_PASSWORD: "0123456789abcdef" },
    "/workspace",
  );
}

test("supervisePlane reaps the sibling when one child exits and exits with its code", async () => {
  const config = planeConfigForTest();
  const specs = planeChildSpecs(config, (name) => ({ script: `/x/${name}.js`, execArgv: [] }));
  const children = [fakeChild(), fakeChild()];
  let index = 0;
  const errors: string[] = [];
  const handle = supervisePlane(config, specs, {
    baseEnv: {},
    spawnChild: () => children[index++]!.child as never,
    report: { error: (message) => errors.push(message) },
  });
  // The daemon (child 1) exits with code 3: the plane must SIGTERM the hub and
  // resolve with 3, never keep a half-plane alive. The SIGTERM'd hub then
  // exits (modelled here) so the supervisor's `done` settles.
  children[1]!.exit(3, null);
  children[0]!.exit(null, "SIGTERM");
  const code = await handle.done;
  assert.equal(code, 3);
  assert.deepEqual(children[0]!.killed, ["SIGTERM"], "the sibling hub is torn down");
  assert.equal(errors.length, 1);
});

test("supervisePlane fails closed (exit 1) on a signal death and on a start error", async () => {
  const config = planeConfigForTest();
  const specs = planeChildSpecs(config, (name) => ({ script: `/x/${name}.js`, execArgv: [] }));
  const signalChildren = [fakeChild(), fakeChild()];
  let index = 0;
  const signalHandle = supervisePlane(config, specs, {
    baseEnv: {},
    spawnChild: () => signalChildren[index++]!.child as never,
    report: { error: () => undefined },
  });
  signalChildren[0]!.exit(null, "SIGSEGV");
  signalChildren[1]!.exit(null, "SIGTERM");
  assert.equal(await signalHandle.done, 1, "a signal death carries no code, so the plane exits 1");

  const errorChildren = [fakeChild(), fakeChild()];
  index = 0;
  const errorHandle = supervisePlane(config, specs, {
    baseEnv: {},
    spawnChild: () => errorChildren[index++]!.child as never,
    report: { error: () => undefined },
  });
  errorChildren[0]!.fail(new Error("ENOENT"));
  errorChildren[0]!.exit(null, "SIGTERM");
  errorChildren[1]!.exit(null, "SIGTERM");
  assert.equal(await errorHandle.done, 1);
});

test("PLANE_ENV_KEYS matches the keys planeEnv writes (no drift between the two lists)", () => {
  const config = planeConfigForTest();
  assert.deepEqual([...PLANE_ENV_KEYS].sort(), Object.keys(planeEnv(config)).sort());
});

test("planeChildEnv scrubs the plane secret from the hub even when the base env carries it", () => {
  const config = planeConfigForTest();
  const specs = planeChildSpecs(config, (name) => ({ script: `/x/${name}.js`, execArgv: [] }));
  // The production hazard: the supervisor's own process.env holds the
  // credential (it is how resolvePlaneConfig read it), so the hub child would
  // inherit it if the split trusted the base env. Seed it and assert removal.
  const dirtyBase: NodeJS.ProcessEnv = { BASE: "1", WORKFLOW_PLANE: "1", WORKFLOW_PLANE_CLIENT_PASSWORD: "0123456789abcdef", WORKFLOW_PLANE_GATEWAY_PORT: "4096" };
  const hubEnv = planeChildEnv(specs[0]!, config, dirtyBase);
  assert.equal(hubEnv.WORKFLOW_PLANE_CLIENT_PASSWORD, undefined, "the hub must not receive the client credential");
  assert.equal(hubEnv.WORKFLOW_PLANE, undefined);
  assert.equal(hubEnv.WORKFLOW_PLANE_GATEWAY_PORT, undefined);
  assert.deepEqual(hubEnv, { BASE: "1" }, "the hub keeps only the non-plane base env");
  // The base env is not mutated in place by the scrub.
  assert.equal(dirtyBase.WORKFLOW_PLANE_CLIENT_PASSWORD, "0123456789abcdef");

  const daemonEnv = planeChildEnv(specs[1]!, config, dirtyBase);
  assert.equal(daemonEnv.WORKFLOW_PLANE_CLIENT_PASSWORD, "0123456789abcdef");
  assert.equal(daemonEnv.WORKFLOW_PLANE, "1");
  assert.equal(daemonEnv.BASE, "1", "the daemon keeps the base env alongside the plane env");
});

test("supervisePlane wires the scrubbed hub env (the production path, not just the helper)", async () => {
  const config = planeConfigForTest();
  const specs = planeChildSpecs(config, (name) => ({ script: `/x/${name}.js`, execArgv: [] }));
  const seen = new Map<string, NodeJS.ProcessEnv>();
  const children = [fakeChild(), fakeChild()];
  let index = 0;
  const handle = supervisePlane(config, specs, {
    baseEnv: { BASE: "1", WORKFLOW_PLANE_CLIENT_PASSWORD: "0123456789abcdef" },
    spawnChild: (spec, env) => { seen.set(spec.name, env); return children[index++]!.child as never; },
    report: { error: () => undefined },
  });
  assert.equal(seen.get("hub")!.WORKFLOW_PLANE_CLIENT_PASSWORD, undefined, "the hub child never receives the credential");
  assert.equal(seen.get("opencode-server")!.WORKFLOW_PLANE_CLIENT_PASSWORD, "0123456789abcdef");
  children[0]!.exit(0, null);
  children[1]!.exit(0, null);
  await handle.done;
});
