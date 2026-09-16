import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Hub client for the substitution tools (plan Task G3). Mirrors the hub
 * protocol's client rules (`docs/HUB_PROTOCOL.md` §1/§4): the hub is
 * resolved per call — never cached at process start — and every failure mode
 * (missing/stale discovery, non-200, unreachable) is a denial. Fail closed.
 */

export interface HubTarget {
  readonly endpoint: string;
  readonly token: string;
}

export class HubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubUnavailableError";
  }
}

/** Per-call resolution: explicit env credentials win, else the discovery file. */
export function resolveHub(): HubTarget {
  const endpoint = process.env.WORKFLOW_HUB_ENDPOINT;
  const token = process.env.WORKFLOW_HUB_TOKEN;
  if (endpoint !== undefined && endpoint.length > 0 && token !== undefined && token.length > 0) {
    return { endpoint, token };
  }
  const discoveryPath = process.env.WORKFLOW_HUB_DISCOVERY ?? join(homedir(), ".workflow", "hub", "discovery.json");
  let raw: string;
  try {
    raw = readFileSync(discoveryPath, "utf8");
  } catch {
    throw new HubUnavailableError(`Workflow hub not running (no discovery file at ${discoveryPath}); refusing to act`);
  }
  let discovery: { protocol?: unknown; endpoint?: unknown; token?: unknown };
  try {
    discovery = JSON.parse(raw);
  } catch (error) {
    throw new HubUnavailableError(`invalid hub discovery file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (discovery.protocol !== 1 || typeof discovery.endpoint !== "string" || typeof discovery.token !== "string") {
    throw new HubUnavailableError("invalid hub discovery file: unsupported protocol or missing fields");
  }
  return { endpoint: discovery.endpoint, token: discovery.token };
}

async function postHub(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const hub = resolveHub();
  const response = await fetch(`${hub.endpoint}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    throw new HubUnavailableError(`Workflow hub unreachable: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (response.status === 401) {
    throw new HubUnavailableError("Workflow hub rejected the credential (stale discovery); refusing to act");
  }
  const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (parsed === null || typeof parsed !== "object") {
    throw new HubUnavailableError(`Workflow hub returned an unparseable body (${response.status}); refusing to act`);
  }
  if (!response.ok) {
    throw new HubUnavailableError(`Workflow hub error (${response.status}): ${String(parsed.error ?? response.statusText)}`);
  }
  return parsed;
}

/**
 * Authorization gate (`/before-tool`). A denial, a stop, or any transport
 * failure throws — callers never act without an explicit allow.
 */
export async function authorizeBeforeTool(input: {
  readonly toolCall: { readonly toolName: string; readonly toolCallId?: string };
  readonly input: Record<string, unknown>;
  readonly workspace?: string;
}): Promise<void> {
  const result = await postHub("/before-tool", {
    toolCall: input.toolCall,
    input: input.input,
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
  }, 30_000);
  if (result.stop === true && typeof result.reason === "string") {
    throw new Error(`Workflow denied ${input.toolCall.toolName}: ${result.reason}`);
  }
  if (result.stop === true) {
    throw new Error(`Workflow denied ${input.toolCall.toolName}`);
  }
}

/** Contained shell execution through the hub's `/bash` route. */
export async function runBash(input: { readonly command: string; readonly cwd: string }): Promise<string> {
  const result = await postHub("/bash", { command: input.command, cwd: input.cwd }, 300_000);
  if (typeof result.output !== "string") {
    throw new HubUnavailableError("Workflow hub returned no bash output");
  }
  return result.output;
}
