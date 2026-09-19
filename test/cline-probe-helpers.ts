import { readFile } from "node:fs/promises";

import { globalClineEntrypoint, resolveClineLaunch } from "../src/integrations/cline-launch.js";
import { readUpstreamKeyFile, upstreamKeyFromEnv, upstreamKeyFilePath } from "../src/integrations/upstream-key.js";

/**
 * Shared helpers for the gated Cline probe suites. This module is imported by
 * probe tests; it is never run as a test on its own.
 */

export function defaultClineKeyFile(): string {
  return process.env.CLINE_API_KEY_FILE ?? upstreamKeyFilePath();
}

/**
 * Resolves the Cline credential from the environment or the shared key file,
 * throwing when unavailable so a gated probe fails rather than guessing.
 * Canonical (`WORKFLOW_UPSTREAM_KEY` / `~/.config/workflow/upstream-key`) wins,
 * then the legacy `CLINE_API_KEY` / `~/.config/workflow/cline-api-key`.
 */
export async function loadClineApiKey(purpose = "Cline probe"): Promise<string> {
  const env = upstreamKeyFromEnv();
  if (env) return env;
  const explicit = process.env.CLINE_API_KEY_FILE;
  if (explicit !== undefined) {
    const key = (await readFile(explicit, "utf8")).trim();
    if (key) return key;
    throw new Error(`${purpose} requires a non-empty CLINE_API_KEY_FILE (${explicit})`);
  }
  const key = readUpstreamKeyFile();
  if (!key) throw new Error(`${purpose} requires WORKFLOW_UPSTREAM_KEY or ~/.config/workflow/upstream-key (legacy CLINE_API_KEY accepted)`);
  return key;
}

/**
 * Resolves the Cline launch entry the probes should use (Bubblewrap needs
 * realpaths). Matches the production launch resolution: the `WORKFLOW_CLINE_BIN`
 * override when set, otherwise the global `cline` wrapper under Node. The
 * vendored `.workflow-cline` compiled-binary fallback was removed with the
 * patched checkout, so gated runs need an ambient `cline` (or
 * `WORKFLOW_CLINE_BIN` pointing at an equivalent headless-capable binary).
 */
export function clineLaunchEntry(): { executable: string; script?: string | undefined } {
  return resolveClineLaunch({
    envBinOverride: process.env.WORKFLOW_CLINE_BIN,
    clineOnPath: globalClineEntrypoint(),
  });
}
