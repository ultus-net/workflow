import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { globalClineEntrypoint, resolveClineLaunch } from "../src/integrations/cline-launch.js";

/**
 * Shared helpers for the gated Cline probe suites. This module is imported by
 * probe tests; it is never run as a test on its own.
 */

const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function defaultClineKeyFile(): string {
  return process.env.CLINE_API_KEY_FILE ?? path.join(homedir(), ".config", "workflow", "cline-api-key");
}

/**
 * Resolves the Cline credential from the environment or the default key file,
 * throwing when unavailable so a gated probe fails rather than guessing.
 */
export async function loadClineApiKey(purpose = "Cline probe"): Promise<string> {
  if (process.env.CLINE_API_KEY) return process.env.CLINE_API_KEY;
  const key = (await readFile(defaultClineKeyFile(), "utf8")).trim();
  if (!key) throw new Error(`${purpose} requires CLINE_API_KEY or CLINE_API_KEY_FILE`);
  return key;
}

/**
 * Resolves the Cline launch entry the probes should use (Bubblewrap needs
 * realpaths). Matches the production launch resolution: the vendored,
 * Workflow-patched compiled Cline binary when built (self-contained
 * executable, no script), the global `cline` wrapper under Node otherwise.
 * The fallback is the stock PATH surface — account-cloud-only in ACP mode —
 * so gated runs need the vendored build present (or `WORKFLOW_CLINE_BIN`
 * pointing at an equivalent headless-capable binary) to authenticate.
 */
export function clineLaunchEntry(): { executable: string; script?: string | undefined } {
  return resolveClineLaunch({
    workflowRoot,
    envBinOverride: process.env.WORKFLOW_CLINE_BIN,
    clineOnPath: globalClineEntrypoint(),
  });
}
