import { globalGooseBinary, resolveGooseLaunch, type GooseLaunch } from "../src/integrations/goose-agent-config.js";
import { readUpstreamKeyFile, upstreamKeyFromEnv, upstreamKeyFilePath } from "../src/integrations/upstream-key.js";

/**
 * Shared helpers for the gated goose probe family
 * (`test/acp-goose-*-probe.test.ts`), mirroring `cline-probe-helpers.ts`.
 * All probes skip without their env gate; evidence logs record the
 * ambient-PATH goose version (`agentInfo`) per the family conventions.
 */

/** Canonical shared OpenRouter upstream key file (legacy path still read). */
export const defaultGooseKeyFile: string = upstreamKeyFilePath();

/** Env-first key loading (canonical, then legacy); throws (skips are each probe's gate). */
export function loadGooseApiKey(label: string): string {
  const key = upstreamKeyFromEnv() ?? readUpstreamKeyFile();
  if (!key) {
    throw new Error(`${label} requires WORKFLOW_UPSTREAM_KEY or ${defaultGooseKeyFile} (legacy CLINE_API_KEY / ~/.config/workflow/cline-api-key accepted; the upstream key for the metering proxy)`);
  }
  return key;
}

/** Production-parity goose entry: WORKFLOW_GOOSE_BIN override, else PATH. */
export function gooseLaunchEntry(): GooseLaunch {
  return resolveGooseLaunch({
    envBinOverride: process.env.WORKFLOW_GOOSE_BIN,
    gooseOnPath: globalGooseBinary(),
  });
}
