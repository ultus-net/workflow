import { type OpencodeLspServer } from "./opencode-agent-config.js";

/**
 * Control-plane LSP provisioning (the "LSP wire").
 *
 * On opencode v2 an ABSENT `lsp` config key disables EVERY language server
 * (`packages/opencode/src/lsp/lsp.ts`: `if (!cfg.lsp) "all LSPs are
 * disabled"`), so the hub-written plane config must set the key for LSP to
 * exist at all. The plane image then ships the one server the repo's own stack
 * needs, so it resolves offline — no runtime npm fetch inside the boundary.
 *
 * The TypeScript server is emitted as an OVERRIDE of opencode's built-in
 * `typescript` entry (`opencode-agent-config.ts` `OpencodeLspServer`): the id
 * matches the built-in, so the runtime keeps the built-in's `root` resolution
 * (nearest `package-lock.json`/`pnpm-lock.yaml`/…) and only replaces the spawn
 * with our explicit command (`lsp.ts`: `servers[name] = { ...existing, id,
 * root: existing?.root ?? …, spawn: custom }`). The `initialization.tsserver.
 * path` mirrors exactly what the built-in passes, but pinned to the image's
 * `tsserver.js` instead of a workspace `node_modules` resolve — so the server
 * starts even when the opened workspace has no TypeScript installed.
 *
 * The image paths are constants of `images/control-plane/Dockerfile` (the
 * `node:22-bookworm-slim` npm global prefix is `/usr/local`), never
 * work-specific values (spec §5). `test/plane-lsp.test.ts` pins them against
 * the Dockerfile so the config and the image cannot drift.
 */

/** The npm global prefix of the `node:22-bookworm-slim` base image. */
export const PLANE_LSP_NPM_PREFIX = "/usr/local";

/** Pinned `typescript` version baked into the plane image (matches package.json `^5.9.3`). */
export const PLANE_LSP_TYPESCRIPT_VERSION = "5.9.3";
/** Pinned `typescript-language-server` version baked into the plane image. */
export const PLANE_LSP_TYPESCRIPT_SERVER_VERSION = "6.0.2";

/** The baked `typescript-language-server` bin. */
export const PLANE_LSP_TYPESCRIPT_SERVER_BIN = `${PLANE_LSP_NPM_PREFIX}/bin/typescript-language-server`;
/** The baked `tsserver.js` the language server is pointed at. */
export const PLANE_LSP_TSSERVER_PATH = `${PLANE_LSP_NPM_PREFIX}/lib/node_modules/typescript/lib/tsserver.js`;

/**
 * The opencode flag that forbids on-demand language-server downloads. The
 * plane image bakes exactly one server, so an unprovisioned built-in an
 * operator's file type happens to match fails closed to "unavailable" instead
 * of fetching from the network mid-session (`src/effect/runtime-flags.ts`:
 * `disableLspDownload: bool("OPENCODE_DISABLE_LSP_DOWNLOAD")`).
 */
export const PLANE_LSP_DISABLE_DOWNLOAD_ENV = "OPENCODE_DISABLE_LSP_DOWNLOAD";

/** The PATH inside the pod, when the ambient PATH is absent (the shebang needs `node`). */
export const PLANE_LSP_DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * The file extensions the TypeScript server is consulted for. Declared
 * explicitly rather than inherited from the built-in `typescript` entry so the
 * override does not depend on opencode's merge for the file-type gate — it
 * mirrors the built-in's set (`packages/opencode/src/lsp/server.ts`
 * `Typescript.extensions`).
 */
export const PLANE_LSP_TYPESCRIPT_EXTENSIONS: readonly string[] = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
];

/**
 * The plane's `lsp` config block. A truthy value enables opencode's built-ins;
 * the `typescript` entry then overrides that built-in to spawn the baked,
 * offline server. Any other built-in stays enabled at its runtime default and
 * is resolved from the image cache or reported unavailable (downloads are
 * disabled by {@link PLANE_LSP_DISABLE_DOWNLOAD_ENV}).
 */
export function planeLspConfig(): Record<string, OpencodeLspServer> {
  return {
    typescript: {
      command: [PLANE_LSP_TYPESCRIPT_SERVER_BIN, "--stdio"],
      extensions: [...PLANE_LSP_TYPESCRIPT_EXTENSIONS],
      initialization: { tsserver: { path: PLANE_LSP_TSSERVER_PATH } },
    },
  };
}
