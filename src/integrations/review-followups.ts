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

export interface ReviewFollowUps {
  openFollowUps(limit: number): Promise<OpenReviewFollowUps>;
  close(): Promise<void>;
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
        const content = result.structuredContent as { openFollowUps?: ReviewFollowUp[]; followUpsTruncated?: boolean } | undefined;
        const followUps = content?.openFollowUps ?? [];
        // The ledger states its own cap. Without that flag a full window is not
        // proof of completeness, so it degrades to "capped", never to "all".
        return { followUps, truncated: content?.followUpsTruncated ?? followUps.length >= limit, available: true };
      },
      async close(): Promise<void> {
        await client.close();
      },
    } satisfies ReviewFollowUps;
  });

  return ready;
}
