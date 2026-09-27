import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { distArtifact, ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

// W156 — the LIVE half of the azure-kv custody lane: the same control-plane
// contract as test/e2e-admin-azure-kv.test.ts, but against a REAL Key Vault
// with NOTHING faked. The residual decision's recorded shape is BOTH: the
// hermetic fake-transport lane (which runs ungated in tier B) proves the
// contract through the store's full code path; THIS lane completes the pair
// by exercising the one thing a fake cannot — the real token acquisition and
// the real vault endpoint over real TLS.
//
// THE GATE (the exact variable this lane skips on):
//   WORKFLOW_TEST_KEYVAULT_URL — the full canonical vault URI
//   (https://<name>.vault.azure.net) of a vault the operator names. It is
//   the only WORKFLOW_TEST_KEYVAULT_* variable this lane reads; the child
//   receives it as WORKFLOW_KEYVAULT_URI (the store seam's own env var).
//   Absent → this lane SKIPS with an honest message (the fake lane covers
//   the contract ungated). Set but malformed → FAIL, never skip: an
//   operator-set gate means "run live"; a typo must not look like a pass.
//
// What is real here (the honesty line): the compiled admin bin runs as a
// child process with WORKFLOW_SECRET_STORE=azure-kv; `resolveSecretStore`
// builds the REAL KeyVaultSecretStore; the store's token path is NEVER
// stubbed — live IMDS when the environment provides it (MSI_ENDPOINT /
// IDENTITY_ENDPOINT are deliberately NOT cleared here, unlike the fake
// lane, because managed identity is the legitimate live source), azure-cli
// otherwise. The vault REST calls ride real DNS and TLS.
//
// Independent evidence (the live analogue of the fake lane's fake.secrets
// check): the value's landing is verified by a DIRECT vault REST read that
// shares no code with src — a raw fetch bearing an azure-cli-minted token —
// and after the revoke the same read answers 404. A broken store therefore
// fails this lane twice over: its PUT fails the control-plane 204, and any
// store that lied about success fails the independent read.
//
// Prerequisites (fail closed, never skip): a token source the operator's
// identity can use — azure-cli logged in (`az account get-access-token`),
// or a live IMDS endpoint — and vault get/set/delete permission on the
// named vault for the same identity the direct reads ride.
//
// LIVE-VAULT CLEANUP DISCIPLINE (this lane writes REAL secret material):
//   - the credential id is unique per run (`w156-kv-live-<8hex>`), so runs
//     never clobber each other or any real credential (the W130 lane's
//     namespace convention, applied to a real vault);
//   - the in-flow revoke (DELETE → 204) is the primary cleanup, and an
//     after-hook best-effort revoke is declared BEFORE the kill hook (after
//     hooks run FIFO — W130's verified ordering), so a mid-test failure
//     still revokes while the server is alive;
//   - a revoked Key Vault secret is SOFT-deleted: it stays recoverable in
//     the vault's deleted state until the vault's retention window
//     auto-purges it. This lane never purges — an irreversible operation on
//     operator infrastructure is the operator's call. The per-run namespace
//     plus auto-purge bounds the residue.
//
// SAFETY CONTRACT (LESS-0051): no agent or PTY spawns; HOME redirected to a
// fresh mkdtemp (removed after); ephemeral admin port (WORKFLOW_ADMIN_PORT=0);
// the kill is the process-group SIGTERM with a SIGKILL backstop; no
// spawnSync for the daemon.
//
// CI posture: this lane is NOT in `test:ci` (the curated tier-B set stays
// hermetic — no live-network side effects from PR CI, the acp-probe
// precedent). It runs when the operator sets the gate env.

const ADMIN_TOKEN = "w156-kv-live-admin-capability-token-0123456789abcdef";
const SECRET_VALUE = "w156-kv-live-secret-DO-NOT-ECHO";
const GATE_VAR = "WORKFLOW_TEST_KEYVAULT_URL";
// The exact canonical shape the store itself enforces (src/integrations/
// key-vault.ts) — asserting it here fails the lane on a typo'd gate BEFORE
// any spawn or network call.
const VAULT_SHAPE = /^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net$/;

const vaultUrl = process.env[GATE_VAR]?.trim() ?? "";
const skipReason =
  vaultUrl === ""
    ? "the live-vault lane runs only against a real Key Vault the operator names — set WORKFLOW_TEST_KEYVAULT_URL (https://<name>.vault.azure.net); the hermetic fake-vault lane (test/e2e-admin-azure-kv.test.ts) covers the same control-plane contract ungated"
    : false;

const execFileP = promisify(execFile);

// The independent token source for the vault-side reads: the same azure-cli
// invocation shape the store's own local chain uses (--resource, tsv), so
// the lane's reads and the store's writes ride the same identity.
async function azVaultToken(): Promise<string> {
  const result = await execFileP(
    "az",
    ["account", "get-access-token", "--resource", "https://vault.azure.net", "--query", "accessToken", "-o", "tsv"],
    { encoding: "utf8" },
  );
  const token = result.stdout.trim();
  assert.ok(token !== "", "az returned no access token — the live lane's independent vault reads need a logged-in azure-cli (or run the lane where IMDS is live)");
  return token;
}

async function readVaultSecret(id: string): Promise<Response> {
  const token = await azVaultToken();
  return fetch(`${vaultUrl}/secrets/${encodeURIComponent(id)}?api-version=7.4`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

test("W156: the admin control plane serves the credential contract over a LIVE azure-kv vault (gated lane: WORKFLOW_TEST_KEYVAULT_URL; skips honestly without it)", { skip: skipReason, timeout: 120_000 }, async (context) => {
  // A set-but-malformed gate fails closed BEFORE any spawn or network call:
  // an operator-set gate means "run live", and a typo must never degrade
  // into a skip (that would look like a pass while proving nothing).
  assert.match(
    vaultUrl,
    VAULT_SHAPE,
    `${GATE_VAR} is set but not a canonical vault URI (expected https://<name>.vault.azure.net) — fix the gate rather than skipping the lane`,
  );

  ensureFresh(distArtifact("cli", "admin.js"));
  const home = mkdtempSync(join(tmpdir(), "w156-kv-live-home-"));
  // Per-run unique id: runs never clobber each other or a real credential
  // (revoked secrets soft-delete into the vault's recoverable state).
  const credentialId = `w156-kv-live-${randomUUID().replaceAll("-", "").slice(0, 8)}`;

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    WORKFLOW_ADMIN_PORT: "0",
    WORKFLOW_ADMIN_TOKEN: ADMIN_TOKEN,
    WORKFLOW_SECRET_STORE: "azure-kv",
    WORKFLOW_KEYVAULT_URI: vaultUrl,
  };
  // The lane's URI is the sole vault authority: an ambient
  // WORKFLOW_KEYVAULT_NAME must not quietly point the store elsewhere.
  delete childEnv.WORKFLOW_KEYVAULT_NAME;
  // The live lane never rides the fake-transport hook (the fixture is inert
  // without WORKFLOW_TEST_KV_FAKE_TARGET; deleting it pins that even an
  // ambient NODE_OPTIONS --require of the hook stays a no-op here).
  delete childEnv.WORKFLOW_TEST_KV_FAKE_TARGET;
  // MSI_ENDPOINT/IDENTITY_ENDPOINT are deliberately KEPT (unlike the fake
  // lane): on Azure, managed identity IS the live token source.

  let output = "";
  let exitInfo: { code: number | null; signal: string | null } | undefined;
  const child = spawn(process.execPath, ["dist/cli/admin.js"], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.once("exit", (code, signal) => { exitInfo = { code, signal }; });

  let storedCredential = false;
  let adminUrl = "";
  // The W130 FIFO ordering, load-bearing: the best-effort LIVE-vault revoke
  // is declared BEFORE the kill hook so a mid-test failure still revokes the
  // real secret while the server is alive; the home cleanup is LAST.
  context.after(async () => {
    if (storedCredential && adminUrl !== "" && exitInfo === undefined) {
      try {
        await fetch(`${adminUrl}/api/admin/credentials/${credentialId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        });
      } catch { /* best-effort: the soft-delete residue is bounded by the per-run id */ }
    }
  });
  context.after(() => {
    if (exitInfo === undefined) {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { /* exited */ }
    }
  });
  context.after(() => rmSync(home, { recursive: true, force: true }));

  const deadline = Date.now() + 20_000;
  while (adminUrl === "" && exitInfo === undefined && Date.now() < deadline) {
    const match = /Workflow admin listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match !== null) adminUrl = `http://127.0.0.1:${match[1] ?? ""}`;
    else await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(adminUrl !== "", `the admin banner never appeared within 20s — output: ${output.slice(0, 500)}`);
  const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const jsonHeaders = { ...auth, "content-type": "application/json" };

  // The token gate still fronts the live-vault-backed control plane.
  const anonymous = await fetch(`${adminUrl}/api/admin/credentials`);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: "admin capability required" });

  // The happy path through the REAL store into the REAL vault: PUT → 204.
  // A broken store (bad URL, dead token, missing permission) surfaces here
  // as the catch-all 400 and fails the lane.
  const put = await fetch(`${adminUrl}/api/admin/credentials`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({
      id: credentialId,
      label: "W156 live-vault lane credential",
      kind: "api-key",
      value: SECRET_VALUE,
      allowedConsumers: ["mcp:workflow-guard"],
      allowedPurposes: ["stdio-env:W156_LIVE_TOKEN"],
    }),
  });
  assert.equal(put.status, 204, `the live azure-kv store must succeed — body: ${await put.text()}`);
  storedCredential = true;

  // INDEPENDENT evidence the value physically landed in the REAL vault: a
  // raw vault REST read (azure-cli token, no src involvement) — the live
  // analogue of the fake lane's fake.secrets assertion.
  const landed = await readVaultSecret(credentialId);
  assert.equal(landed.status, 200, `the independent vault read must see the stored secret — status ${landed.status}: ${await landed.text()}`);
  assert.equal(((await landed.json()) as { value?: string }).value, SECRET_VALUE, "the independent vault read returns the stored value");

  // Metadata-only listing: the raw body never carries the secret.
  const listed = await fetch(`${adminUrl}/api/admin/credentials`, { headers: auth });
  assert.equal(listed.status, 200);
  const listedText = await listed.text();
  assert.ok(!listedText.includes(SECRET_VALUE), "the raw listing body never contains the secret value");
  const listedBody = JSON.parse(listedText) as Array<Record<string, unknown>>;
  const entry = listedBody.find((credential) => credential.id === credentialId);
  assert.ok(entry !== undefined, "the stored credential's metadata is listed");
  assert.equal(entry.configured, true, "the live-vault-backed credential reports configured");
  assert.ok(!("value" in entry), "the listing carries metadata only");

  // Revoke: DELETE → 204, and the REAL vault really dropped it — the same
  // independent read now answers 404 (a soft-deleted secret is not
  // retrievable via GET).
  const deleted = await fetch(`${adminUrl}/api/admin/credentials/${credentialId}`, { method: "DELETE", headers: auth });
  assert.equal(deleted.status, 204, "the revoke succeeds through the live azure-kv store");
  storedCredential = false;
  const gone = await readVaultSecret(credentialId);
  assert.equal(gone.status, 404, `the independent vault read must answer 404 after the revoke — status ${gone.status}: ${await gone.text()}`);
  const afterList = await fetch(`${adminUrl}/api/admin/credentials`, { headers: auth });
  const afterBody = (await afterList.json()) as Array<Record<string, unknown>>;
  assert.equal(afterBody.find((credential) => credential.id === credentialId), undefined, "the listing no longer carries the revoked credential");

  // The audit trail records set + revoke; the secret value never appears in
  // the process output.
  assert.ok(output.includes('"action":"set"') && output.includes(`"credentialId":"${credentialId}"`), `the audit trail records the set — output: ${output.slice(0, 600)}`);
  assert.ok(output.includes(`"action":"revoke","credentialId":"${credentialId}"`), `the audit trail records the revoke — output: ${output.slice(0, 600)}`);
  assert.ok(!output.includes(SECRET_VALUE), "the secret value never appears in the process output");

  // Teardown: the admin's own SIGTERM shutdown exits 0 (same contract as the
  // sibling lanes).
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
