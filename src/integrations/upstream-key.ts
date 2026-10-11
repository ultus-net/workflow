import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { SecretStore } from "./credentials.js";

import { SYNTHETIC_KEY_ENV, SYNTHETIC_KEY_FILE, syntheticAuthKeyFromAuth } from "./synthetic-provider.js";

/**
 * The loopback metering proxy's shared upstream credential.
 *
 * Every ACP runtime (OpenCode, goose, the retained Cline connector) meters
 * through one loopback proxy, and that proxy needs the real upstream key. The
 * canonical source is now:
 *
 *   env  `WORKFLOW_UPSTREAM_KEY`
 *   file `~/.config/workflow/upstream-key`
 *
 * The pre-pivot names `CLINE_API_KEY` and `~/.config/workflow/cline-api-key`
 * are still read for back-compat (the standalone Cline connector also consumes
 * `CLINE_API_KEY` as its provider key). Canonical wins; the legacy names may be
 * deprecated later, separately gated. W050 plan step C2.
 */

export const UPSTREAM_KEY_ENV = "WORKFLOW_UPSTREAM_KEY";
export const LEGACY_UPSTREAM_KEY_ENV = "CLINE_API_KEY";

export function upstreamKeyFilePath(home: string = homedir()): string {
  return resolve(home, ".config", "workflow", "upstream-key");
}

export function legacyUpstreamKeyFilePath(home: string = homedir()): string {
  return resolve(home, ".config", "workflow", "cline-api-key");
}

/** Canonical key file first, then the legacy path; an empty file falls through. */
export function readUpstreamKeyFile(home: string = homedir()): string | undefined {
  for (const path of [upstreamKeyFilePath(home), legacyUpstreamKeyFilePath(home)]) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value.length > 0) return value;
    } catch {
      // Missing or unreadable: try the next source.
    }
  }
  return undefined;
}

/** Canonical env first, then the legacy env; whitespace-only values fall through. */
export function upstreamKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const canonical = (env[UPSTREAM_KEY_ENV] ?? "").trim();
  if (canonical.length > 0) return canonical;
  const legacy = (env[LEGACY_UPSTREAM_KEY_ENV] ?? "").trim();
  return legacy.length > 0 ? legacy : undefined;
}

/**
 * True when a Synthetic upstream key is resolvable. An explicit `authKey`
 * (the `synthetic.key` the caller read from the OpenCode auth store) counts,
 * mirroring the runtime lane's resolution order: env, auth store, key file.
 */
export function syntheticKeyPresent(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  authKey?: string | undefined,
): boolean {
  const fromEnv = (env[SYNTHETIC_KEY_ENV] ?? "").trim();
  if (fromEnv !== "") return true;
  if (authKey !== undefined && authKey.trim() !== "") return true;
  return readWorkflowKeyFile(SYNTHETIC_KEY_FILE, home) !== undefined;
}

export function upstreamKeyPresent(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): boolean {
  return upstreamKeyFromEnv(env) !== undefined || readUpstreamKeyFile(home) !== undefined;
}

/**
 * Reads and parses an OpenCode auth store at `authPath`, returning its
 * `synthetic.key`. PURE-parser + one file read; absent/unreadable/unparseable
 * all yield undefined. The single source all metered lanes and the settings
 * fact use, so they agree on whether Synthetic is connected.
 */
export function syntheticKeyFromAuthFile(authPath: string): string | undefined {
  try {
    return syntheticAuthKeyFromAuth(JSON.parse(readFileSync(authPath, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * Reads an arbitrary 0600 credential file from `~/.config/workflow/<name>`.
 * Used for the alternate metered lanes (e.g. the Synthetic upstream key); an
 * absent/empty file yields undefined rather than throwing.
 */
export function readWorkflowKeyFile(name: string, home: string = homedir()): string | undefined {
  try {
    const value = readFileSync(resolve(home, ".config", "workflow", name), "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function loadUpstreamApiKey(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const apiKey = upstreamKeyFromEnv(env) ?? readUpstreamKeyFile(home);
  if (!apiKey) {
    throw new Error(
      `ACP driver requires ${UPSTREAM_KEY_ENV} or ~/.config/workflow/upstream-key (the upstream key for the metering proxy; ` +
        `legacy ${LEGACY_UPSTREAM_KEY_ENV} / ~/.config/workflow/cline-api-key are also accepted)`,
    );
  }
  return apiKey;
}

/**
 * The vault secret NAME the azure-kv secret store is read for the upstream key.
 * Instance-facing naming convention only (the vault value is per-instance); the
 * default matches the env/file key name so the operator has one mental model.
 */
export const UPSTREAM_KEY_SECRET_NAME = "workflow-upstream-key";

/**
 * C1 F2 durable fix: resolve the upstream key from the configured
 * {@link SecretStore} (Azure Key Vault in the deployed plane) instead of a
 * uid-shared process environment. Precedence mirrors {@link loadUpstreamApiKey}
 * but the secret-store source only participates when explicitly requested by
 * `WORKFLOW_UPSTREAM_KEY_FROM=<backend>` — an unconfigured surface stays
 * byte-identical (env, then file).
 *
 * Fail-closed: `from` is a recognized backend but the secret is absent → throw
 * (never fall back to a uid-shared env). An unknown backend → throw at parse.
 * The value is never logged. `storeFor` is injected so the parse/precedence is
 * testable without a live vault.
 */
export function loadUpstreamApiKeyFromSecretStore(options: {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly home?: string | undefined;
  /** Resolves the secret store; the injected seam (defaults to the ambient selection). */
  readonly storeFor: (backend: string) => SecretStore;
}): Promise<string> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const from = (env.WORKFLOW_UPSTREAM_KEY_FROM ?? "").trim();
  if (from === "") return Promise.resolve(loadUpstreamApiKey(env, home));
  if (from !== "azure-kv" && from !== "keyring") {
    return Promise.reject(
      new TypeError(`WORKFLOW_UPSTREAM_KEY_FROM '${from}' is not a known backend (expected "azure-kv" or "keyring")`),
    );
  }
  // Explicit request: the secret store is the SOURCE. A provider/env key still
  // short-circuits (env-presence is an explicit operator value, and the store
  // may legitimately be empty in a local keyring posture), but a missing vault
  // secret throws rather than degrading to a uid-shared environment.
  const direct = upstreamKeyFromEnv(env) ?? readUpstreamKeyFile(home);
  if (direct !== undefined) return Promise.resolve(direct);
  return options.storeFor(from).get(UPSTREAM_KEY_SECRET_NAME).then((value) => {
    const trimmed = (value ?? "").trim();
    if (trimmed.length === 0) {
      throw new Error(
        `the ${from} secret store has no '${UPSTREAM_KEY_SECRET_NAME}' secret (WORKFLOW_UPSTREAM_KEY_FROM=${from}); ` +
          "store the upstream key there or unset the FROM seam to use env/file",
      );
    }
    return trimmed;
  });
}
