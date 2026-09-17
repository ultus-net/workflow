import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { globalGooseBinary, resolveGooseLaunch, type GooseLaunch } from "../src/integrations/goose-agent-config.js";

/**
 * Shared helpers for the gated goose probe family
 * (`test/acp-goose-*-probe.test.ts`), mirroring `cline-probe-helpers.ts`.
 * All probes skip without their env gate; evidence logs record the
 * ambient-PATH goose version (`agentInfo`) per the family conventions.
 */

/** Default key file shared with the OpenRouter upstream (probe parity). */
export const defaultGooseKeyFile: string = join(homedir(), ".config", "workflow", "cline-api-key");

/** Env-first key loading; throws (skips are handled by each probe's gate). */
export function loadGooseApiKey(label: string): string {
  const key = process.env.CLINE_API_KEY?.trim() || readKeyFile();
  if (!key) {
    throw new Error(`${label} requires CLINE_API_KEY or ${defaultGooseKeyFile} (the OpenRouter upstream key for the metering proxy)`);
  }
  return key;
}

function readKeyFile(): string {
  if (!existsSync(defaultGooseKeyFile)) return "";
  return readFileSync(defaultGooseKeyFile, "utf8").trim();
}

/** Production-parity goose entry: WORKFLOW_GOOSE_BIN override, else PATH. */
export function gooseLaunchEntry(): GooseLaunch {
  return resolveGooseLaunch({
    envBinOverride: process.env.WORKFLOW_GOOSE_BIN,
    gooseOnPath: globalGooseBinary(),
  });
}
