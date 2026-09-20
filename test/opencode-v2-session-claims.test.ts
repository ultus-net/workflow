import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fingerprintFile } from "../src/application/file-claim-ledger.js";
import { OpenCodeV2SessionClaims } from "../src/integrations/opencode-v2-session-claims.js";

test("v2 session claims inherit parent mutation budget and release on session removal", () => {
  const claims = new OpenCodeV2SessionClaims(2);
  claims.register({ sessionId: "parent" });
  claims.register({ sessionId: "child", parentSessionId: "parent" });
  assert.equal(claims.consumeMutation("child"), true);
  assert.equal(claims.consumeMutation("parent"), true);
  assert.equal(claims.consumeMutation("child"), false);
  claims.release("parent");
  assert.equal(claims.consumeMutation("parent"), true);
});

test("v2 session claims preserve read freshness and exclusive file ownership", () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-v2-claims-"));
  const path = join(dir, "file.txt");
  writeFileSync(path, "before");
  const claims = new OpenCodeV2SessionClaims();
  claims.register({ sessionId: "s" });
  const fingerprint = fingerprintFile(path);
  claims.recordRead("s", fingerprint);
  assert.equal(claims.matchesRead("s", path, fingerprint), true);
  assert.equal(claims.claim("s", [path]), true);
  assert.equal(claims.claim("other", [path]), false);
  writeFileSync(path, "after");
  assert.equal(claims.matchesRead("s", path, fingerprint), false);
});

test("v2 session claims scope read freshness to the recording session", () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-v2-claims-scope-"));
  const path = join(dir, "file.txt");
  writeFileSync(path, "same");
  const fingerprint = fingerprintFile(path);
  const claims = new OpenCodeV2SessionClaims();
  claims.register({ sessionId: "a" });
  claims.register({ sessionId: "b" });
  claims.recordRead("a", fingerprint);

  // The global ledger has an unchanged read for the path, but only session `a`
  // recorded it; a stale/missing read in `b` must fail closed.
  assert.equal(claims.matchesRead("b", path, fingerprint), false);
  assert.equal(claims.matchesRead("a", path, fingerprint), true);
  claims.release("a");
  assert.equal(claims.matchesRead("a", path, fingerprint), false);
});