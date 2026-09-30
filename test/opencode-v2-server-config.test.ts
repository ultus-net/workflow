import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OPENCODE_MODEL,
  OPENCODE_V2_METERED_ENV_KEY,
  OPENCODE_V2_METERED_PROVIDER_ID,
  meteredOpencodeConfig,
} from "../src/integrations/opencode-agent-config.js";
import { METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";
import {
  opencodeServerArgs,
  opencodeServerLaunchEnvironment,
} from "../src/integrations/opencode-server-runtime.js";

/**
 * The server/topology lane's v2-valid metered surface (mirrors
 * test/opencode-v2-metered-config.test.ts, PR #427). The daemon writes the same
 * version-aware config the ACP lane does, and on v2 activates the built-in
 * `openrouter` provider with the placeholder env var because that provider is
 * credential-activated. On this lane the config `model` is the metered pin: the
 * v2 HTTP session honors it (live-verified), unlike the ACP session default.
 *
 * Pure pins — no server spawn: the launch environment and the composed config
 * are the two surfaces the daemon owns.
 */
const proxyUrl = "http://127.0.0.1:61999";
const configDir = "/tmp/wf-server-test/config";

test("server launch env: v1 keeps the placeholder out of the env (it rides the config file)", () => {
  const env = opencodeServerLaunchEnvironment({ configDir, password: "hub-only" });
  assert.equal(env.XDG_CONFIG_HOME, configDir);
  assert.equal(env.OPENCODE_SERVER_PASSWORD, "hub-only");
  assert.equal(env.OPENCODE_SERVER_USERNAME, "opencode");
  assert.equal(env.OPENCODE_TELEMETRY, "off");
  assert.equal(env[OPENCODE_V2_METERED_ENV_KEY], undefined);
});

test("server launch env: v2 carries the placeholder in the built-in provider's env key", () => {
  const env = opencodeServerLaunchEnvironment({ configDir, password: "hub-only", opencodeMajor: 2 });
  assert.equal(env[OPENCODE_V2_METERED_ENV_KEY], METERED_PLACEHOLDER_KEY);
  // Placeholder only: the real upstream key never enters the boundary.
  assert.equal(env[OPENCODE_V2_METERED_ENV_KEY], "workflow-metered");
  assert.equal(env.XDG_CONFIG_HOME, configDir);
  assert.equal(env.OPENCODE_SERVER_PASSWORD, "hub-only");
});

test("server launch env: a newer major also activates the v2 route", () => {
  const env = opencodeServerLaunchEnvironment({ configDir, password: "p", opencodeMajor: 3 });
  assert.equal(env[OPENCODE_V2_METERED_ENV_KEY], METERED_PLACEHOLDER_KEY);
});

test("server v2 config: providers/package|settings reuse the built-in openrouter provider", () => {
  const config = meteredOpencodeConfig({ proxyUrl, opencodeMajor: 2 });
  assert.equal(config.provider, undefined);
  const providers = config.providers as Record<string, Record<string, unknown>>;
  assert.equal(
    (providers[OPENCODE_V2_METERED_PROVIDER_ID]!.settings as Record<string, unknown>).baseURL,
    `${proxyUrl}/api/v1`,
  );
  // The config `model` is the server-lane metered pin.
  assert.equal(config.model, `${OPENCODE_V2_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`);
  // The placeholder never enters the v2 config file; it rides the env var.
  assert.ok(!JSON.stringify(config).includes(METERED_PLACEHOLDER_KEY), "v2 config must stay credential-free");
});

test("server serve args are unchanged and valid for the v2 `serve` command", () => {
  // Verified against `opencode serve --help` on v2.0.10: --hostname/--port are
  // the loopback binding flags (no v1-only flags are emitted).
  assert.deepEqual(opencodeServerArgs(4096), ["serve", "--hostname", "127.0.0.1", "--port", "4096"]);
});
