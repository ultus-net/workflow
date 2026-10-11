import assert from "node:assert/strict";
import test from "node:test";

/**
 * C1 LSP live probe — the deploy-gated acceptance instrument for the plane's
 * LSP wire, measured through Azure Container Apps ingress.
 *
 * Gated: `WORKFLOW_AZURE_PLANE_LSP_PROBE=1`. It skips honestly without the gate
 * (the repo's gated-probe convention, `docs/FEATURES.md:50`; never in the
 * default `test:ci`), mirroring `test/c1-plane-probe.test.ts`'s skip mechanism.
 * The token-spending diagnostic arm is gated SEPARATELY on
 * `WORKFLOW_AZURE_PLANE_LSP_DIAGNOSTIC=1` and is an honest documented skip —
 * never a fake pass. Both gates are registered in `docs/PROBE_VERDICTS.json`;
 * both are `pending` until the first live run.
 *
 * Required environment when the gate is set (a missing one fails the probe,
 * never a silent skip):
 *   WORKFLOW_AZURE_PLANE_URL               the plane base URL (https://<fqdn>)
 *   WORKFLOW_AZURE_PLANE_CLIENT_PASSWORD   the client-facing gateway credential
 *
 * Honesty: the only token-free HTTP LSP route in opencode v2 is
 * `GET /api/lsp` (`getLsp` -> `LSP.status()`), returning
 * `LSP.Status[] = {id, name, root, status: "connected" | "error"}`. It answers
 * `[]` until a client is spawned, and a client is only spawned by a file touch,
 * which requires a token-spending write/edit tool turn. So this probe asserts
 * the route is REACHABLE through the gateway and WELL-FORMED (HTTP 200 + a JSON
 * array); an empty array is the honest pre-touch state, never a failure. Real
 * diagnostic delivery cannot be exercised here without a model key, so no
 * diagnostic claim is made — see the diagnostic arm below.
 */

const runLspProbe = process.env.WORKFLOW_AZURE_PLANE_LSP_PROBE === "1";
const runLspDiagnostic = process.env.WORKFLOW_AZURE_PLANE_LSP_DIAGNOSTIC === "1";

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

test("C1 LSP live probe: GET /api/lsp is reachable through the gateway and well-formed", { skip: !runLspProbe, timeout: 60_000 }, async () => {
  const target = resolveTarget();
  // The plane must be healthy before the LSP route is measured: /api/info is
  // the health route the sibling C1 probe already qualifies, so a 200 here
  // means the LSP route is being read on a live plane, not a half-started one.
  const info = await request(target, "/api/info", { headers: { authorization: target.auth } });
  assert.equal(info.status, 200, "the plane must answer authenticated /api/info (200) before the LSP route is measured");

  const response = await request(target, "/api/lsp", { headers: { authorization: target.auth } });
  assert.equal(response.status, 200, "GET /api/lsp must be reachable through the gateway with the client credential");
  const body: unknown = await response.json();
  assert.ok(Array.isArray(body), "GET /api/lsp must return a JSON array (LSP.Status[])");

  // The route answers [] until an LSP client is spawned, and opencode spawns a
  // client only on a file touch — which requires a token-spending write/edit
  // tool turn. So an empty array is the honest pre-touch state: this arm asserts
  // reachability + shape and MUST NOT fail on it. When a client IS present, the
  // typescript entry the plane is provisioned with must read "connected".
  const entries = body as Array<{ id?: unknown; status?: unknown }>;
  const typescript = entries.find((entry) => entry.id === "typescript");
  if (typescript !== undefined) {
    assert.equal(
      typescript.status,
      "connected",
      "a present typescript LSP entry must be status 'connected' (an 'error' entry means the baked server failed to start)",
    );
  }
});

// Arm B — diagnostic delivery. It is gated on its own env, but it asserts NOTHING
// and is deliberately reported as a skip (node:test skip, never a fake pass): a
// real diagnostic is produced only by a model turn that writes/edits a file
// (write/edit -> touchFile -> diagnostics embedded in the tool output), which
// spends model tokens this token-free probe does not have. The arm exists so the
// token dependency is recorded rather than faked; no live diagnostic verdict is
// claimed.
test("C1 LSP live probe (diagnostic arm): diagnostic delivery requires a model-key turn", { skip: !runLspDiagnostic }, (t) => {
  t.skip("diagnostic delivery needs a model key and a write/edit tool turn (touchFile -> diagnostics in the tool output); this token-free probe cannot produce one — no live diagnostic claim is made");
});
