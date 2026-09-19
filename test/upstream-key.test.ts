import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  UPSTREAM_KEY_ENV,
  LEGACY_UPSTREAM_KEY_ENV,
  legacyUpstreamKeyFilePath,
  loadUpstreamApiKey,
  readUpstreamKeyFile,
  upstreamKeyFilePath,
  upstreamKeyFromEnv,
  upstreamKeyPresent,
} from "../src/integrations/upstream-key.js";

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
