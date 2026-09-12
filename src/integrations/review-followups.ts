import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Thin Workflow-side client for the review-accountability MCP server. Powers
 * the Activity panel's "review follow-ups" section: durable P2/P3 findings
 * from adversarial reviews, visible until resolved. Advisory: when the server
 * is unavailable, callers degrade to an empty list.
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

export interface ReviewFollowUps {
  openFollowUps(limit: number): Promise<readonly ReviewFollowUp[]>;
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
      async openFollowUps(limit: number): Promise<readonly ReviewFollowUp[]> {
        const result = await client.callTool({
          name: "list_reviews",
          arguments: { workspaceRoot: options.workspaceRoot, followUpLimit: limit, limit: 1 },
        });
        const content = result.structuredContent as { openFollowUps?: ReviewFollowUp[] } | undefined;
        return content?.openFollowUps ?? [];
      },
      async close(): Promise<void> {
        await client.close();
      },
    } satisfies ReviewFollowUps;
  });

  return ready;
}
