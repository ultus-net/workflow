import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

import { METERED_PLACEHOLDER_KEY } from "./model-usage-proxy.js";

/**
 * Hub-written OpenCode launch configuration. The hub owns the agent's config
 * surface (probe-proven: `test/acp-opencode-mcp-mount-probe.test.ts` mounts
 * hub-written config from `XDG_CONFIG_HOME`, and the ask-config G1 probe
 * proves ask-configured permission requests reach the client and denials
 * are honored). The metered provider points the agent at the loopback
 * metering proxy with a placeholder credential — the real upstream key never
 * enters the agent's environment or config files, mirroring the Cline
 * metering pattern (`docs/ACP_DECISION.md` G1).
 */

export const OPENCODE_METERED_PROVIDER_ID = "workflow-metered";
export const DEFAULT_OPENCODE_MODEL = "openrouter/auto";

export function meteredOpencodeConfig(options: {
  readonly proxyUrl: string;
  readonly model?: string | undefined;
}): Record<string, unknown> {
  const model = options.model ?? DEFAULT_OPENCODE_MODEL;
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [OPENCODE_METERED_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Workflow metered proxy",
        options: {
          baseURL: `${options.proxyUrl}/api/v1`,
          // Placeholder credential only — the same posture as the Cline
          // metering path: the per-runtime 0600 config file carries the
          // placeholder, and the real upstream key stays exclusively in the
          // hub-side proxy, which ignores the placeholder and injects the
          // real key upstream. (opencode 1.18's config schema requires a
          // plain string here, not an env reference — verified live.)
          apiKey: METERED_PLACEHOLDER_KEY,
        },
        models: { [model]: { name: model } },
      },
    },
    model: `${OPENCODE_METERED_PROVIDER_ID}/${model}`,
    // The hub is the permission authority: ask-configured tools project
    // session/request_permission to the hub, which resolves each request
    // through WorkflowApplication.authorize (G1 probe: denials honored).
    // `task` is included so subagent spawns are gateable at the hub
    // (subagent probe: the task tool call projected and permission-gated).
    permission: { edit: "ask", bash: "ask", task: "ask" },
  };
}

export interface OpencodeLaunchResolution {
  /** Agent executable (self-contained compiled binary, realpath-resolved). */
  readonly executable: string;
}

export interface OpencodeLaunchInput {
  /** WORKFLOW_OPENCODE_BIN override. */
  readonly envBinOverride?: string | undefined;
  /** Realpath-resolved global `opencode` binary, or undefined when absent. */
  readonly opencodeOnPath?: string | undefined;
  /** Existence probe, injectable for tests. */
  readonly exists?: ((path: string) => boolean) | undefined;
  /** Symlink resolver, injectable for tests. */
  readonly realpath?: ((path: string) => string) | undefined;
}

export function resolveOpencodeLaunch(input: OpencodeLaunchInput): OpencodeLaunchResolution {
  const exists = input.exists ?? existsSync;
  const realpath = input.realpath ?? realpathSync;
  const override = input.envBinOverride?.trim();
  if (override !== undefined && override !== "") {
    if (!exists(override)) {
      throw new Error(`WORKFLOW_OPENCODE_BIN points at a missing binary: ${override}`);
    }
    return { executable: realpath(override) };
  }
  if (input.opencodeOnPath === undefined) {
    throw new Error("No OpenCode agent available: install the opencode CLI globally or set WORKFLOW_OPENCODE_BIN");
  }
  return { executable: input.opencodeOnPath };
}

/** Realpath-resolved global `opencode` binary, or undefined when not installed. */
export function globalOpencodeBinary(): string | undefined {
  let bin: string;
  try {
    bin = execFileSync("/usr/bin/which", ["opencode"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
  if (bin === "") return undefined;
  try {
    return realpathSync(bin);
  } catch {
    return undefined;
  }
}
