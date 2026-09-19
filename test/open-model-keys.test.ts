import assert from "node:assert/strict";
import { test } from "node:test";

import { loadOpenModelKeys } from "../src/integrations/open-model-keys.js";

/**
 * W070a: vendor keys via env (first non-empty override) or the 0600 key file,
 * mirroring the existing OpenRouter/Cline custody path.
 */

test("env overrides win and whitespace-only values fall through", () => {
  const resolved = loadOpenModelKeys({
    env: { DEEPSEEK_API_KEY: "  ", MOONSHOT_API_KEY: "kimi-key" },
    home: "/home/op",
    readFile: (path) => (path.endsWith("deepseek-api-key") ? "file-deepseek\n" : ""),
  });
  assert.equal(resolved.keys.deepseek, "file-deepseek", "whitespace env falls through to the key file");
  assert.equal(resolved.keys.kimi, "kimi-key");
  assert.deepEqual(resolved.missing, ["glm"]);
});

test("key files fill in when env is absent, and missing families are reported", () => {
  const files: Record<string, string> = {
    "/home/op/.config/workflow/zai-api-key": "file-glm",
    "/home/op/.config/workflow/kimi-api-key": "file-kimi",
  };
  const resolved = loadOpenModelKeys({
    env: {},
    home: "/home/op",
    readFile: (path) => {
      const value = files[path];
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
  });
  assert.equal(resolved.keys.glm, "file-glm");
  assert.equal(resolved.keys.kimi, "file-kimi");
  assert.deepEqual(resolved.missing, ["deepseek"]);
});
