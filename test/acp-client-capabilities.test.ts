import assert from "node:assert/strict";
import test from "node:test";

import { acpClientCapabilities } from "../src/adapters/acp-subprocess.js";

test("ACP client capabilities advertise config options and goose custom notifications", () => {
  const capabilities = acpClientCapabilities();
  assert.deepEqual(capabilities.session, { configOptions: { boolean: {} } });
  // The exact wire key goose reads: _meta.goose.customNotifications (W048).
  assert.deepEqual(capabilities._meta, { goose: { customNotifications: true } });
});
