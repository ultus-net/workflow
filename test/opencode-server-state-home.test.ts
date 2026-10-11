import assert from "node:assert/strict";
import { test } from "node:test";

import {
  opencodeServerDiscoveryPath,
  opencodeServerStateHome,
  WORKFLOW_PLANE_REVISION_ENV,
} from "../src/integrations/opencode-server-discovery.js";

/**
 * C1 per-revision state-home isolation (follow-up recorded in
 * docs/ledger/control-plane-c1-composition.md): a redeploy/rollout must not let
 * a fresh Container App revision share — or clobber — the prior revision's
 * discovery file and OpenCode DB. The scoping is opt-in by construction: only a
 * non-empty revision identity moves the state home.
 */

test("opencodeServerStateHome returns the base byte-identical when no revision is supplied", () => {
  const base = "/home/node/.workflow/opencode-server";
  // Undefined (the ambient daemon / every pre-revision deployment), empty, and
  // whitespace-only all keep the base path exactly — the revision scoping is
  // opt-in and never perturbs the default.
  assert.equal(opencodeServerStateHome(base), base);
  assert.equal(opencodeServerStateHome(base, undefined), base);
  assert.equal(opencodeServerStateHome(base, ""), base);
  assert.equal(opencodeServerStateHome(base, "   "), base);
});

test("opencodeServerStateHome appends an isolated subpath when a revision is supplied", () => {
  const base = "/home/node/.workflow/opencode-server";
  const scoped = opencodeServerStateHome(base, "csh-dev-plane--0000014");
  assert.notEqual(scoped, base);
  assert.equal(scoped, `${base}/csh-dev-plane--0000014`);
  // Distinct revisions land in distinct state homes, so a new revision cannot
  // pick up the prior revision's discovery file or OpenCode DB.
  assert.notEqual(
    opencodeServerStateHome(base, "csh-dev-plane--0000014"),
    opencodeServerStateHome(base, "csh-dev-plane--0000013"),
  );
});

test("opencodeServerStateHome sanitizes a revision identity to one filesystem-safe segment", () => {
  const base = "/state";
  // Uppercase and unsafe characters cannot escape the segment or collide.
  assert.equal(opencodeServerStateHome(base, "Rev/0000014"), `${base}/rev-0000014`);
  // A `..`- or `/`-bearing identity can never produce a traversal or absolute
  // path: the separators collapse and edge separators are trimmed.
  assert.equal(opencodeServerStateHome(base, "../etc/passwd"), `${base}/etc-passwd`);
});

test("opencodeServerStateHome fails closed on an identity with no safe characters", () => {
  // A malformed identity that sanitizes to nothing must not silently share the
  // base path — that would defeat the isolation it exists to provide.
  assert.throws(() => opencodeServerStateHome("/state", "///"), /filesystem-safe/);
});

test("opencodeServerStateHome scopes the discovery path consistently with the state dir", () => {
  const base = "/home/node/.workflow/opencode-server";
  const workspace = "/workspace";
  const plain = opencodeServerDiscoveryPath(base, workspace);
  const scoped = opencodeServerDiscoveryPath(opencodeServerStateHome(base, "rev-14"), workspace);
  assert.notEqual(plain, scoped);
  assert.ok(scoped.startsWith(`${base}/rev-14/`), scoped);
});

test("the revision env var name follows the WORKFLOW_PLANE_* convention", () => {
  assert.equal(WORKFLOW_PLANE_REVISION_ENV, "WORKFLOW_PLANE_REVISION");
});
