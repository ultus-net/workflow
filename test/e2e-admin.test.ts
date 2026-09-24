import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { distArtifact, ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

// W130 — the admin control plane's HTTP contract e2e (the e2e stream's
// security surface). The W126 sweep proved the admin bin STARTS and tears
// down; the credential-custody CONTRACT — the token gate, the cross-origin
// mutation refusal, the content-type/body validation, the audit trail, the
// value-never-echoed rule — was never exercised over the compiled seat, and
// this is the surface that holds the operator's secrets.
//
// What the contract pins (src/ui/admin-control-plane.ts, src/cli/admin.ts):
//   - GET / serves the credential-custody shell PUBLICLY (the token gates
//     the API, not the page) — with the control plane's CSP header
//     (frame-ancestors 'none').
//   - /api/admin/* without the Bearer token → 401 "admin capability
//     required"; a WRONG token → 401 too (the timing-safe comparison path);
//     an unknown /api/admin route → 404.
//   - An authed PUT with a cross-origin Origin header → 403 "cross-origin
//     mutation denied" (the trusted-mutation gate, checked BEFORE the body).
//   - PUT without application/json → 415; PUT with an invalid credential
//     body → 400.
//   - The happy path: PUT stores, GET lists METADATA ONLY (the secret value
//     is never echoed — asserted on the response body field-by-field), and
//     the DELETE + audit trail record set/revoke without the value ever
//     appearing in the process output.
//   - Teardown: the admin's own SIGTERM shutdown exits 0.
//
// Honesty claims: the revoked credential's post-state is pinned as OBSERVED
// (run-first, then pinned — revoke's semantics in src/integrations/
// credentials.ts decide what the listing carries afterwards). The audit
// lines are the admin's own console.log of its audit callback.
//
// SAFETY CONTRACT (LESS-0051): no agent or PTY spawns ever; the credential
// config lives under a redirected HOME (fresh mkdtemp, removed after); the
// server binds an ephemeral port (WORKFLOW_ADMIN_PORT=0); the kill is the
// process-group SIGTERM with a SIGKILL backstop; spawnSync is not used for
// the daemon (its timeout-kill cannot see a clean teardown). The admin token
// is a W130 test constant (its only power is over this ephemeral process).
//
// KEYRING HONESTY (the round-1 review's P2 — recorded, not hidden): the
// redirected HOME confines only the credential CONFIG file — the secret
// MATERIAL is stored by createSecretServiceStore through `secret-tool` into
// the operator's LIVE system keyring (D-Bus, service "workflow"). This e2e
// stores ONE test credential (the w130- prefixed id; clobbering a real
// credential is implausible by the prefix) whose cleanup is the in-test
// DELETE plus an after-hook best-effort revoke; a failure between the PUT
// and the cleanup can orphan that keyring entry (the recorded residual).
// The surface is also MACHINE-GATED on secret-tool + an unlocked keyring:
// without them the store throws, the control plane answers 400, and this
// test fails closed — visible, never skipped.

const ADMIN_TOKEN = "w130-e2e-admin-capability-token-0123456789abcdef";
const SECRET_VALUE = "w130-e2e-secret-value-DO-NOT-ECHO";
const CREDENTIAL_ID = "w130-e2e-credential";

test("W130: the compiled admin control plane serves the credential contract end to end — the token gate, mutation validation, the audit trail, and the clean teardown", async (context) => {
  ensureFresh(distArtifact("cli", "admin.js"));
  const home = mkdtempSync(join(tmpdir(), "w130-admin-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  let output = "";
  let exitInfo: { code: number | null; signal: string | null } | undefined;
  const child = spawn(process.execPath, ["dist/cli/admin.js"], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, WORKFLOW_ADMIN_PORT: "0", WORKFLOW_ADMIN_TOKEN: ADMIN_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.once("exit", (code, signal) => { exitInfo = { code, signal }; });
  let storedCredential = false;
  let adminUrl = "";
  // The after-hook best-effort cleanup (the round-1 review's P2): node:test
  // runs after hooks in reverse registration order, so this — registered
  // after the kill hook — runs BEFORE the kill while the server is still
  // alive: a test failure between the PUT and the in-test DELETE still
  // revokes the keyring entry. (node:test hook order confirmed against the
  // runner's behavior; if the server is already gone, the entry may orphan —
  // the recorded residual.)
  context.after(async () => {
    if (storedCredential && exitInfo === undefined && adminUrl !== "") {
      try {
        await fetch(`${adminUrl}/api/admin/credentials/${CREDENTIAL_ID}`, {
          method: "DELETE", headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        });
      } catch { /* best-effort: the recorded residual covers the orphan case */ }
    }
  });
  context.after(() => {
    if (exitInfo === undefined) {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { /* exited */ }
    }
  });
  const deadline = Date.now() + 20_000;
  let baseUrl = "";
  while (baseUrl === "" && exitInfo === undefined && Date.now() < deadline) {
    const match = /Workflow admin listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match !== null) baseUrl = `http://127.0.0.1:${match[1] ?? ""}`;
    else await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(baseUrl !== "", `the admin banner never appeared within 20s — output: ${output.slice(0, 500)}`);
  adminUrl = baseUrl;
  const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const jsonHeaders = { ...auth, "content-type": "application/json" };

  // The page is public; the token gates the API, not the shell — and the
  // shell carries the control plane's CSP (frame-ancestors 'none').
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.ok((await page.text()).includes("Credential custody"), "the admin page serves the credential-custody shell");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, "the page carries the CSP with frame-ancestors 'none'");

  // The token gate: anonymous, wrong-token (the timing-safe path), unknown
  // route.
  const anonymous = await fetch(`${baseUrl}/api/admin/credentials`);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: "admin capability required" });
  const wrongToken = await fetch(`${baseUrl}/api/admin/credentials`, {
    headers: { authorization: `Bearer ${"w".repeat(ADMIN_TOKEN.length)}` },
  });
  assert.equal(wrongToken.status, 401, "a wrong token of the right length is refused (the timing-safe comparison path)");
  const unknownRoute = await fetch(`${baseUrl}/api/admin/unknown`, { headers: auth });
  assert.equal(unknownRoute.status, 404);

  // The mutation gate: an authed cross-origin PUT is refused BEFORE the body
  // is read.
  const crossOrigin = await fetch(`${baseUrl}/api/admin/credentials`, {
    method: "PUT",
    headers: { ...auth, origin: "http://evil.example", "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: "cross-origin mutation denied" });

  // The content-type and body validation.
  const wrongType = await fetch(`${baseUrl}/api/admin/credentials`, { method: "PUT", headers: auth, body: "nope" });
  assert.equal(wrongType.status, 415);
  const invalid = await fetch(`${baseUrl}/api/admin/credentials`, {
    method: "PUT", headers: jsonHeaders, body: JSON.stringify({ id: "bad" }),
  });
  assert.equal(invalid.status, 400);

  // The happy path: store → list (metadata only) → revoke → observed state.
  const put = await fetch(`${baseUrl}/api/admin/credentials`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({
      id: CREDENTIAL_ID,
      label: "W130 e2e credential",
      kind: "api-key",
      value: SECRET_VALUE,
      allowedConsumers: ["mcp:workflow-guard"],
      allowedPurposes: ["stdio-env:W130_TOKEN"],
    }),
  });
  assert.equal(put.status, 204, `the store must succeed — body: ${await put.text()}`);
  storedCredential = true;
  const listed = await fetch(`${baseUrl}/api/admin/credentials`, { headers: auth });
  assert.equal(listed.status, 200);
  // Channel completeness (the round-1 review's note): read the RAW listing
  // body once and check the WHOLE body for the secret — not just the entry's
  // known fields — before parsing it for the field pins.
  const listedText = await listed.text();
  assert.ok(!listedText.includes(SECRET_VALUE), "the raw listing body never contains the secret value");
  const listedBody = JSON.parse(listedText) as Array<Record<string, unknown>>;
  const entry = listedBody.find((credential) => credential.id === CREDENTIAL_ID);
  assert.ok(entry !== undefined, "the stored credential's metadata is listed");
  assert.equal(entry.configured, true, "the stored credential reports configured");
  assert.equal(entry.label, "W130 e2e credential");
  assert.ok(!("value" in entry), "the listing carries metadata only — the secret value is never echoed");
  const deleteStored = await fetch(`${baseUrl}/api/admin/credentials/${CREDENTIAL_ID}`, { method: "DELETE", headers: auth });
  assert.equal(deleteStored.status, 204, "the revoke succeeds");
  const afterList = await fetch(`${baseUrl}/api/admin/credentials`, { headers: auth });
  const afterBody = (await afterList.json()) as Array<Record<string, unknown>>;
  // revoke DELETES the definition (src/integrations/credentials.ts:145 —
  // definitions.delete), so the listing no longer carries it; a failed
  // onDefinitionsChanged rolls back (the credentials.ts:146-149 path, not
  // exercised here).
  const afterEntry = afterBody.find((credential) => credential.id === CREDENTIAL_ID);
  assert.ok(
    afterEntry === undefined,
    "after the revoke the definition is deleted from the listing (credentials.ts:145)",
  );
  const deleteUnknown = await fetch(`${baseUrl}/api/admin/credentials/w130-unknown`, { method: "DELETE", headers: auth });
  assert.equal(deleteUnknown.status, 404, "revoking an unknown id is a 404");

  // The audit trail records set + revoke — and the secret value never
  // appears anywhere in the process output. The revoke line is bound to the
  // credential id the same way the set line is (the round-1 review's P3).
  assert.ok(output.includes('"action":"set"') && output.includes(`"credentialId":"${CREDENTIAL_ID}"`), `the audit trail records the set — output: ${output.slice(0, 600)}`);
  assert.ok(output.includes(`"action":"revoke","credentialId":"${CREDENTIAL_ID}"`), `the audit trail records the revoke for this credential — output: ${output.slice(0, 600)}`);
  assert.ok(!output.includes(SECRET_VALUE), "the secret value never appears in the process output");

  // Teardown: the admin's own SIGTERM shutdown → exit 0.
  if (exitInfo === undefined) {
    try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { /* exited */ }
    exitInfo = await new Promise((resolveExit) => {
      const hardKill = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* exited */ }
      }, 15_000);
      child.once("exit", (code, signal) => {
        clearTimeout(hardKill);
        resolveExit({ code, signal });
      });
    });
  }
  assert.equal(exitInfo?.signal ?? null, null, `died by ${exitInfo?.signal ?? "nothing"} instead of its own SIGTERM shutdown — output: ${output.slice(0, 400)}`);
  assert.equal(exitInfo?.code ?? null, 0, `after SIGTERM the shutdown should exit 0 — output: ${output.slice(0, 400)}`);
});