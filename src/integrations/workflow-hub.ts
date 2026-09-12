import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

import type { WorkflowApplication } from "../application/workflow.js";
import { createWorkflowClineTuiBridge, type WorkflowClineTuiBridge } from "./cline-tui-bridge.js";

/**
 * The Workflow hub daemon: a long-running loopback authority that any Cline
 * surface can resolve through the discovery file. See `docs/HUB.md`.
 */

export interface WorkflowHub {
  readonly url: string;
  readonly discoveryPath: string;
  close(): Promise<void>;
}

export function defaultHubDirectory(): string {
  return resolve(homedir(), ".workflow", "hub");
}

export function resolveHubDiscoveryPath(dir: string): string {
  return join(dir, "hub", "discovery.json");
}

export async function createWorkflowHub(
  application: WorkflowApplication,
  options: { discoveryDir?: string } = {},
): Promise<WorkflowHub> {
  const dir = options.discoveryDir ?? resolve(homedir(), ".workflow");
  const discoveryPath = resolveHubDiscoveryPath(dir);
  application.startInteractiveTask();
  const bridge: WorkflowClineTuiBridge = await createWorkflowClineTuiBridge(application);

  mkdirSync(dirname(discoveryPath), { recursive: true });
  const temporaryPath = `${discoveryPath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({
      protocol: 1,
      hubId: randomBytes(8).toString("hex"),
      endpoint: bridge.url,
      token: bridge.token,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporaryPath, discoveryPath);

  return {
    url: bridge.url,
    discoveryPath,
    close: async () => {
      await bridge.close();
      rmSync(discoveryPath, { force: true });
    },
  };
}