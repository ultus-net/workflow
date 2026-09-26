import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import { createOpencodeServerGateway } from "../src/integrations/opencode-server-gateway.js";

/**
 * The ingress probe for the gateway's event-stream keepalive — the
 * end-to-end arm behind the W071 keepalive (docs/HOST_ADAPTERS.md,
 * 2026-09-26).
 *
 * The keepalive exists for exactly one reason: an ingress proxy with an
 * idle/read timeout (the deployed topology's ~4 minutes) destroys a quiet
 * `text/event-stream`, and the attached session dies with it.
 * `test/opencode-server-gateway.test.ts` proves the frame reaches the wire;
 * this probe proves what the frame BUYS, through a real idle-timeout hop in
 * front of the PRODUCTION gateway:
 *
 *   attached client -> idle-timeout ingress (destroys any response with no
 *   bytes for N ms) -> production gateway (enforced posture) -> a stub
 *   `opencode serve` whose `/api/event` delivers its head and then says
 *   nothing, ever.
 *
 * Three arms, none vacuous:
 *   1. keepalive (100ms) INSIDE the proxy idle window (400ms): the attached
 *      stream survives several idle windows and receives comment frames only.
 *   2. CONTROL — keepalive (5s) BEYOND the idle window: the same stream is
 *      destroyed by the proxy. Without this arm a proxy that never times out
 *      would make arm 1 pass for free.
 *   3. The stated residual: a `content-encoding: gzip` event stream is
 *      proxied byte-identical, so it stays drop-prone at the ingress. The
 *      residual is recorded in the docs; this arm keeps that record honest.
 *
 * Honesty (advisory, transport liveness only): this is a hermetic loopback
 * probe — a real proxy hop and a stub upstream, no live host and no
 * credentials — so it is ungated and runs in the ordinary suite instead of
 * claiming a dated gate verdict. It proves neither upstream health nor hub
 * authority, and it is NOT a qualification of a deployed ingress
 * (nginx/ALB/Cloudflare) configuration. The 15s default interval is what
 * makes the deployed case safe; the probe only pins the mechanism.
 */

const UPSTREAM_USERNAME = "up";
const UPSTREAM_PASSWORD = "secret";
const TUI_PASSWORD = "tuipw";

/** The deployed ~4-minute ingress idle timeout, scaled down to probe time. */
const PROXY_IDLE_MS = 400;
/** The pinned recipe: the keepalive interval must sit well inside the window. */
const KEEPALIVE_MS = 100;
/** The control: an interval past the window is the drop-prone configuration. */
const KEEPALIVE_PAST_IDLE_MS = 5_000;

interface StubServer {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * A stand-in for `opencode serve`: the production `/api/event` route delivers
 * its head and then goes silent (the quiet stream an ingress idle timeout
 * drops). `?encoding=gzip` serves the same route with a `content-encoding:
 * gzip` body — the case the keepalive must not touch. The knob is a query
 * parameter on purpose: the pathname stays `/api/event`, so the enforced route
 * matrix still qualifies it and the probe keeps the production posture.
 */
async function silentUpstream(): Promise<StubServer> {
  const held: ServerResponse[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const auth = (request.headers.authorization ?? "").match(/^Basic\s+(.+)$/);
    const creds = auth === null ? undefined : Buffer.from(auth[1]!, "base64").toString("utf8");
    if (creds !== `${UPSTREAM_USERNAME}:${UPSTREAM_PASSWORD}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const incoming = new URL(request.url ?? "/", "http://stub.invalid");
    if (incoming.pathname !== "/api/event") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const compressed = incoming.searchParams.get("encoding") === "gzip";
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      ...(compressed ? { "content-encoding": "gzip" } : {}),
    });
    // The head now, silence after: a real event stream is quiet between
    // events, and a long quiet period is the case the keepalive exists for.
    response.flushHeaders();
    if (compressed) response.write(gzipSync(Buffer.from('data: {"compressed":true}\n\n')));
    held.push(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      // A held event stream would keep the server open past `close()`.
      for (const stream of held) stream.destroy();
      held.length = 0;
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

interface IdleIngress {
  readonly url: string;
  /** Responses the idle watchdog destroyed — the behavior under test. */
  readonly drops: () => number;
  close(): Promise<void>;
}

/**
 * A real idle-timeout ingress: a byte-transparent L7 forwarder that destroys
 * any response whose upstream sends no bytes for `idleMs` (nginx
 * `proxy_read_timeout`, an ALB idle timeout, Cloudflare's read timeout). It
 * forwards the client's own credential unchanged, so the gateway's auth check
 * still runs, and it is a separate socket hop rather than a function call.
 *
 * Two deliberate fidelity choices, both the deployed ingress's own
 * configuration, not a convenience for the probe: the head is flushed
 * straight through (nginx `proxy_buffering off` / `X-Accel-Buffering: no` for
 * an event stream — a buffering ingress would measure its own buffer policy
 * instead of the gateway), and the idle watchdog is armed when the request
 * goes out, so an upstream that never sends even a head is dropped too. A
 * downstream connection that can no longer be fed takes its upstream request
 * down with it, the way a real ingress does — the bytes can no longer be
 * delivered, and a pinned upstream response would hold the origin's server
 * open past `close()`. `agent: false` keeps no pooled socket alive.
 */
async function idleTimeoutIngress(upstreamUrl: string, idleMs: number): Promise<IdleIngress> {
  const upstream = new URL(upstreamUrl);
  const live = new Set<{ readonly response: ServerResponse; proxied?: ClientRequest }>();
  let drops = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const target = new URL(upstream.toString());
    const incoming = new URL(request.url ?? "/", "http://ingress.invalid");
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers[key] = value;
    }
    headers["host"] = target.host;

    const connection: { response: ServerResponse; proxied?: ClientRequest } = { response };
    let idle: ReturnType<typeof setTimeout> | undefined;
    const clearIdle = (): void => {
      if (idle === undefined) return;
      clearTimeout(idle);
      idle = undefined;
    };
    /** The downstream connection is gone (or was never fed): stop the watchdog
     *  and take the upstream request with it. */
    const release = (): void => {
      clearIdle();
      connection.proxied?.destroy();
    };
    const armIdle = (): void => {
      clearIdle();
      idle = setTimeout(() => {
        drops += 1;
        response.destroy();
        release();
      }, idleMs);
      idle.unref();
    };

    connection.proxied = httpRequest(target, { method: request.method ?? "GET", headers, agent: false }, (upstreamResponse) => {
      const head: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined) head[key] = value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, head);
      // The event-stream pass-through the deployed ingress is configured for:
      // the head reaches the client now, so the silent window the watchdog
      // measures starts at the head rather than at the first buffered byte.
      response.flushHeaders();
      armIdle(); // the head counts as bytes: the silent window starts here
      upstreamResponse.on("data", (chunk: Buffer) => {
        armIdle(); // any forwarded byte resets the window
        response.write(chunk);
      });
      upstreamResponse.once("end", () => { clearIdle(); response.end(); });
      upstreamResponse.once("error", () => { release(); response.destroy(); });
    });
    connection.proxied.on("error", () => { release(); response.destroy(); });
    live.add(connection);
    response.once("close", () => { release(); live.delete(connection); });
    armIdle();
    request.pipe(connection.proxied);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    drops: () => drops,
    close: () => new Promise<void>((resolve, reject) => {
      for (const connection of live) {
        connection.proxied?.destroy();
        connection.response.destroy();
      }
      live.clear();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

interface AttachedClient {
  readonly started: Promise<{ readonly status: number; readonly contentType: string | undefined }>;
  /** Resolves when the stream ended, was aborted, or errored — either way. */
  readonly settled: Promise<void>;
  /** True when the stream was cut (a proxy idle drop or a reset). */
  readonly aborted: () => boolean;
  /** True when the response completed normally. */
  readonly endedCleanly: () => boolean;
  received(): string;
  close(): void;
}

/**
 * A raw byte-level view of the attached session's stream. `fetch` buffers,
 * and a dropped SSE response has to be observable as a cut, so the probe
 * speaks HTTP directly.
 */
function attachClient(ingressUrl: string): AttachedClient {
  const chunks: Buffer[] = [];
  let aborted = false;
  let endedCleanly = false;
  let markSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => { markSettled = resolve; });
  let request: ClientRequest | undefined;
  const started = new Promise<{ status: number; contentType: string | undefined }>((resolve) => {
    // A stream that never delivers its head resolves as status 0 rather than
    // hanging the probe.
    const head = setTimeout(() => resolve({ status: 0, contentType: undefined }), 2_000);
    head.unref();
    request = httpRequest(ingressUrl, {
      agent: false,
      headers: { authorization: basic("opencode", TUI_PASSWORD) },
    }, (response) => {
      clearTimeout(head);
      response.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      response.once("end", () => { endedCleanly = true; markSettled(); });
      response.once("aborted", () => { aborted = true; markSettled(); });
      response.once("error", () => { aborted = true; markSettled(); });
      response.once("close", () => { if (!endedCleanly) aborted = true; markSettled(); });
      resolve({ status: response.statusCode ?? 0, contentType: response.headers["content-type"] });
    });
    request.once("error", () => {
      aborted = true;
      markSettled();
      resolve({ status: 0, contentType: undefined });
    });
    request.end();
  });
  return {
    started,
    settled,
    aborted: () => aborted,
    endedCleanly: () => endedCleanly,
    received: () => Buffer.concat(chunks).toString("utf8"),
    close: () => { request?.destroy(); },
  };
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function sseFrames(received: string): string[] {
  return received.split("\n\n").filter((frame) => frame !== "");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded wait for a drop; the assertions report the miss, so the cap is honest. */
async function settledWithin(client: AttachedClient, timeoutMs = 2_000): Promise<void> {
  await Promise.race([client.settled, sleep(timeoutMs)]);
}

/** Stands the stub upstream, the production gateway, and the ingress hop. */
async function topology(t: { after: (fn: () => Promise<void>) => void }, options: {
  readonly keepaliveMs: number;
  readonly idleMs: number;
  /** The upstream event-stream route the attached client watches. */
  readonly path?: string;
}): Promise<{ readonly ingress: IdleIngress; readonly client: AttachedClient }> {
  // Cleanup is registered first and unwound in reverse, so a failure part-way
  // through setup still releases whatever was already standing — a leaked
  // loopback server would hang the run instead of failing it. Reverse order
  // is also the dependency order: the client socket, then the hop holding it,
  // then the gateway, then the upstream.
  const unwind: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const step of unwind.reverse()) await step();
  });

  const upstream = await silentUpstream();
  unwind.push(() => upstream.close());
  const previous = process.env.WORKFLOW_SSE_KEEPALIVE_MS;
  process.env.WORKFLOW_SSE_KEEPALIVE_MS = String(options.keepaliveMs);
  unwind.push(async () => {
    if (previous === undefined) delete process.env.WORKFLOW_SSE_KEEPALIVE_MS;
    else process.env.WORKFLOW_SSE_KEEPALIVE_MS = previous;
  });
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: UPSTREAM_USERNAME,
    upstreamPassword: UPSTREAM_PASSWORD,
    tuiPassword: TUI_PASSWORD,
    // The deployed posture: the gateway is the authority boundary, so the
    // event stream is served through the enforced forwarding path.
    enforced: true,
    onPermissionReply: () => undefined,
  });
  unwind.push(() => gateway.close());
  const ingress = await idleTimeoutIngress(gateway.url, options.idleMs);
  unwind.push(() => ingress.close());
  const client = attachClient(`${ingress.url}${options.path ?? "/api/event"}`);
  unwind.push(async () => { client.close(); });
  return { ingress, client };
}

test("gateway ingress probe: an attached event stream survives the proxy idle window when the keepalive is inside it", async (t) => {
  const { ingress, client } = await topology(t, { keepaliveMs: KEEPALIVE_MS, idleMs: PROXY_IDLE_MS });

  const started = await client.started;
  assert.equal(started.status, 200, "the ingress must forward the head, not wait on a body");
  assert.match(started.contentType ?? "", /text\/event-stream/);
  // The head must not be buffered behind the first frame, or a quiet stream
  // leaves the client waiting on a body that may not arrive for minutes.
  assert.deepEqual(sseFrames(client.received()), [], "the head must arrive before any frame");

  // ~2.5 idle windows. If the keepalive did nothing, the proxy cuts the
  // stream at the first one.
  await sleep(PROXY_IDLE_MS * 2.5);
  assert.equal(ingress.drops(), 0, "the ingress idle watchdog must never fire while the gateway keeps the stream alive");
  assert.equal(client.aborted(), false, "the attached stream must survive the ingress idle window");
  assert.equal(client.endedCleanly(), false, "the stream is still attached, not finished");

  const frames = sseFrames(client.received());
  assert.ok(frames.length >= 4, `expected repeated keepalive frames through the ingress, saw ${frames.length}`);
  for (const frame of frames) {
    // Byte activity, never an event: no field name a conforming parser would
    // dispatch on, so the client survives without seeing a phantom event.
    assert.ok(
      frame.split("\n").every((line) => line.startsWith(":")),
      `a keepalive frame carries no field: ${JSON.stringify(frame)}`,
    );
  }
});

test("gateway ingress probe (control): the same stream is dropped when the keepalive is slower than the idle window", async (t) => {
  const { ingress, client } = await topology(t, { keepaliveMs: KEEPALIVE_PAST_IDLE_MS, idleMs: PROXY_IDLE_MS });

  const started = await client.started;
  assert.equal(started.status, 200, "the head is not what an idle timeout kills");
  await settledWithin(client);
  assert.equal(client.aborted(), true, "a silent stream with no keepalive inside the idle window must be cut by the proxy");
  assert.ok(ingress.drops() >= 1, "the ingress idle watchdog is what dropped it — the control arm proves the proxy is real");
  assert.deepEqual(
    sseFrames(client.received()),
    [],
    "nothing arrived inside the idle window, so there was nothing to keep the stream alive",
  );
});

test("gateway ingress probe (stated residual): a compressed event stream is still dropped by the proxy", async (t) => {
  const { ingress, client } = await topology(t, {
    keepaliveMs: KEEPALIVE_MS,
    idleMs: PROXY_IDLE_MS,
    path: "/api/event?encoding=gzip",
  });

  const started = await client.started;
  assert.equal(started.status, 200, "the compressed head must still be forwarded through the ingress");
  await settledWithin(client);
  // Documented residual: a compressed stream is proxied byte-identical (a
  // plaintext frame spliced into a gzip member would break the client's
  // decoder), so it remains drop-prone at the ingress. The probe keeps the
  // residual visible instead of quietly reading as "ingress drops are fixed".
  assert.equal(client.aborted(), true, "a gzip event stream is left untouched and stays drop-prone");
  assert.ok(ingress.drops() >= 1, "the ingress idle watchdog dropped the compressed stream");
  assert.equal(
    client.received().includes("workflow-keepalive"),
    false,
    "no plaintext frame may enter a compressed stream, drop or no drop",
  );
});
