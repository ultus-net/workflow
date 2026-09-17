import type { WorkflowSnapshot } from "../application/workflow.js";

import type { ResolvedHub } from "./hub-client.js";

/**
 * Hub-attached snapshot source for the monitor: the canonical task/evidence
 * projection comes from the Workflow hub's `/snapshot` endpoint, refreshed on
 * a poll. No in-process authority is created; the hub remains the single
 * authority the monitor observes.
 */

/**
 * Plan Task A3: run-gate observability view for monitors. Plain records (the
 * /snapshot payload is JSON); observation only.
 */
export interface HubGateObservability {
  readonly reviewOutcomes: Record<string, { readonly reviewerRunId: string; readonly verdict: string; readonly recorded: boolean; readonly summary: string; readonly parseFailure?: string }>;
  readonly blockingReasons: Record<string, string>;
  readonly completionClaims: Record<string, { readonly runId: string; readonly claim: string; readonly verifiedAtClaim: boolean; readonly observedAt: string }>;
  /**
   * W044 (open clause): per-run metering-proxy totals, recorded hub-side at
   * run-turn end. Optional: hubs older than the aggregation omit the field.
   */
  readonly usage?: Record<string, { readonly requests: number; readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number; readonly costUsd: number; readonly recordedAt: string }>;
}

interface SnapshotResponse {
  snapshot?: WorkflowSnapshot;
  gateObservability?: HubGateObservability;
}

export async function fetchHubSnapshot(hub: ResolvedHub, workspace: string): Promise<SnapshotResponse> {
  const response = await fetch(`${hub.url}/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
    body: JSON.stringify({ workspace }),
    signal: AbortSignal.timeout(2_000),
  });
  if (response.status !== 200) throw new Error(`hub snapshot request failed with status ${response.status}`);
  const body = (await response.json()) as SnapshotResponse;
  if (typeof body !== "object" || body === null || body.snapshot === undefined) {
    throw new Error("hub snapshot response malformed");
  }
  return body;
}

export interface HubSnapshotSource {
  snapshot(): WorkflowSnapshot;
  gateObservability(): HubGateObservability | undefined;
  refresh(): Promise<void>;
}

export function emptyHubSnapshot(): WorkflowSnapshot {
  return { enforcementLevel: "advisory", transport: "other", mutationEpoch: 0, tasks: [], evidence: [], history: [] };
}

export function createHubSnapshotSource(hub: ResolvedHub, workspace: string): HubSnapshotSource {
  let current = emptyHubSnapshot();
  let gates: HubGateObservability | undefined = undefined;
  return {
    snapshot: () => current,
    gateObservability: () => gates,
    async refresh() {
      const body = await fetchHubSnapshot(hub, workspace);
      if (body.snapshot !== undefined) current = body.snapshot;
      gates = body.gateObservability;
    },
  };
}
