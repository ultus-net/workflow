import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  classifyPlaneState,
  createAzurePlaneWakeDeps,
  ensureExplicitPlaneReady,
  ensurePlaneReady,
  planeStateLine,
  parsePlaneResourceFacts,
  resolvePlaneWakeTarget,
  type PlaneResourceFacts,
  type PlaneWakeDeps,
} from "../src/integrations/plane-wake.js";

/**
 * C1 task 2b — launcher plane-awareness (spec §10:230-246).
 *
 * The classification table is the module's contract: reachability wins, the
 * `az` session gates the wake, and asleep (the one wakeable state) is split
 * from broken. The behavioral pins prove the fail-closed paths: no-az never
 * polls (never hangs), a wake failure is reported not thrown, and a bounded
 * poll resolves honestly when the wake never becomes healthy.
 */

function facts(overrides: Partial<PlaneResourceFacts>): PlaneResourceFacts {
  return { exists: true, ...overrides };
}

test("plane-wake: the classification table", () => {
  // Reachability wins outright.
  assert.deepEqual(classifyPlaneState({ reachable: true, azSession: false }), { kind: "ready" });
  assert.deepEqual(classifyPlaneState({ reachable: true, version: "2.0.10", azSession: true }), { kind: "ready", version: "2.0.10" });

  // No az session is an honest dead end, regardless of resource facts.
  assert.equal(classifyPlaneState({ reachable: false, azSession: false }).kind, "no-az");
  assert.equal(classifyPlaneState({ reachable: false, azSession: false, resource: facts({ minReplicas: 0 }) }).kind, "no-az");

  // With a session: asleep only for a proven scaled-to-zero app.
  assert.equal(classifyPlaneState({ reachable: false, azSession: true, resource: facts({ minReplicas: 0 }) }).kind, "asleep");

  // Broken: missing resource, failed provisioning, unhealthy replica, or a
  // running app whose gateway is still gone.
  assert.equal(classifyPlaneState({ reachable: false, azSession: true }).kind, "broken");
  assert.equal(classifyPlaneState({ reachable: false, azSession: true, resource: { exists: false } }).kind, "broken");
  assert.equal(classifyPlaneState({ reachable: false, azSession: true, resource: facts({ provisioningState: "Failed" }) }).kind, "broken");
  assert.equal(classifyPlaneState({ reachable: false, azSession: true, resource: facts({ minReplicas: 1, runningStatus: "Stopped" }) }).kind, "broken");
  assert.equal(classifyPlaneState({ reachable: false, azSession: true, resource: facts({ minReplicas: 1, runningStatus: "Running" }) }).kind, "broken");
});

test("plane-wake: scale-to-zero outranks a stopped running status", () => {
  // A zero-replica app reports a stopped/unknown runningStatus; asleep must win
  // or the wake would never be attempted.
  assert.equal(
    classifyPlaneState({ reachable: false, azSession: true, resource: facts({ minReplicas: 0, runningStatus: "Stopped" }) }).kind,
    "asleep",
  );
});

test("plane-wake: no-az never polls and never hangs", async () => {
  let probed = 0;
  let slept = 0;
  const deps: PlaneWakeDeps = {
    probe: async () => { probed += 1; return undefined; },
    azSession: async () => false,
    show: async () => facts({ minReplicas: 0 }),
    wake: async () => { throw new Error("wake must never run without an az session"); },
    sleep: async () => { slept += 1; },
  };
  const outcome = await ensurePlaneReady(deps, { timeoutMs: 60_000, pollMs: 1 });
  assert.equal(outcome.state.kind, "no-az");
  assert.equal(outcome.woke, false);
  assert.equal(probed, 1, "one probe, then the honest no-az stop");
  assert.equal(slept, 0, "no polling without an az session");
});

test("plane-wake: a live gateway short-circuits before any az call", async () => {
  let azCalls = 0;
  const deps: PlaneWakeDeps = {
    probe: async () => ({ version: "2.0.10" }),
    azSession: async () => { azCalls += 1; return true; },
    show: async () => { azCalls += 1; return undefined; },
    wake: async () => { azCalls += 1; },
  };
  const outcome = await ensurePlaneReady(deps);
  assert.deepEqual(outcome.state, { kind: "ready", version: "2.0.10" });
  assert.equal(outcome.woke, false);
  assert.equal(azCalls, 0, "a ready plane never touches az");
});

test("plane-wake: an asleep plane is woken, then attached after the bounded poll", async () => {
  let awake = false;
  const deps: PlaneWakeDeps = {
    probe: async () => (awake ? { version: "2.0.10" } : undefined),
    azSession: async () => true,
    show: async () => facts({ minReplicas: 0 }),
    wake: async () => { awake = true; },
    sleep: async () => undefined,
  };
  const outcome = await ensurePlaneReady(deps, { timeoutMs: 60_000, pollMs: 1 });
  assert.equal(outcome.state.kind, "ready");
  assert.equal(outcome.woke, true, "the wake path reports it actually woke the plane");
});

test("plane-wake: a wake that never becomes healthy resolves broken, not thrown", async () => {
  let clock = 0;
  const deps: PlaneWakeDeps = {
    probe: async () => undefined,
    azSession: async () => true,
    show: async () => facts({ minReplicas: 0 }),
    wake: async () => undefined,
    sleep: async () => { clock += 1_000; },
    now: () => clock,
  };
  const outcome = await ensurePlaneReady(deps, { timeoutMs: 5_000, pollMs: 1 });
  assert.equal(outcome.state.kind, "broken");
  assert.match((outcome.state as { reason: string }).reason, /timed out/);
  assert.equal(outcome.woke, false);
});

test("plane-wake: a wake failure is reported as broken with the az cause", async () => {
  const deps: PlaneWakeDeps = {
    probe: async () => undefined,
    azSession: async () => true,
    show: async () => facts({ minReplicas: 0 }),
    wake: async () => { throw new Error("ERROR: not logged in"); },
  };
  const outcome = await ensurePlaneReady(deps);
  assert.equal(outcome.state.kind, "broken");
  assert.match((outcome.state as { reason: string }).reason, /wake failed: ERROR: not logged in/);
});

test("plane-wake: a resource read that throws is broken (never asleep)", async () => {
  const deps: PlaneWakeDeps = {
    probe: async () => undefined,
    azSession: async () => true,
    show: async () => { throw new Error("az containerapp show failed"); },
    wake: async () => { throw new Error("must not wake an unproven asleep"); },
  };
  const outcome = await ensurePlaneReady(deps);
  assert.equal(outcome.state.kind, "broken");
});

test("plane-wake: the target resolves from both env vars, fails closed on a partial pair", () => {
  assert.equal(resolvePlaneWakeTarget({}), undefined);
  assert.deepEqual(
    resolvePlaneWakeTarget({ WORKFLOW_PLANE_ACA_RESOURCE_GROUP: "rg-work", WORKFLOW_PLANE_ACA_APP: "plane-app" }),
    { resourceGroup: "rg-work", app: "plane-app" },
  );
  assert.throws(
    () => resolvePlaneWakeTarget({ WORKFLOW_PLANE_ACA_RESOURCE_GROUP: "rg-work" }),
    /requires BOTH/,
  );
  assert.throws(
    () => resolvePlaneWakeTarget({ WORKFLOW_PLANE_ACA_APP: "plane-app" }),
    /requires BOTH/,
  );
});

test("plane-wake: parses the az query JSON and rejects a non-object", () => {
  assert.deepEqual(
    parsePlaneResourceFacts(JSON.stringify({
      provisioningState: "Succeeded", runningStatus: "Running", minReplicas: 0,
    })),
    { exists: true, provisioningState: "Succeeded", runningStatus: "Running", minReplicas: 0 },
  );
  // A null leaf (az's missing-query rendering) stays absent, not a bogus value.
  assert.deepEqual(parsePlaneResourceFacts(JSON.stringify({ provisioningState: "Succeeded", runningStatus: null })), {
    exists: true, provisioningState: "Succeeded",
  });
  assert.equal(parsePlaneResourceFacts("not json"), undefined);
  assert.equal(parsePlaneResourceFacts("[]"), undefined);
});

test("plane-wake: the honest state lines name the state and the next step", () => {
  assert.match(planeStateLine({ kind: "ready", version: "2.0.10" }), /ready \(2\.0\.10\)/);
  assert.match(planeStateLine({ kind: "asleep", reason: "scaled to zero (minReplicas=0)" }), /asleep.*waking automatically/);
  assert.match(planeStateLine({ kind: "broken", reason: "plane resource not found" }), /cannot be woken: plane resource not found/);
  assert.match(planeStateLine({ kind: "no-az", reason: "no az cli session (log in to enable plane wake)" }), /log in to enable plane wake/);
});

// ── the explicit-gateway lane the launcher calls ────────────────────────────

const explicit = { gatewayUrl: "https://plane.example.net", tuiUsername: "opencode", tuiPassword: "pw" };

/** A fetch stub answering the authenticated /api/info health contract. */
function healthFetch(healthy: boolean): typeof fetch {
  return (async () => {
    if (!healthy) throw new Error("connection refused");
    return new Response(JSON.stringify({ version: "2.0.10", pid: 1, urls: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("plane-wake: an unconfigured wake still probes and reports broken honestly", async () => {
  const outcome = await ensureExplicitPlaneReady(explicit, {}, { fetchImpl: healthFetch(false) });
  assert.equal(outcome.state.kind, "broken");
  assert.match((outcome.state as { reason: string }).reason, /wake is not configured/);
});

test("plane-wake: an unconfigured wake reports ready when the gateway answers", async () => {
  const outcome = await ensureExplicitPlaneReady(explicit, {}, { fetchImpl: healthFetch(true) });
  assert.deepEqual(outcome.state, { kind: "ready", version: "2.0.10" });
});

test("plane-wake: the configured lane runs the injected wake path", async () => {
  let woke = false;
  let awake = false;
  const outcome = await ensureExplicitPlaneReady(
    explicit,
    { WORKFLOW_PLANE_ACA_RESOURCE_GROUP: "rg", WORKFLOW_PLANE_ACA_APP: "app" },
    {
      timeoutMs: 60_000,
      pollMs: 1,
      createDeps: () => ({
        probe: async () => (awake ? { version: "2.0.10" } : undefined),
        azSession: async () => true,
        show: async () => facts({ minReplicas: 0 }),
        wake: async () => { woke = true; awake = true; },
        sleep: async () => undefined,
      }),
    },
  );
  assert.equal(outcome.state.kind, "ready");
  assert.equal(woke, true, "the configured lane actually attempted the wake");
});

test("plane-wake: the az-backed deps build the exact show query and wake argv (no shell)", async () => {
  const calls: string[][] = [];
  const deps = createAzurePlaneWakeDeps({
    target: { resourceGroup: "rg-work", app: "plane-app" },
    gatewayUrl: "https://plane.example.net",
    auth: "Basic abc",
    azExec: async (args) => {
      calls.push([...args]);
      if (args[0] === "account") return "sub-id\n";
      return JSON.stringify({ provisioningState: "Succeeded", runningStatus: "Unknown", minReplicas: 0 });
    },
  });
  assert.equal(await deps.azSession(), true);
  assert.equal((await deps.show())?.minReplicas, 0);
  await deps.wake();
  // The session gate.
  assert.deepEqual(calls[0], ["account", "show", "--query", "id", "-o", "tsv"]);
  // The show query names the resource group + app and requests the four facts.
  assert.deepEqual(calls[1]?.slice(0, 4), ["containerapp", "show", "--name", "plane-app"]);
  assert.equal(calls[1]?.includes("--resource-group"), true);
  assert.equal(calls[1]?.includes("rg-work"), true);
  assert.match(calls[1]?.[calls[1].indexOf("--query") + 1] ?? "", /provisioningState.*runningStatus.*minReplicas/);
  // The wake is exactly `containerapp update --min-replicas 1`, no shell.
  assert.deepEqual(calls[2], [
    "containerapp", "update", "--name", "plane-app", "--resource-group", "rg-work", "--min-replicas", "1",
  ]);
});

test("plane-wake: an az session check that throws is false, never a wake", async () => {
  const notLoggedIn = createAzurePlaneWakeDeps({
    target: { resourceGroup: "rg", app: "app" },
    gatewayUrl: "https://x",
    auth: "Basic x",
    azExec: async (args) => {
      if (args[0] === "account") throw new Error("ERROR: not logged in");
      return "{}";
    },
  });
  assert.equal(await notLoggedIn.azSession(), false);
  // A failed show (non-zero exit) yields no facts -> the classifier reads broken.
  const failing = createAzurePlaneWakeDeps({
    target: { resourceGroup: "rg", app: "app" },
    gatewayUrl: "https://x",
    auth: "Basic x",
    azExec: async () => { throw new Error("resource not found"); },
  });
  assert.equal(await failing.show(), undefined);
});

test("plane-wake: main() wires the explicit lane through plane-awareness (anti-drift pin)", () => {
  // The LESS-0004 precedent: main() has no isolated unit test, so a
  // source-artifact pin proves the plane lane is CLASSIFIED and fails closed
  // rather than attaching to nothing — the W092 lesson (implemented != wired).
  const source = readFileSync(resolve(process.cwd(), "src", "cli", "opencode-attach.ts"), "utf8");
  assert.match(source, /ensureExplicitPlaneReady\(explicit, process\.env, \{/, "the launcher must classify the explicit plane");
  assert.match(source, /if \(outcome\.state\.kind !== "ready"\) \{/, "a non-ready plane must fail closed");
  assert.match(source, /throw new Error\(planeStateLine\(outcome\.state\)\);/, "the failure must carry the honest state line");
});
