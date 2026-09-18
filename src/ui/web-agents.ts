import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { WorkflowApplication } from "../application/workflow.js";
import type { TaskId } from "../kernel/contracts.js";
import {
  createConfiguredAcpRuntime,
  createConfiguredOpencodeAcpRuntime,
  opencodeAuthPath,
  type WorkflowAcpRuntime,
} from "../integrations/acp-runtime.js";
import { globalClineEntrypoint } from "../integrations/cline-launch.js";
import { globalGooseBinary, gooseProviderKind } from "../integrations/goose-agent-config.js";
import type { PermissionBroker } from "./permission-broker.js";

export type WebAgentId = "cline" | "opencode" | "goose";

export interface WebAgentInfo {
  readonly id: WebAgentId;
  readonly name: string;
  /**
   * Launch-time posture, stated honestly: Cline and goose launch inside an
   * enforced containment boundary; OpenCode's ACP mode is advisory transport
   * (no pre-mutation interception). The two must never render as equivalent.
   */
  readonly containment: "contained" | "advisory";
  readonly available: boolean;
  readonly reason?: string;
}

function clineApiKeyPresent(): boolean {
  if (process.env.CLINE_API_KEY !== undefined) return true;
  return existsSync(resolve(homedir(), ".config", "workflow", "cline-api-key"));
}

/** The loopback metering proxy's upstream key (env, else the shared key file). */
function upstreamKeyPresent(): boolean {
  if ((process.env.CLINE_API_KEY ?? "").trim().length > 0) return true;
  return existsSync(resolve(homedir(), ".config", "workflow", "cline-api-key"));
}

function opencodeBinaryPresent(): boolean {
  const override = process.env.WORKFLOW_OPENCODE_BIN;
  if (override !== undefined) return existsSync(override);
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir.length > 0 && existsSync(resolve(dir, "opencode"))) return true;
  }
  return false;
}

function gooseBinaryPresent(): boolean {
  const override = process.env.WORKFLOW_GOOSE_BIN;
  if (override !== undefined) return existsSync(override);
  return globalGooseBinary() !== undefined;
}

/** Goose's provider credentials for the selected workload: the loopback
 * proxy's upstream key for openrouter, or the Foundry endpoint+key+model for
 * azure (the runtime composes the same pieces and fails closed without them). */
function gooseCredentialsPresent(): boolean {
  let provider: ReturnType<typeof gooseProviderKind>;
  try {
    provider = gooseProviderKind();
  } catch {
    return false;
  }
  if (provider === "azure_foundry") {
    const model = (process.env.WORKFLOW_GOOSE_MODEL ?? process.env.GOOSE_MODEL ?? process.env.AZURE_FOUNDRY_MODEL ?? "").trim();
    return (process.env.AZURE_FOUNDRY_ENDPOINT ?? "").trim().length > 0
      && (process.env.AZURE_FOUNDRY_API_KEY ?? "").trim().length > 0
      && model.length > 0;
  }
  return upstreamKeyPresent();
}

/** The lead agent the battlestation drives by default: OpenCode (the
 * operator's primary, backed by their OpenRouter/auth store). Cline stays
 * reachable through the switcher — the universal-remote surface drives any
 * ACP agent — but it is no longer the default. */
export const DEFAULT_WEB_AGENT: WebAgentId = "opencode";

/** Agents the web surface can compose, with truthful availability + posture.
 * The default agent (OpenCode) leads the list; goose (the contained
 * general-purpose/backup agent, W048) precedes the vendored-Cline fallback. */
export function listWebAgents(): WebAgentInfo[] {
  const clineAvailable = globalClineEntrypoint() !== undefined && clineApiKeyPresent();
  const opencodeAvailable = opencodeBinaryPresent() && existsSync(opencodeAuthPath());
  const gooseAvailable = gooseBinaryPresent() && gooseCredentialsPresent();
  return [
    {
      id: "opencode",
      name: "OpenCode",
      containment: "advisory",
      available: opencodeAvailable,
      ...(opencodeAvailable ? {} : { reason: "needs the opencode binary and ~/.local/share/opencode/auth.json" }),
    },
    {
      id: "goose",
      name: "Goose",
      containment: "contained",
      available: gooseAvailable,
      ...(gooseAvailable ? {} : { reason: "needs the goose binary (aaif-goose/goose or WORKFLOW_GOOSE_BIN) and provider credentials (OpenRouter upstream key CLINE_API_KEY or ~/.config/workflow/cline-api-key, or AZURE_FOUNDRY_ENDPOINT + AZURE_FOUNDRY_API_KEY)" }),
    },
    {
      id: "cline",
      name: "Cline",
      containment: "contained",
      available: clineAvailable,
      ...(clineAvailable ? {} : { reason: "needs the cline binary and CLINE_API_KEY (or ~/.config/workflow/cline-api-key)" }),
    },
  ];
}

export function isWebAgentId(value: unknown): value is WebAgentId {
  return value === "cline" || value === "opencode" || value === "goose";
}

/** Compose a runtime for one agent; the caller owns disposal. */
export async function createAgentRuntime(
  agent: WebAgentId,
  application: WorkflowApplication,
  workspace: string,
  taskId: TaskId,
  resumeFrom: string | undefined,
  options: { readonly permissionBroker?: PermissionBroker | undefined },
): Promise<WorkflowAcpRuntime> {
  if (agent === "opencode") {
    return createConfiguredOpencodeAcpRuntime(application, workspace, taskId, resumeFrom, options);
  }
  if (agent === "goose") {
    return createConfiguredAcpRuntime(application, workspace, taskId, resumeFrom, undefined, { ...options, agent: "goose" });
  }
  return createConfiguredAcpRuntime(application, workspace, taskId, resumeFrom, undefined, options);
}
