import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { opencodeAcpArgs, opencodeMajorVersion } from "../src/integrations/acp-runtime.js";

/**
 * Shared helper for the gated OpenCode ACP probe suites. It launches the
 * agent the SAME way the production connector does
 * (`src/integrations/acp-runtime.ts` createOpencodeRuntime):
 *
 * - the binary is `WORKFLOW_OPENCODE_BIN` when set, otherwise `opencode` on PATH;
 * - the ACP arguments are version-aware via `opencodeAcpArgs` — v1 keeps
 *   `acp --pure`, v2+ uses `acp` only, because v2 rejects unknown flags and
 *   prints its CLI help page to stdout, which pollutes the ACP NDJSON stream
 *   (the decoder rejects the bare `DESCRIPTION` first line);
 * - the working directory is set through the spawn `cwd` option, never a
 *   `--cwd` flag (the connector carries it in the launch config).
 *
 * This module is imported by probe tests; it is never run as a test itself.
 */

/** Version-aware ACP arguments for a resolved opencode executable. Used by
 * probes that build their own (e.g. contained) launch config instead of
 * calling `spawnOpencodeAcp` directly. */
export async function opencodeProbeArgs(executable: string): Promise<readonly string[]> {
  return opencodeAcpArgs(await opencodeMajorVersion(executable));
}

export async function spawnOpencodeAcp(cwd: string, extraEnv: Record<string, string> = {}): Promise<ChildProcessWithoutNullStreams> {
  const executable = process.env.WORKFLOW_OPENCODE_BIN ?? "opencode";
  return spawn(executable, [...await opencodeProbeArgs(executable)], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}
