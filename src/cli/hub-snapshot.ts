import type { WorkflowSnapshot } from "../application/workflow.js";

import type { ResolvedHub } from "./hub-client.js";

/**
 * Hub-attached snapshot source for the monitor: the canonical task/evidence
 * projection comes from the Workflow hub's `/snapshot` endpoint, refreshed on
 * a poll. No in-process authority is created; the hub remains the single
 * authority the monitor observes.
 */

export async function fetchHubSnapshot(hub: ResolvedHub, workspace: string): Promise<WorkflowSnapshot> {
  const response = await fetch(`${hub.url}/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
    body: JSON.stringify({ workspace }),
    signal: AbortSignal.timeout(2_000),
  });
  if (response.status !== 200) throw new Error(`hub snapshot request failed with status ${response.status}`);
  const body = (await response.json()) as { snapshot?: WorkflowSnapshot };
  if (typeof body !== "object" || body === null || body.snapshot === undefined) {
    throw new Error("hub snapshot response malformed");
  }
  return body.snapshot;
}

export interface HubSnapshotSource {
  snapshot(): WorkflowSnapshot;
  refresh(): Promise<void>;
}

export function emptyHubSnapshot(): WorkflowSnapshot {
  return { enforcementLevel: "advisory", transport: "other", mutationEpoch: 0, tasks: [], evidence: [], history: [] };
}

export function createHubSnapshotSource(hub: ResolvedHub, workspace: string): HubSnapshotSource {
  let current = emptyHubSnapshot();
  return {
    snapshot: () => current,
    async refresh() {
      current = await fetchHubSnapshot(hub, workspace);
    },
  };
}
