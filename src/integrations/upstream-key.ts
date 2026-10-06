import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

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
