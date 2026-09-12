import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { resolveHubDiscoveryPath } from "../integrations/workflow-hub.js";

/**
 * Launcher-side hub client. Resolves the global Workflow hub through its
 * discovery file and fails closed when the daemon is unavailable.
 * See `docs/HUB.md` operational semantics.
 */

export interface HubDiscovery {
  readonly hubId: string;
  readonly endpoint: string;
  readonly token: string;
}

export interface ResolvedHub {
  readonly url: string;
  readonly token: string;
}

export function readHubDiscovery(discoveryPath: string): HubDiscovery | undefined {
  if (!existsSync(discoveryPath)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(discoveryPath, "utf8"));
    if (
      typeof value !== "object" || value === null ||
      typeof (value as Record<string, unknown>).hubId !== "string" ||
      typeof (value as Record<string, unknown>).endpoint !== "string" ||
      typeof (value as Record<string, unknown>).token !== "string"
    ) {
      return undefined;
    }
    return value as HubDiscovery;
  } catch {
    return undefined;
  }
}

export async function probeHub(discovery: HubDiscovery): Promise<boolean> {
  try {
    const response = await fetch(`${discovery.endpoint}/before-tool`, {
      method: "POST",
      headers: { authorization: `Bearer ${discovery.token}`, "content-type": "application/json" },
      body: JSON.stringify({ toolCall: { toolName: "read_file" }, input: { path: "." } }),
      signal: AbortSignal.timeout(2_000),
    });
    return response.status !== 401;
  } catch {
    return false;
  }
}

export async function resolveWorkflowHub(
  options: { discoveryDir?: string } = {},
): Promise<ResolvedHub> {
  const dir = options.discoveryDir ?? resolve(homedir(), ".workflow");
  const discoveryPath = resolveHubDiscoveryPath(dir);
  const discovery = readHubDiscovery(discoveryPath);
  if (discovery !== undefined && (await probeHub(discovery))) {
    return { url: discovery.endpoint, token: discovery.token };
  }
  // Obsolete or missing discovery: remove the stale file and fail closed.
  rmSync(discoveryPath, { force: true });
  throw new Error(
    "Workflow hub is not running; start the authority daemon with `workflow-hub` before launching a Cline surface",
  );
}
