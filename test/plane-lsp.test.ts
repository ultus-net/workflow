import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { meteredOpencodeConfig } from "../src/integrations/opencode-agent-config.js";
import {
  PLANE_LSP_DEFAULT_PATH,
  PLANE_LSP_DISABLE_DOWNLOAD_ENV,
  PLANE_LSP_NPM_PREFIX,
  PLANE_LSP_TSSERVER_PATH,
  PLANE_LSP_TYPESCRIPT_EXTENSIONS,
  PLANE_LSP_TYPESCRIPT_SERVER_BIN,
  PLANE_LSP_TYPESCRIPT_SERVER_VERSION,
  PLANE_LSP_TYPESCRIPT_VERSION,
  planeLspConfig,
} from "../src/integrations/plane-lsp.js";

/**
 * The plane's LSP wire (2026-10-11).
 *
 * opencode v2 disables EVERY language server when the `lsp` config key is
 * absent (`packages/opencode/src/lsp/lsp.ts`: `if (!cfg.lsp) "all LSPs are
 * disabled"`), and the built-in `typescript` server resolves its binary from
 * opencode's npm cache and `tsserver.js` from the workspace's node_modules —
 * neither exists offline in a fresh pod. The plane therefore (a) sets the
 * config `lsp` key and (b) overrides the built-in `typescript` entry to spawn
 * the IMAGE-baked server with a pinned tsserver path. These pins keep the
 * config and the Dockerfile from drifting apart: the constants ARE the string
 * the image installs.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dockerfile = readFileSync(join(repoRoot, "images", "control-plane", "Dockerfile"), "utf8");

test("plane LSP: the config overrides the built-in typescript server with the baked, offline command", () => {
  const lsp = planeLspConfig();
  const typescript = lsp.typescript as { command?: readonly string[]; initialization?: unknown; extensions?: readonly string[] } | undefined;
  assert.ok(typescript !== undefined, "the typescript entry must override the built-in");
  // A built-in id (`typescript`) keeps the built-in root resolution; only the
  // spawn is replaced by the explicit command.
  assert.deepEqual(typescript.command, [PLANE_LSP_TYPESCRIPT_SERVER_BIN, "--stdio"]);
  assert.deepEqual(typescript.initialization, { tsserver: { path: PLANE_LSP_TSSERVER_PATH } });
  // Extensions are declared explicitly (not left to opencode's built-in merge),
  // so the file-type gate holds regardless of merge semantics; the set mirrors
  // the built-in `typescript` entry (packages/opencode/src/lsp/server.ts).
  assert.deepEqual(typescript.extensions, [...PLANE_LSP_TYPESCRIPT_EXTENSIONS]);
  assert.ok(typescript.extensions!.includes(".ts"), "TypeScript files must match the server");
});

test("plane LSP: the image constants are the exact paths the Dockerfile installs", () => {
  // The npm global prefix of node:22-bookworm-slim is /usr/local, so the
  // install lands the bin and tsserver.js under these absolute paths.
  assert.equal(PLANE_LSP_NPM_PREFIX, "/usr/local");
  assert.equal(PLANE_LSP_TYPESCRIPT_SERVER_BIN, "/usr/local/bin/typescript-language-server");
  assert.equal(PLANE_LSP_TSSERVER_PATH, "/usr/local/lib/node_modules/typescript/lib/tsserver.js");
  assert.ok(
    dockerfile.includes(`RUN npm install -g typescript@${PLANE_LSP_TYPESCRIPT_VERSION} typescript-language-server@${PLANE_LSP_TYPESCRIPT_SERVER_VERSION}`),
    "the Dockerfile must install the pinned versions the config references",
  );
  assert.ok(
    dockerfile.includes("typescript-language-server --version"),
    "the build must fail closed if the language server does not run",
  );
});

test("plane LSP: the disable-download env flag is the opencode runtime flag name", () => {
  // `src/effect/runtime-flags.ts`: disableLspDownload: bool("OPENCODE_DISABLE_LSP_DOWNLOAD").
  assert.equal(PLANE_LSP_DISABLE_DOWNLOAD_ENV, "OPENCODE_DISABLE_LSP_DOWNLOAD");
  // The bash PATH inside the pod the image's bin and node live on.
  assert.ok(PLANE_LSP_DEFAULT_PATH.includes("/usr/local/bin"));
});

test("plane LSP: the server launch env pins the disable-download flag and PATH only when LSP is composed", async () => {
  const { opencodeServerLaunchEnvironment } = await import("../src/integrations/opencode-server-runtime.js");
  const base = { configDir: "/state/config", password: "pw" };
  const withoutLsp = opencodeServerLaunchEnvironment(base);
  assert.equal(
    withoutLsp[PLANE_LSP_DISABLE_DOWNLOAD_ENV],
    undefined,
    "an lsp-less lane must not set the flag (byte-identical env)",
  );
  assert.equal(withoutLsp.PATH, undefined, "an lsp-less lane must not inject PATH");
  const withLsp = opencodeServerLaunchEnvironment({ ...base, lsp: true });
  assert.equal(
    withLsp[PLANE_LSP_DISABLE_DOWNLOAD_ENV],
    "1",
    "an lsp-composed lane forbids runtime downloads (fail-closed to the baked server)",
  );
  // The baked server is a `#!/usr/bin/env node` script and the contained launch
  // forwards this env verbatim (no ambient PATH), so the shebang needs this.
  assert.equal(withLsp.PATH, PLANE_LSP_DEFAULT_PATH, "the launch must set the image PATH for the server shebang");
  assert.ok(withLsp.PATH!.startsWith("/usr/local/bin"), "the image's bin dir must lead the PATH");
});

test("meteredOpencodeConfig composes the lsp key only when supplied (byte-identical default)", () => {
  const without = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:41000" });
  assert.equal("lsp" in without, false, "an absent lsp option must leave the config key out");

  const withLsp = meteredOpencodeConfig({
    proxyUrl: "http://127.0.0.1:41000",
    lsp: planeLspConfig(),
  });
  assert.deepEqual(withLsp.lsp, planeLspConfig(), "the supplied lsp block rides the config verbatim");

  const builtins = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:41000", lsp: true });
  assert.equal(builtins.lsp, true, "lsp:true enables the built-ins");
});
