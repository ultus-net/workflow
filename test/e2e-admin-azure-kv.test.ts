import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { distArtifact, ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

// W156 — the admin control plane's credential contract over the AZURE-KV
// store (the lane the keyring seat cannot cover). The keyring lane
// (test/e2e-admin.test.ts) keeps its D-Bus machine-gate; this lane proves
// the same control plane, driven through `WORKFLOW_SECRET_STORE=azure-kv`,
// stores/lists/revokes WITHOUT gnome-keyring and without any network.
//
// What is real and what is faked (the honesty line): the compiled admin bin
// runs as a child process; `resolveSecretStore` builds the REAL
// KeyVaultSecretStore; the store executes its full path — IMDS token fetch
// and parsing, canonical vault URL construction, Bearer headers, the vault
// REST PUT/GET/DELETE shapes, error surfacing. The only fake is the
// TRANSPORT: a preload hook (test/fixtures/kv-fetch-hook.cjs via
// NODE_OPTIONS=--require) redirects exactly two hostnames (the lane's
// canonical kv-test.vault.azure.net and the IMDS endpoint) to an in-test
// fake-vault HTTP server, because DNS cannot be redirected for a child
// process in CI. The fake vault is an in-memory map plus the IMDS token
// shape ({access_token, expires_in}).
//
// What this lane pins beyond the unit pins (test/key-vault-store.test.ts):
//   - the seam end to end through the compiled bin: env selection
//     (WORKFLOW_SECRET_STORE=azure-kv + WORKFLOW_KEYVAULT_NAME) reaches the
//     real store, and a stored credential physically lands in the fake
//     vault (asserted on the fake's own state, not just the HTTP 204);
//   - the control-plane contract over that store: token gate, PUT → 204,
//     metadata-only listing, revoke → 204, the audit trail, and the value
//     never echoed anywhere;
//   - the fail-closed error path: a vault 500 surfaces as the control
//     plane's 400 {"error":"invalid credential"} (the same catch-all the
//     keyring lane's machine-gate exercises), never partial state.
//
// SAFETY CONTRACT (LESS-0051): no agent or PTY spawns; HOME redirected to a
// fresh mkdtemp (removed after); ephemeral ports (WORKFLOW_ADMIN_PORT=0 and
// the fake vault's port 0); the kill is the process-group SIGTERM with a
// SIGKILL backstop; no spawnSync for the daemon. Unlike the keyring lane
// there is NO orphan residual: the fake vault lives inside this test
// process, so a mid-test failure cannot leak credential material anywhere.
//
// The lane runs ungated in tier B because it is hermetic (the recorded
// W156 criterion's env gate, WORKFLOW_TEST_KEYVAULT_*, is reserved for the
// future gated LIVE-vault probe — the deferred half of the residual
// decision, not built here).

const ADMIN_TOKEN = "w156-kv-lane-admin-capability-token-0123456789";
const SECRET_VALUE = "w156-kv-lane-secret-DO-NOT-ECHO";
const CREDENTIAL_ID = "w156-kv-lane-credential";
const FAILURE_ID = "w156-kv-lane-failure";

type FakeVault = {
  server: Server;
  port: number;
  secrets: Map<string, string>;
};

function startFakeVault(): Promise<FakeVault> {
  const secrets = new Map<string, string>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    // The IMDS shape the real token path parses (expires_in drives the
    // token cache's real-expiry honoring).
    if (url.pathname === "/metadata/identity/oauth2/token") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "kv-fake-imds-token", expires_in: "3600" }));
      return;
    }
    const match = /\/secrets\/([^/?]+)/.exec(url.pathname);
    if (match === null) {
      response.writeHead(404).end();
      return;
    }
    const id = decodeURIComponent(match[1] ?? "");
    if (request.method === "PUT") {
      let raw = "";
      request.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
      request.on("end", () => {
        // The deterministic failure lane: this id always 500s, so the
        // control plane's catch-all is exercised through the REAL store's
        // error path.
        if (id === FAILURE_ID) {
          response.writeHead(500).end();
          return;
        }
        try {
          const parsed = JSON.parse(raw) as { value?: unknown };
          if (typeof parsed.value !== "string") {
            response.writeHead(400).end();
            return;
          }
          secrets.set(id, parsed.value);
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
      return;
    }
    if (request.method === "GET") {
      const value = secrets.get(id);
      if (value === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value }));
      return;
    }
    if (request.method === "DELETE") {
      const existed = secrets.delete(id);
      response.writeHead(existed ? 204 : 404).end();
      return;
    }
    response.writeHead(405).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({ server, port, secrets });
    });
  });
}

test("W156: the admin control plane serves the credential contract over the azure-kv store end to end (hermetic fake-vault lane)", async (context) => {
  ensureFresh(distArtifact("cli", "admin.js"));
  const fake = await startFakeVault();
  context.after(() => fake.server.close());
  const home = mkdtempSync(join(tmpdir(), "w156-kv-admin-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));

  const hookPath = join(repoRoot, "test", "fixtures", "kv-fetch-hook.cjs");
  let output = "";
  let exitInfo: { code: number | null; signal: string | null } | undefined;
  const child = spawn(process.execPath, ["dist/cli/admin.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      WORKFLOW_ADMIN_PORT: "0",
      WORKFLOW_ADMIN_TOKEN: ADMIN_TOKEN,
      WORKFLOW_SECRET_STORE: "azure-kv",
      WORKFLOW_KEYVAULT_NAME: "kv-test",
      WORKFLOW_TEST_KV_FAKE_TARGET: `http://127.0.0.1:${fake.port}`,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--require ${hookPath}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.once("exit", (code, signal) => { exitInfo = { code, signal }; });
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
  const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const jsonHeaders = { ...auth, "content-type": "application/json" };

  // The token gate still fronts the azure-kv-backed control plane.
  const anonymous = await fetch(`${baseUrl}/api/admin/credentials`);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: "admin capability required" });

  // The happy path through the REAL store into the fake vault: PUT → 204,
  // and the fake vault's own state holds the value (direct evidence the
  // request traversed resolveSecretStore → KeyVaultSecretStore → REST →
  // transport, not some in-memory shortcut).
  const put = await fetch(`${baseUrl}/api/admin/credentials`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({
      id: CREDENTIAL_ID,
      label: "W156 azure-kv lane credential",
      kind: "api-key",
      value: SECRET_VALUE,
      allowedConsumers: ["mcp:workflow-guard"],
      allowedPurposes: ["stdio-env:W156_TOKEN"],
    }),
  });
  assert.equal(put.status, 204, `the azure-kv store must succeed — body: ${await put.text()}`);
  assert.equal(fake.secrets.get(CREDENTIAL_ID), SECRET_VALUE, "the credential value physically landed in the (fake) vault");

  // Metadata-only listing: the raw body never carries the secret.
  const listed = await fetch(`${baseUrl}/api/admin/credentials`, { headers: auth });
  assert.equal(listed.status, 200);
  const listedText = await listed.text();
  assert.ok(!listedText.includes(SECRET_VALUE), "the raw listing body never contains the secret value");
  const listedBody = JSON.parse(listedText) as Array<Record<string, unknown>>;
  const entry = listedBody.find((credential) => credential.id === CREDENTIAL_ID);
  assert.ok(entry !== undefined, "the stored credential's metadata is listed");
  assert.equal(entry.configured, true, "the azure-kv-backed credential reports configured");
  assert.ok(!("value" in entry), "the listing carries metadata only");

  // The fail-closed error path through the REAL store: the fake vault 500s
  // this id, the store surfaces credential-service-unavailable, and the
  // control plane answers its catch-all 400 — the value must not land.
  const failingPut = await fetch(`${baseUrl}/api/admin/credentials`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({
      id: FAILURE_ID,
      label: "W156 failure lane",
      kind: "api-key",
      value: SECRET_VALUE,
      allowedConsumers: ["mcp:workflow-guard"],
      allowedPurposes: ["stdio-env:W156_TOKEN"],
    }),
  });
  const failureBody = await failingPut.text();
  assert.equal(failingPut.status, 400, `a vault failure must surface as the catch-all 400 — body: ${failureBody}`);
  assert.deepEqual(JSON.parse(failureBody), { error: "invalid credential" });
  assert.equal(fake.secrets.has(FAILURE_ID), false, "a failed store never leaves partial state in the vault");

  // Revoke: DELETE → 204, and the vault entry is really gone.
  const deleted = await fetch(`${baseUrl}/api/admin/credentials/${CREDENTIAL_ID}`, { method: "DELETE", headers: auth });
  assert.equal(deleted.status, 204, "the revoke succeeds through the azure-kv store");
  assert.equal(fake.secrets.has(CREDENTIAL_ID), false, "the revoke deleted the vault entry");
  const afterList = await fetch(`${baseUrl}/api/admin/credentials`, { headers: auth });
  const afterBody = (await afterList.json()) as Array<Record<string, unknown>>;
  assert.equal(afterBody.find((credential) => credential.id === CREDENTIAL_ID), undefined, "the listing no longer carries the revoked credential");

  // The audit trail records set + revoke; the secret value never appears in
  // the process output.
  assert.ok(output.includes('"action":"set"') && output.includes(`"credentialId":"${CREDENTIAL_ID}"`), `the audit trail records the set — output: ${output.slice(0, 600)}`);
  assert.ok(output.includes(`"action":"revoke","credentialId":"${CREDENTIAL_ID}"`), `the audit trail records the revoke — output: ${output.slice(0, 600)}`);
  assert.ok(!output.includes(SECRET_VALUE), "the secret value never appears in the process output");

  // Teardown: the admin's own SIGTERM shutdown exits 0 (same contract as the
  // keyring lane).
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
