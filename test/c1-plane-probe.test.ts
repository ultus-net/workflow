import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { qualifyOpenCodeV2Route } from "../src/integrations/opencode-v2-route-class.js";
import { classifySseIdleHold } from "../src/integrations/probe-verdicts.js";

/**
 * C1 live probe (deploy plan §4 task 3.1) — the acceptance instrument for a
 * DEPLOYED control plane, measured through Azure Container Apps ingress.
 *
 * Gated: `WORKFLOW_AZURE_PLANE_PROBE=1`. It skips honestly without the gate
 * (the repo's gated-probe convention, `docs/FEATURES.md:50`; never in the
 * default `test:ci`). The idle arm is gated SEPARATELY on
 * `WORKFLOW_AZURE_PLANE_PROBE_IDLE=1` because it holds a stream open for the
 * full 240 s ingress idle window (the C0 `--idle` gate, mirrored) — a 4-minute
 * arm must not tax the default probe run. Both gates are registered in
 * `docs/PROBE_VERDICTS.json`; both are `pending` until the first live run.
 *
 * Required environment when the gate is set (a missing one fails the probe,
 * never a silent skip):
 *   WORKFLOW_AZURE_PLANE_URL               the plane base URL (https://<fqdn>)
 *   WORKFLOW_AZURE_PLANE_CLIENT_PASSWORD   the client-facing gateway credential
 *
 * Optional environment:
 *   WORKFLOW_AZURE_PLANE_DISCOVERY         path to the in-pod discovery file
 *                                          (read by an in-container run). It
 *                                          cannot be read over the wire, so
 *                                          the boundaryKind arm is gated on its
 *                                          presence: absent the path the arm
 *                                          SKIPS (an honest skip, never a
 *                                          reported pass that asserted nothing).
 *
 * Honesty: this probe measures the DEPLOYED transport. It earns the C1 status
 * **Partial (advisory)** — an `enforced` label for pods is withheld until the
 * P2 model-key probe (task 8, spec §6:127-128). The route-class arm therefore
 * asserts the posture-independent invariants (deny-class routes are never
 * plain-forwarded by the shared qualifier, and are auth-gated at ingress); the
 * enforced 403 on the wire is NOT claimed here while C1 is advisory. The local
 * in-container loopback probe (task 3) proves the in-pod path, not this one.
 */

const runPlaneProbe = process.env.WORKFLOW_AZURE_PLANE_PROBE === "1";
const runIdleArm = process.env.WORKFLOW_AZURE_PLANE_PROBE_IDLE === "1";
// The discovery arm needs the in-pod discovery file, which cannot be read over
// the wire. Gate it on that file's presence so a run without it SKIPS the arm
// (node:test reports a skip, never a pass) rather than reporting a green that
// asserted nothing. No new env gate: it reuses WORKFLOW_AZURE_PLANE_PROBE.
const runDiscoveryArm = runPlaneProbe && (process.env.WORKFLOW_AZURE_PLANE_DISCOVERY ?? "") !== "";
const IDLE_WINDOW_MS = 240_000;

interface PlaneTarget {
  readonly base: string;
  readonly clientPassword: string;
  readonly auth: string;
}

/** Resolves the live target, failing closed on a missing env value. */
function resolveTarget(): PlaneTarget {
  const base = process.env.WORKFLOW_AZURE_PLANE_URL?.replace(/\/+$/, "");
  const clientPassword = process.env.WORKFLOW_AZURE_PLANE_CLIENT_PASSWORD;
  if (base === undefined || base === "") throw new Error("WORKFLOW_AZURE_PLANE_URL is required");
  if (clientPassword === undefined || clientPassword === "") {
    throw new Error("WORKFLOW_AZURE_PLANE_CLIENT_PASSWORD is required");
  }
  return {
    base,
    clientPassword,
    auth: `Basic ${Buffer.from(`opencode:${clientPassword}`).toString("base64")}`,
  };
}

/** A request that never lets a transport hang outlive the probe. */
async function request(target: PlaneTarget, path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${target.base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
}

test("C1 live probe: unauthenticated reads are rejected at ingress (401)", { skip: !runPlaneProbe, timeout: 60_000 }, async () => {
  const target = resolveTarget();
  const response = await request(target, "/api/info");
  assert.equal(response.status, 401, "an unauthenticated GET /api/info must be refused at the gateway");
});

test("C1 live probe: the client credential answers authenticated /api/info (200)", { skip: !runPlaneProbe, timeout: 60_000 }, async () => {
  const target = resolveTarget();
  const response = await request(target, "/api/info", { headers: { authorization: target.auth } });
  assert.equal(response.status, 200, "the client credential must answer the health route");
  const body: unknown = await response.json();
  assert.equal(typeof body, "object");
  assert.notEqual(body, null);
});

test("C1 live probe: client/upstream credential split holds over the wire", { skip: !runPlaneProbe, timeout: 60_000 }, async () => {
  const target = resolveTarget();
  // A wrong credential is refused, so the accepting credential is a real
  // secret, not ambient trust. The upstream credential never leaves the pod,
  // so the split is proven by: the client credential works; anything else is
  // 401; and the discovery file (checked in the boundary arm) never carries an
  // upstream password field.
  const wrong = await request(target, "/api/info", {
    headers: { authorization: `Basic ${Buffer.from("opencode:not-the-password").toString("base64")}` },
  });
  assert.equal(wrong.status, 401, "only the client credential may answer the gateway");

  if (process.env.WORKFLOW_AZURE_PLANE_DISCOVERY !== undefined) {
    const discovery = JSON.parse(readFileSync(process.env.WORKFLOW_AZURE_PLANE_DISCOVERY, "utf8")) as Record<string, unknown>;
    assert.equal(
      discovery.tuiPassword,
      target.clientPassword,
      "the discovery client password must be the credential that answers the wire",
    );
    assert.equal("upstreamPassword" in discovery, false, "the upstream credential must never reach the discovery file");
    assert.equal("password" in discovery, false, "the discovery file carries tuiPassword only, never a bare password");
  }
});

test("C1 live probe: the broker's event subscription is live (SSE opens and delivers)", { skip: !runPlaneProbe, timeout: 60_000 }, async (t) => {
  const target = resolveTarget();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${target.base}/api/event`, {
    headers: { authorization: target.auth, accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200, "the event route must be open with the client credential");
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/, "the event route must be an SSE stream");
  assert.notEqual(stream.body, null);

  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  let bytes = 0;
  const deadline = Date.now() + 20_000;
  // Read until the connection delivers evidence of a live subscription (the
  // server's own `server.connected` greeting or a keepalive comment frame), or
  // the bounded deadline. A stream that opens but never says anything is a
  // dropped subscription, not a live one. The 1s tick lets the deadline stay
  // responsive when the stream is silent.
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);
    if (chunk === null) continue;
    if (chunk.done) break;
    if (chunk.value !== undefined && chunk.value.length > 0) {
      bytes += chunk.value.length;
      received += decoder.decode(chunk.value, { stream: true });
    }
    if (received.includes("server.connected") || received.includes("workflow-keepalive")) break;
  }
  assert.ok(bytes > 0, "the event stream must deliver bytes once the broker subscription is live");
  controller.abort();
});

test("C1 live probe: gateway route-class matrix (auth precedes classification)", { skip: !runPlaneProbe, timeout: 60_000 }, async () => {
  const target = resolveTarget();
  // The shared pure qualifier is the enforced contract (the gateway imports
  // it), so a matrix probe asserts the gateway's wire behavior matches it. The
  // always-true invariant in both postures is auth-first: an unauthenticated
  // request is refused BEFORE classification. The enforced 403 lane is
  // deliberately NOT asserted here — C1 is advisory until task 8 (P2), so no
  // wire behavior may imply an enforcement claim the deploy has not earned.
  const denyRoutes: readonly (readonly [string, string])[] = [
    ["POST", "/api/fs/write"],
    ["POST", "/api/session/abc/permission/xyz/reply"],
    ["GET", "/api/config"],
  ];
  for (const [method, path] of denyRoutes) {
    const qualification = qualifyOpenCodeV2Route(method, path);
    assert.notEqual(qualification.disposition, "forward", `${method} ${path} must not be a plain forward route`);
    const unauthenticated = await request(target, path, { method });
    assert.equal(unauthenticated.status, 401, `${method} ${path} must be refused unauthenticated before classification`);
  }
});

test("C1 live probe: discovery reports boundaryKind container-boundary", { skip: !runDiscoveryArm, timeout: 60_000 }, async () => {
  const path = process.env.WORKFLOW_AZURE_PLANE_DISCOVERY;
  // The arm is gated on its own env (below) so a run WITHOUT the discovery path
  // SKIPS it. A plain `return` here would report a pass that asserted nothing —
  // exactly the false green the probe discipline forbids.
  assert.ok(path !== undefined && path !== "", "WORKFLOW_AZURE_PLANE_DISCOVERY is required for this arm");
  const discovery = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(
    discovery.boundaryKind,
    "container-boundary",
    "the deployed plane must surface the delegated container boundary, never a bare bwrap claim",
  );
});

test("C1 live probe (idle arm): the event stream survives the full 240s ingress idle window", { skip: !runIdleArm, timeout: IDLE_WINDOW_MS + 60_000 }, async () => {
  const target = resolveTarget();
  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(), IDLE_WINDOW_MS + 30_000);
  try {
    const stream = await fetch(`${target.base}/api/event`, {
      headers: { authorization: target.auth, accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200, "the idle arm needs an open event stream");
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = stream.body!.getReader();

    // Count the subscriptions the arm itself opened: exactly one. The shared
    // classifier refuses a hold that never opened a stream or that silently
    // resumed one.
    const openedBefore = 1;
    const subscriptions = 1;
    let delivered = 0;
    let drop: string | undefined;
    const started = Date.now();
    const drain = (async () => {
      for (;;) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            drop = "the event stream ended";
            break;
          }
          if (chunk.value !== undefined && chunk.value.length > 0) delivered += 1;
        } catch (error) {
          drop = `the event stream errored: ${error instanceof Error ? error.message : String(error)}`;
          break;
        }
      }
    })();
    await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, IDLE_WINDOW_MS))]);
    const heldMs = Date.now() - started;

    const verdict = classifySseIdleHold({ heldMs, idleWindowMs: IDLE_WINDOW_MS, delivered, subscriptions, openedBefore, drop });
    assert.equal(verdict.survived, true, `idle survival measured as '${verdict.outcome}': ${verdict.reason}`);
    controller.abort();
  } finally {
    clearTimeout(hardStop);
  }
});

/**
 * Broker arm (gated `WORKFLOW_AZURE_PLANE_PROBE_BROKER=1`): drives a REAL model
 * turn that requests a mutating tool (shell) and asserts the authority broker
 * mediates it — the model-key probe the docs deferred (`OPENCODE_SERVER_AUTHORITY.md`,
 * `OPENCODE_REMOTE_ACP_SPEC.md` §10). It spends model tokens, so it holds its own
 * gate, like the idle arm.
 *
 * Evidence, measured over the wire:
 *  - the broker INTERCEPTS: a `permission.asked` for the session appears on the
 *    event stream (the ask rule fired, the broker subscribed).
 *  - the broker SETTLES: the tool part's state leaves `running` for a terminal
 *    status (the reply reached upstream). Pre-fix the v2 envelope mismatch made
 *    every ask unmappable and the tool hung at `running` forever — the exact
 *    defect this arm exists to catch.
 *
 * Honest scope: this is an ADVISORY mediation claim (the broker answered), not
 * an enforcement-bypass claim. It does not upgrade any `enforced` label.
 */
const runBrokerArm = process.env.WORKFLOW_AZURE_PLANE_PROBE_BROKER === "1";

interface V2ToolState {
  readonly status?: string;
  readonly executed?: boolean;
}

test("C1 live probe (broker arm): a mutating tool turn is intercepted and settles", { skip: !runBrokerArm, timeout: 180_000 }, async (t) => {
  const target = resolveTarget();
  const controller = new AbortController();
  t.after(() => controller.abort());

  // Subscribe before prompting so the permission ask is observed.
  const stream = await fetch(`${target.base}/api/event`, {
    headers: { authorization: target.auth, accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200, "the broker arm needs an open event stream");
  assert.notEqual(stream.body, null);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: { readonly type: string; readonly sessionID?: string }[] = [];
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (data.length > 0) {
            try {
              const parsed = JSON.parse(data) as { type?: unknown; data?: { sessionID?: unknown } };
              if (typeof parsed.type === "string") {
                seen.push({ type: parsed.type, ...(typeof parsed.data?.sessionID === "string" ? { sessionID: parsed.data.sessionID } : {}) });
              }
            } catch {
              // A keepalive comment / non-JSON frame is ignored, never a failure.
            }
          }
          index = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Abort at the end of the arm is the normal exit.
    }
  })();

  const created = await request(target, "/api/session", {
    method: "POST",
    headers: { authorization: target.auth, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(created.status, 200, "session create must succeed through the gateway");
  const sessionId = ((await created.json()) as { data?: { id?: string } }).data?.id;
  assert.ok(sessionId !== undefined && sessionId !== "", "the session create must return data.id");

  const prompted = await request(target, `/api/session/${sessionId}/prompt`, {
    method: "POST",
    headers: { authorization: target.auth, "content-type": "application/json" },
    body: JSON.stringify({ text: "Use the shell tool to run exactly: echo C1_BROKER_PROBE" }),
  });
  assert.equal(prompted.status, 200, "the prompt must be accepted through the gateway");

  // Poll the session messages until the shell tool part settles (or the bound).
  const toolState = (messages: unknown): V2ToolState | undefined => {
    const data = (messages as { data?: unknown }).data;
    if (!Array.isArray(data)) return undefined;
    for (const message of data) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const record = part as { type?: unknown; name?: unknown; state?: unknown };
        if (record.type !== "tool" || record.name !== "shell") continue;
        const state = record.state as { status?: unknown } | undefined;
        if (state !== undefined && typeof state.status === "string") return { status: state.status };
      }
    }
    return undefined;
  };

  let settled: V2ToolState | undefined;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const messages = await request(target, `/api/session/${sessionId}/message`, { headers: { authorization: target.auth } });
    if (messages.status === 200) {
      settled = toolState(await messages.json());
      if (settled !== undefined && settled.status !== "running") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  controller.abort();

  assert.ok(
    seen.some((event) => event.type === "permission.asked" && event.sessionID === sessionId),
    "the broker must intercept the mutating tool: a permission.asked for the session must appear on the event stream",
  );
  assert.ok(
    settled !== undefined && settled.status !== "running",
    `the mutating tool must settle (got state '${settled?.status ?? "none"}'); a hang at 'running' means the broker reply never landed`,
  );
});

