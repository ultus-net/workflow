import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Thin Workflow-side client for the review-accountability MCP server. Powers
 * the Activity panel's "review follow-ups" section: durable P2/P3 findings
 * from adversarial reviews, visible until resolved. Advisory: a ledger that
 * could not be consulted reads as unavailable, never as an empty one.
 */

export interface ReviewFollowUp {
  readonly severity: "P2" | "P3";
  readonly summary: string;
  readonly paths: readonly string[];
  readonly id: string;
  readonly reviewId: string;
  readonly status: "open" | "resolved";
  readonly createdAt: number;
}

/**
 * One bounded read of the open follow-up ledger: the items inside the
 * requested window plus the ledger's own truncation flag. The flag is what
 * lets a surface say "N+ open" instead of passing a capped window's length off
 * as the total debt.
 */
export interface OpenReviewFollowUps {
  readonly followUps: readonly ReviewFollowUp[];
  /** True when open follow-ups exist beyond the returned window. */
  readonly truncated: boolean;
  /**
   * False when the ledger could not be consulted — the server is missing, the
   * call was refused, or it rejected. An unconsultable ledger is unknown debt,
   * never zero debt, so every read states which of the two it is.
   */
  readonly available: boolean;
}

/** The honest shape of a ledger nobody could read: no debt observed, not none. */
export const UNAVAILABLE_REVIEW_FOLLOW_UPS: OpenReviewFollowUps = { followUps: [], truncated: false, available: false };

/**
 * The ledger's own entry contract, mirrored from the server's `followUp`
 * schema and the store's `validStoredFollowUp`: the ledger mints P2/P3
 * follow-ups only, each one identified and rendered by the panel.
 */
function validReviewFollowUp(value: unknown): value is ReviewFollowUp {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ReviewFollowUp>;
  return (item.severity === "P2" || item.severity === "P3")
    && typeof item.id === "string" && item.id.length > 0
    && typeof item.reviewId === "string"
    && typeof item.summary === "string"
    && Array.isArray(item.paths) && item.paths.every((path) => typeof path === "string")
    && (item.status === "open" || item.status === "resolved")
    && typeof item.createdAt === "number" && Number.isFinite(item.createdAt);
}

/**
 * Validate one `list_reviews` payload into a bounded read, or into the
 * unavailable marker.
 *
 * Structured content crosses a trust boundary: nothing about the payload's
 * shape is guaranteed by the transport, so a malformed or foreign ledger
 * would otherwise be rendered as debt this surface actually observed — a
 * `[P0]` line the ledger never minted, an entry the panel cannot even key,
 * counted as open. A payload that does not match the contract the store
 * itself validates is a ledger that could not be read, which is unknown debt
 * and never zero. The requested window is part of that contract: the server
 * caps `openFollowUps` at the limit it was handed, so a longer payload is not
 * a bigger ledger, it is a read this surface cannot bound.
 */
export function readOpenReviewFollowUps(content: unknown, limit: number): OpenReviewFollowUps {
  if (!content || typeof content !== "object") return UNAVAILABLE_REVIEW_FOLLOW_UPS;
  const payload = content as { openFollowUps?: unknown; followUpsTruncated?: unknown };
  if (!Array.isArray(payload.openFollowUps)) return UNAVAILABLE_REVIEW_FOLLOW_UPS;
  // Checked before the walk, not after: an over-window payload is already a
  // broken read, so validating it entry by entry would spend unbounded work on
  // a foreign array. The panel counts this list as the total debt and prints
  // "N open" with no "+", so an over-window count states a completeness claim
  // no bounded read ever made.
  if (payload.openFollowUps.length > limit) return UNAVAILABLE_REVIEW_FOLLOW_UPS;
  const followUps: ReviewFollowUp[] = [];
  // The panel keys and counts by id, so an absent or repeated one is not a
  // follow-up this surface can speak about.
  const seen = new Set<string>();
  for (const entry of payload.openFollowUps) {
    if (!validReviewFollowUp(entry) || seen.has(entry.id)) return UNAVAILABLE_REVIEW_FOLLOW_UPS;
    seen.add(entry.id);
    followUps.push(entry);
  }
  // The ledger states its own cap. Without that flag a full window is not
  // proof of completeness, so it degrades to "capped", never to "all". A flag
  // of the wrong type is not an absent flag, though: that is a broken read.
  let truncated: boolean;
  if (typeof payload.followUpsTruncated === "boolean") truncated = payload.followUpsTruncated;
  else if (payload.followUpsTruncated === undefined) truncated = followUps.length >= limit;
  else return UNAVAILABLE_REVIEW_FOLLOW_UPS;
  return { followUps, truncated, available: true };
}

export interface ReviewFollowUps {
  openFollowUps(limit: number): Promise<OpenReviewFollowUps>;
  close(): Promise<void>;
}

/**
 * A polling ledger read, mirroring the hub snapshot source: the launcher owns
 * the cadence, the surface reads the latest observation. A boot-time value is
 * not live debt — a follow-up recorded after launch would never appear, and
 * resolved debt would stay on screen until restart.
 */
export interface ReviewFollowUpsSource {
  /** The most recent observation. Never a synthesized empty ledger. */
  current(): OpenReviewFollowUps;
  refresh(): Promise<void>;
}

export function createReviewFollowUpsSource(client: ReviewFollowUps, limit: number): ReviewFollowUpsSource {
  // Before the first read there is no observation at all, and no observation
  // is not zero debt: the honest pre-refresh state is the unavailable marker,
  // the same one a refused read produces.
  let latest = UNAVAILABLE_REVIEW_FOLLOW_UPS;
  return {
    current: () => latest,
    async refresh() {
      // The poller never rejects: a poll that fails is a read this surface
      // cannot make, which is debt it cannot see — not a reason to stop polling.
      latest = await client.openFollowUps(limit).catch(() => UNAVAILABLE_REVIEW_FOLLOW_UPS);
    },
  };
}

export function createReviewFollowUpsClient(options: {
  readonly serverScript: string;
  readonly workspaceRoot: string;
  readonly dataDir?: string;
}): Promise<ReviewFollowUps> {
  const client = new Client({ name: "workflow-review-followups", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverScript],
    stderr: "pipe",
    ...(options.dataDir === undefined ? {} : { env: { REVIEW_ACCOUNTABILITY_DATA_DIR: options.dataDir } }),
  });

  const ready = client.connect(transport).then(() => {
    return {
      async openFollowUps(limit: number): Promise<OpenReviewFollowUps> {
        // A refused or rejected read is not a zero-length ledger: it is debt
        // this surface cannot see, and the caller has to be able to say so.
        const result = await client.callTool({
          name: "list_reviews",
          arguments: { workspaceRoot: options.workspaceRoot, followUpLimit: limit, limit: 1 },
        }).catch(() => undefined);
        if (result === undefined || result.isError === true) return UNAVAILABLE_REVIEW_FOLLOW_UPS;
        return readOpenReviewFollowUps(result.structuredContent, limit);
      },
      async close(): Promise<void> {
        await client.close();
      },
    } satisfies ReviewFollowUps;
  });

  return ready;
}
