import assert from "node:assert/strict";
import test from "node:test";

import {
  qualifyOpenCodeV2Route,
  type OpenCodeV2RouteClass,
  type OpenCodeV2RouteDisposition,
} from "../src/integrations/opencode-v2-route-class.js";

/**
 * OpenCode v2 route-class qualification (docs/OPENCODE_V2_MIGRATION_SPEC.md
 * §2.2/§2.4). Every case asserts both the class and the gateway disposition,
 * because the disposition is the authority boundary — not the label.
 */

const cases: readonly {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly routeClass: OpenCodeV2RouteClass;
  readonly disposition: OpenCodeV2RouteDisposition;
}[] = [
  { name: "server info is read-only", method: "GET", path: "/api/info", routeClass: "read-only", disposition: "forward" },
  { name: "session list is read-only", method: "GET", path: "/api/session", routeClass: "read-only", disposition: "forward" },
  { name: "session stats is read-only", method: "GET", path: "/api/experimental/session/stats", routeClass: "read-only", disposition: "forward" },
  { name: "session log is read-only", method: "GET", path: "/api/session/s/log", routeClass: "read-only", disposition: "forward" },
  { name: "session diff is read-only", method: "GET", path: "/api/session/s/diff", routeClass: "read-only", disposition: "forward" },
  { name: "event stream is read-only", method: "GET", path: "/api/event", routeClass: "read-only", disposition: "forward" },
  { name: "mcp list is read-only", method: "GET", path: "/api/mcp", routeClass: "read-only", disposition: "forward" },
  { name: "config read is denied to protect the hub credential (review P3)", method: "GET", path: "/api/config", routeClass: "read-only", disposition: "deny" },
  { name: "config subtree read is denied the same way", method: "GET", path: "/api/config/providers", routeClass: "read-only", disposition: "deny" },
  { name: "api-optional config spelling is denied too", method: "GET", path: "/config", routeClass: "read-only", disposition: "deny" },
  { name: "filesystem read is read-only", method: "GET", path: "/api/filesystem/read", routeClass: "read-only", disposition: "forward" },
  { name: "experimental filesystem read is read-only", method: "GET", path: "/api/experimental/fs/read", routeClass: "read-only", disposition: "forward" },
  { name: "shell output read is read-only", method: "GET", path: "/api/shell/output", routeClass: "read-only", disposition: "forward" },
  { name: "integration list is read-only", method: "GET", path: "/api/integration", routeClass: "read-only", disposition: "forward" },
  { name: "command list is read-only", method: "GET", path: "/api/command", routeClass: "read-only", disposition: "forward" },
  { name: "rpc read is read-only", method: "GET", path: "/api/rpc", routeClass: "read-only", disposition: "forward" },
  { name: "permission read is explicitly read-only", method: "GET", path: "/api/session/s/permission", routeClass: "read-only", disposition: "forward" },
  { name: "head is a read", method: "HEAD", path: "/api/session", routeClass: "read-only", disposition: "forward" },
  { name: "permission reply is brokered", method: "POST", path: "/api/session/s/permission/r/reply", routeClass: "permission-authority", disposition: "broker" },
  { name: "reply route is broker-only for reads too", method: "GET", path: "/api/session/s/permission/r/reply", routeClass: "permission-authority", disposition: "broker" },
  { name: "saved permission mutation is denied", method: "PUT", path: "/api/permission/saved/abc", routeClass: "permission-authority", disposition: "deny" },
  { name: "filesystem write is denied", method: "POST", path: "/api/experimental/fs/write", routeClass: "filesystem-mutation", disposition: "deny" },
  { name: "session shell is denied", method: "POST", path: "/api/session/s/shell", routeClass: "filesystem-mutation", disposition: "deny" },
  { name: "worktree create is denied", method: "POST", path: "/api/worktree", routeClass: "filesystem-mutation", disposition: "deny" },
  { name: "vcs mutation is denied", method: "POST", path: "/api/vcs/commit", routeClass: "filesystem-mutation", disposition: "deny" },
  { name: "pty create is denied", method: "POST", path: "/api/pty", routeClass: "pty", disposition: "deny" },
  { name: "persistent pty is denied", method: "POST", path: "/api/persistent-pty/handoff", routeClass: "pty", disposition: "deny" },
  { name: "mcp add is denied", method: "POST", path: "/api/mcp", routeClass: "mcp-config-mutation", disposition: "deny" },
  { name: "integration connect is denied", method: "POST", path: "/api/integration/github/connect", routeClass: "mcp-config-mutation", disposition: "deny" },
  { name: "credential update is denied", method: "POST", path: "/api/credential", routeClass: "mcp-config-mutation", disposition: "deny" },
  { name: "config mutation is denied", method: "POST", path: "/api/config", routeClass: "mcp-config-mutation", disposition: "deny" },
  { name: "plugin update is denied", method: "POST", path: "/api/plugin/update", routeClass: "mcp-config-mutation", disposition: "deny" },
  { name: "location reload is denied", method: "POST", path: "/api/location/reload", routeClass: "mcp-config-mutation", disposition: "deny" },
  { name: "session prompt is forwarded", method: "POST", path: "/api/session/s/prompt", routeClass: "session-input", disposition: "forward" },
  { name: "session command is forwarded", method: "POST", path: "/api/session/s/command", routeClass: "session-input", disposition: "forward" },
  { name: "session interrupt is forwarded", method: "POST", path: "/api/session/s/interrupt", routeClass: "session-input", disposition: "forward" },
  { name: "session abort is forwarded (operator control, review P3)", method: "POST", path: "/api/session/s/abort", routeClass: "session-input", disposition: "forward" },
  { name: "session background is forwarded", method: "POST", path: "/api/session/s/background", routeClass: "session-input", disposition: "forward" },
  { name: "session create is forwarded", method: "POST", path: "/api/session", routeClass: "session-input", disposition: "forward" },
  { name: "session update is forwarded", method: "PATCH", path: "/api/session/s", routeClass: "session-input", disposition: "forward" },
  { name: "session import is forwarded", method: "POST", path: "/api/session/import", routeClass: "session-input", disposition: "forward" },
  { name: "a PUT on session import is held back", method: "PUT", path: "/api/session/import", routeClass: "session-input", disposition: "deny" },
  { name: "a PATCH on session import is held back", method: "PATCH", path: "/api/session/import", routeClass: "session-input", disposition: "deny" },
  { name: "a DELETE on session import is held back", method: "DELETE", path: "/api/session/import", routeClass: "session-input", disposition: "deny" },
  { name: "session compact is held back", method: "POST", path: "/api/session/s/compact", routeClass: "session-input", disposition: "deny" },
  { name: "session fork is held back", method: "POST", path: "/api/session/s/fork", routeClass: "session-input", disposition: "deny" },
  { name: "session remove is held back", method: "DELETE", path: "/api/session/s", routeClass: "session-input", disposition: "deny" },
  { name: "a DELETE on a session input op is held back", method: "DELETE", path: "/api/session/s/message", routeClass: "session-input", disposition: "deny" },
  { name: "a PUT on a session input op fails closed", method: "PUT", path: "/api/session/s/message", routeClass: "unknown", disposition: "deny" },
  { name: "an unclassified session operation fails closed", method: "POST", path: "/api/session/s/purge", routeClass: "unknown", disposition: "deny" },
  { name: "unknown mutation fails closed", method: "POST", path: "/api/experimental/unknown", routeClass: "unknown", disposition: "deny" },
  { name: "unknown read fails closed", method: "GET", path: "/api/experimental/unknown", routeClass: "unknown", disposition: "deny" },
  { name: "an undocumented route is not implicit read-only", method: "POST", path: "/api/debug/evil", routeClass: "unknown", disposition: "deny" },
  { name: "dot-segment path fails closed even when the target classifies", method: "GET", path: "/api/session/../config", routeClass: "unknown", disposition: "deny" },
  { name: "current-segment dot path fails closed", method: "GET", path: "/api/./info", routeClass: "unknown", disposition: "deny" },
  { name: "trailing slash still classifies normally", method: "GET", path: "/api/session/s/", routeClass: "read-only", disposition: "forward" },
];

for (const entry of cases) {
  test(`v2 route qualification: ${entry.name}`, () => {
    assert.deepEqual(qualifyOpenCodeV2Route(entry.method, entry.path), {
      routeClass: entry.routeClass,
      disposition: entry.disposition,
    });
  });
}

test("v2 route qualification: method is part of the contract", () => {
  assert.equal(qualifyOpenCodeV2Route("GET", "/api/session/s").disposition, "forward");
  assert.equal(qualifyOpenCodeV2Route("DELETE", "/api/session/s").disposition, "deny");
  assert.equal(qualifyOpenCodeV2Route("GET", "/api/mcp").disposition, "forward");
  assert.equal(qualifyOpenCodeV2Route("POST", "/api/mcp").disposition, "deny");
});

test("v2 route qualification: relative pathnames are normalized", () => {
  assert.deepEqual(qualifyOpenCodeV2Route("GET", "api/info"), { routeClass: "read-only", disposition: "forward" });
});
