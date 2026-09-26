import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createReviewFollowUpsClient } from "../src/integrations/review-followups.js";

const serverScript = resolve("mcp-toolbox/apps/review-accountability-mcp/dist/server.js");

async function seedFollowUps(dataDir: string, findings: ReadonlyArray<{ readonly severity: "P2" | "P3"; readonly summary: string }>): Promise<void> {
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
      findings: findings.map((finding) => ({ ...finding, paths: ["src/x.ts"] })),
    },
  });
  await client.close();
}

test("review follow-ups client lists open P2/P3 findings", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wf-fu-data-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  await seedFollowUps(dataDir, [
    { severity: "P2", summary: "missing edge coverage" },
    { severity: "P3", summary: "nit: naming" },
  ]);

  const followUps = await createReviewFollowUpsClient({ serverScript, workspaceRoot: process.cwd(), dataDir });
  t.after(() => followUps.close());
  const open = await followUps.openFollowUps(8);

  assert.equal(open.available, true, "a ledger that answered is available");
  assert.equal(open.followUps.length, 2);
  assert.deepEqual(open.followUps.map((item) => item.severity).sort(), ["P2", "P3"]);
  assert.equal(open.followUps[0]!.status, "open");
  assert.equal(open.truncated, false, "a ledger inside the window is not truncated");
});

test("a follow-up ledger larger than the window reports truncation (the panel must not claim 8 is the total)", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wf-fu-cap-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  await seedFollowUps(dataDir, Array.from({ length: 9 }, (_unused, index) => ({ severity: "P2" as const, summary: `finding ${index}` })));

  const followUps = await createReviewFollowUpsClient({ serverScript, workspaceRoot: process.cwd(), dataDir });
  t.after(() => followUps.close());
  const capped = await followUps.openFollowUps(8);

  assert.equal(capped.followUps.length, 8, "the window is still bounded by the requested limit");
  assert.equal(capped.truncated, true, "the ledger holds more open follow-ups than the window returned");

  // A wider window covers the whole ledger, and says so.
  const full = await followUps.openFollowUps(20);
  assert.equal(full.followUps.length, 9);
  assert.equal(full.truncated, false);
});

test("a ledger the server refuses to list reads as unavailable, not as zero debt", async (t) => {
  // An out-of-schema workspaceRoot makes list_reviews answer isError with no
  // structured content. Reading that as an empty list would tell the Activity
  // panel "0 open" about debt nobody consulted.
  const followUps = await createReviewFollowUpsClient({ serverScript, workspaceRoot: "x".repeat(5_000) });
  t.after(() => followUps.close());

  const refused = await followUps.openFollowUps(8);

  assert.equal(refused.available, false, "an unread ledger must be marked unavailable");
  assert.equal(refused.followUps.length, 0, "no follow-up was actually observed");
});
