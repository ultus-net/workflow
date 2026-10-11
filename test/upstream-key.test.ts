import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  UPSTREAM_KEY_ENV,
  LEGACY_UPSTREAM_KEY_ENV,
  UPSTREAM_KEY_SECRET_NAME,
  legacyUpstreamKeyFilePath,
  loadUpstreamApiKey,
  loadUpstreamApiKeyFromSecretStore,
  readUpstreamKeyFile,
  readWorkflowKeyFile,
  syntheticKeyPresent,
  upstreamKeyFilePath,
  upstreamKeyFromEnv,
  upstreamKeyPresent,
} from "../src/integrations/upstream-key.js";
import { SYNTHETIC_KEY_FILE, SYNTHETIC_KEY_ENV } from "../src/integrations/synthetic-provider.js";
import type { SecretStore } from "../src/integrations/credentials.js";

function withHome(files: { canonical?: string; legacy?: string }): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "wf-upstream-key-"));
  const dir = join(home, ".config", "workflow");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (files.canonical !== undefined) writeFileSync(upstreamKeyFilePath(home), files.canonical, { mode: 0o600 });
  if (files.legacy !== undefined) writeFileSync(legacyUpstreamKeyFilePath(home), files.legacy, { mode: 0o600 });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("canonical env wins over the legacy env, and whitespace falls through", () => {
  assert.equal(upstreamKeyFromEnv({ [UPSTREAM_KEY_ENV]: "canonical", [LEGACY_UPSTREAM_KEY_ENV]: "legacy" } as NodeJS.ProcessEnv), "canonical");
  assert.equal(upstreamKeyFromEnv({ [LEGACY_UPSTREAM_KEY_ENV]: "legacy" } as NodeJS.ProcessEnv), "legacy");
  assert.equal(upstreamKeyFromEnv({ [UPSTREAM_KEY_ENV]: "   ", [LEGACY_UPSTREAM_KEY_ENV]: "legacy" } as NodeJS.ProcessEnv), "legacy");
  assert.equal(upstreamKeyFromEnv({ [UPSTREAM_KEY_ENV]: "   " } as NodeJS.ProcessEnv), undefined);
  assert.equal(upstreamKeyFromEnv({} as NodeJS.ProcessEnv), undefined);
});

test("key file resolution prefers canonical, falls back to legacy, skips empty files", () => {
  const canonical = withHome({ canonical: "canon-key", legacy: "legacy-key" });
  try {
    assert.equal(readUpstreamKeyFile(canonical.home), "canon-key");
  } finally {
    canonical.cleanup();
  }
  const legacyOnly = withHome({ legacy: "legacy-key" });
  try {
    assert.equal(readUpstreamKeyFile(legacyOnly.home), "legacy-key");
  } finally {
    legacyOnly.cleanup();
  }
  const emptyCanonical = withHome({ canonical: "   ", legacy: "legacy-key" });
  try {
    assert.equal(readUpstreamKeyFile(emptyCanonical.home), "legacy-key");
  } finally {
    emptyCanonical.cleanup();
  }
  const none = withHome({});
  try {
    assert.equal(readUpstreamKeyFile(none.home), undefined);
    assert.equal(upstreamKeyPresent({} as NodeJS.ProcessEnv, none.home), false);
  } finally {
    none.cleanup();
  }
});

test("loadUpstreamApiKey reads env first, then file, and fails closed with both names", () => {
  const { home, cleanup } = withHome({ canonical: "file-key" });
  try {
    assert.equal(loadUpstreamApiKey({ [UPSTREAM_KEY_ENV]: "env-key" } as NodeJS.ProcessEnv, home), "env-key");
    assert.equal(loadUpstreamApiKey({ [LEGACY_UPSTREAM_KEY_ENV]: "legacy-env" } as NodeJS.ProcessEnv, home), "legacy-env");
    assert.equal(loadUpstreamApiKey({} as NodeJS.ProcessEnv, home), "file-key");
    assert.equal(upstreamKeyPresent({} as NodeJS.ProcessEnv, home), true);
  } finally {
    cleanup();
  }
  const empty = withHome({});
  try {
    assert.throws(() => loadUpstreamApiKey({} as NodeJS.ProcessEnv, empty.home), /WORKFLOW_UPSTREAM_KEY/);
    assert.throws(() => loadUpstreamApiKey({} as NodeJS.ProcessEnv, empty.home), /CLINE_API_KEY/);
  } finally {
    empty.cleanup();
  }
});

test("syntheticKeyPresent resolves env, then the auth-store key, then the key file", () => {
  const none = withHome({});
  try {
    assert.equal(syntheticKeyPresent({} as NodeJS.ProcessEnv, none.home), false, "nothing resolvable");
    assert.equal(
      syntheticKeyPresent({ [SYNTHETIC_KEY_ENV]: "env-syn" } as NodeJS.ProcessEnv, none.home),
      true,
      "env key",
    );
    assert.equal(
      syntheticKeyPresent({} as NodeJS.ProcessEnv, none.home, " auth-syn "),
      true,
      "auth-store key with no env/file",
    );
    assert.equal(
      syntheticKeyPresent({} as NodeJS.ProcessEnv, none.home, "   "),
      false,
      "blank auth key falls through",
    );
  } finally {
    none.cleanup();
  }
  const withFile = withHome({});
  try {
    writeFileSync(join(withFile.home, ".config", "workflow", SYNTHETIC_KEY_FILE), "file-syn", { mode: 0o600 });
    assert.equal(readWorkflowKeyFile(SYNTHETIC_KEY_FILE, withFile.home), "file-syn");
    assert.equal(syntheticKeyPresent({} as NodeJS.ProcessEnv, withFile.home), true, "key file");
  } finally {
    withFile.cleanup();
  }
});

/** A minimal in-memory SecretStore double (the azure-kv port). */
function fakeStore(secrets: Record<string, string>): SecretStore {
  return {
    has: async (id) => secrets[id] !== undefined,
    get: async (id) => secrets[id],
    put: async () => undefined,
    delete: async () => undefined,
  };
}

test("C1 F2: the upstream key can be sourced from a secret store, and a named-but-absent secret fails closed", async () => {
  // Unset seam: byte-identical to loadUpstreamApiKey (env, then file).
  const home = withHome({});
  try {
    const fromEnv = await loadUpstreamApiKeyFromSecretStore({
      env: { [UPSTREAM_KEY_ENV]: "env-key" } as NodeJS.ProcessEnv,
      storeFor: () => { throw new Error("store must not be consulted when the seam is unset"); },
    });
    assert.equal(fromEnv, "env-key");
  } finally {
    home.cleanup();
  }

  // An explicit store source resolves the vault secret.
  const vault = withHome({});
  try {
    const resolved = await loadUpstreamApiKeyFromSecretStore({
      env: { WORKFLOW_UPSTREAM_KEY_FROM: "azure-kv" } as NodeJS.ProcessEnv,
      storeFor: (backend) => {
        assert.equal(backend, "azure-kv");
        return fakeStore({ [UPSTREAM_KEY_SECRET_NAME]: "vault-key" });
      },
    });
    assert.equal(resolved, "vault-key");
  } finally {
    vault.cleanup();
  }

  // The seam is AUTHORITATIVE, not a fallback: with it set, a lingering
  // uid-shared env/file key must NOT win (that would silently defeat the F2
  // fix). The store is consulted even when the env carries a key.
  const authoritative = withHome({ canonical: "file-key" });
  try {
    const resolved = await loadUpstreamApiKeyFromSecretStore({
      env: {
        WORKFLOW_UPSTREAM_KEY_FROM: "azure-kv",
        [UPSTREAM_KEY_ENV]: "env-key",
      } as NodeJS.ProcessEnv,
      storeFor: () => fakeStore({ [UPSTREAM_KEY_SECRET_NAME]: "vault-key" }),
    });
    assert.equal(resolved, "vault-key", "the vault is the source, not the env/file");
  } finally {
    authoritative.cleanup();
  }

  // Explicit store source, empty vault: fail closed (never a silent fall back
  // to a uid-shared environment), even when an env key is present.
  const emptyVault = withHome({});
  try {
    await assert.rejects(
      loadUpstreamApiKeyFromSecretStore({
        env: { WORKFLOW_UPSTREAM_KEY_FROM: "azure-kv", [UPSTREAM_KEY_ENV]: "env-key" } as NodeJS.ProcessEnv,
        storeFor: () => fakeStore({}),
      }),
      /no 'workflow-upstream-key' secret/,
    );
  } finally {
    emptyVault.cleanup();
  }

  // An unknown backend fails closed at parse.
  await assert.rejects(
    loadUpstreamApiKeyFromSecretStore({
      env: { WORKFLOW_UPSTREAM_KEY_FROM: "vault-typo" } as NodeJS.ProcessEnv,
      storeFor: () => fakeStore({}),
    }),
    /not a known backend/,
  );
});
