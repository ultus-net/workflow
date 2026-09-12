import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createReviewFollowUpsClient } from "../src/integrations/review-followups.js";

const serverScript = resolve("mcp-toolbox/apps/review-accountability-mcp/dist/server.js");

test("review follow-ups client lists open P2/P3 findings", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wf-fu-data-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const client = new Client({ name: "seed", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    stderr: "pipe",
    env: { REVIEW_ACCOUNTABILITY_DATA_DIR: dataDir },
  }));
  await client.callTool({
    name: "record_review",
    arguments: {
      workspaceRoot: process.cwd(),
      reviewer: "test-reviewer",
      verdict: "changes_requested",
      subject: { kind: "fingerprint", algorithm: "sha256", version: "1", scope: "worktree", value: "a".repeat(64) },
      blockingSeverities: ["P0", "P1"],
      findings: [
        { severity: "P2", summary: "missing edge coverage", paths: ["src/x.ts"] },
        { severity: "P3", summary: "nit: naming", paths: [] },
      ],
    },
  });
  await client.close();

  const followUps = await createReviewFollowUpsClient({ serverScript, workspaceRoot: process.cwd(), dataDir });
  t.after(() => followUps.close());
  const open = await followUps.openFollowUps(8);

  assert.equal(open.length, 2);
  assert.deepEqual(open.map((item) => item.severity).sort(), ["P2", "P3"]);
  assert.equal(open[0]!.status, "open");
});
