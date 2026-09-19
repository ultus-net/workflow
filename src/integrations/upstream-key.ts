import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

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

export function upstreamKeyPresent(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): boolean {
  return upstreamKeyFromEnv(env) !== undefined || readUpstreamKeyFile(home) !== undefined;
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
