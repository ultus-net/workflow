import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  UNAVAILABLE_REVIEW_FOLLOW_UPS,
  createReviewFollowUpsClient,
  createReviewFollowUpsSource,
  readOpenReviewFollowUps,
  type OpenReviewFollowUps,
} from "../src/integrations/review-followups.js";

const serverScript = resolve("mcp-toolbox/apps/review-accountability-mcp/dist/server.js");

/** A follow-up exactly as the ledger's own schema mints it. */
const storedFollowUp = {
  severity: "P2",
  summary: "missing edge coverage",
  paths: ["src/x.ts"],
  id: "fu-1",
  reviewId: "rev-1",
  status: "open",
  createdAt: 1_700_000_000_000,
} as const;

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

test("a P1 entry in the payload is debt the ledger never minted, so the read is unavailable", () => {
  // The ledger only ever mints P2/P3 follow-ups. A blocking-severity entry
  // arriving over the wire is not observed debt; the panel would render it as
  // a live "[P1] …" line and count it as open.
  const read = readOpenReviewFollowUps({ openFollowUps: [{ ...storedFollowUp, severity: "P1" }], followUpsTruncated: false }, 8);

  assert.equal(read.available, false, "a payload outside the ledger's contract was not a consulted ledger");
  assert.equal(read.followUps.length, 0, "no follow-up was actually observed");
  assert.deepEqual(read, UNAVAILABLE_REVIEW_FOLLOW_UPS);
});

test("a follow-up the panel cannot identify reads as unavailable, not as open debt", () => {
  // The Activity panel keys and counts by id (`key={item.id}`), so an entry
  // with no id — or a repeated one — is not debt this surface can speak about.
  const idless = readOpenReviewFollowUps({ openFollowUps: [{ ...storedFollowUp, id: undefined }], followUpsTruncated: false }, 8);
  assert.equal(idless.available, false, "an unidentifiable follow-up must not be rendered as observed debt");
  assert.equal(idless.followUps.length, 0);

  const duplicate = readOpenReviewFollowUps({ openFollowUps: [storedFollowUp, { ...storedFollowUp, summary: "second" }], followUpsTruncated: false }, 8);
  assert.equal(duplicate.available, false, "two entries sharing an id cannot both be one counted follow-up");
  assert.equal(duplicate.followUps.length, 0);
});

test("a garbage truncation flag reads as unavailable, while an absent one still caps by window", () => {
  // `followUpsTruncated` is what separates "N+ open" from "all debt shown".
  // A flag of the wrong type is a broken read, not a missing one: trusting it
  // either way states a completeness claim nobody made.
  const garbage = readOpenReviewFollowUps({ openFollowUps: [storedFollowUp], followUpsTruncated: "nope" }, 8);
  assert.equal(garbage.available, false, "a flag the ledger contract cannot produce must not be interpreted");
  assert.equal(garbage.followUps.length, 0);

  // An absent flag keeps the honest degradation: a window filled to the brim
  // is not proof that no debt sits beyond it.
  const absent = readOpenReviewFollowUps({ openFollowUps: [storedFollowUp] }, 1);
  assert.equal(absent.available, true, "a well-formed read stays available");
  assert.equal(absent.followUps.length, 1);
  assert.equal(absent.truncated, true, "a full window without the ledger's flag stays 'capped', never 'all'");
});

test("a valid payload passes through with the ledger's own truncation flag intact", () => {
  const read = readOpenReviewFollowUps({ openFollowUps: [storedFollowUp, { ...storedFollowUp, id: "fu-2", severity: "P3", status: "resolved" }], followUpsTruncated: true }, 8);

  assert.equal(read.available, true, "a ledger that answered within its contract is available");
  assert.deepEqual(read.followUps.map((item) => item.id), ["fu-1", "fu-2"]);
  assert.equal(read.truncated, true, "the ledger's own cap outranks the window's length");
});

test("the poller source re-reads the ledger instead of freezing a boot-time value", async () => {
  // The launcher's cadence lives here; the surface only reads `current()`. A
  // captured value would make "N open" a claim about launch time — a P2
  // recorded after launch would never appear, resolved debt would never leave.
  let read: OpenReviewFollowUps = { followUps: [], truncated: false, available: true };
  const limits: number[] = [];
  const source = createReviewFollowUpsSource({
    async openFollowUps(limit: number) {
      limits.push(limit);
      return read;
    },
    async close() {},
  }, 8);

  assert.equal(source.current().available, false, "before the first read there is no observation, and none is not zero");
  await source.refresh();
  assert.equal(source.current().available, true);
  assert.equal(source.current().followUps.length, 0, "a consulted empty ledger really is empty");

  read = {
    followUps: [
      { severity: "P2", summary: "recorded after launch", paths: ["src/x.ts"], id: "1", reviewId: "r1", status: "open", createdAt: 1 },
    ],
    truncated: false,
    available: true,
  };
  await source.refresh();
  assert.equal(source.current().followUps.length, 1, "debt recorded after the first read must be observable");
  assert.deepEqual(limits, [8, 8], "the poller owns the cadence and the window");

  // A failing read is debt this surface cannot see, not a reason to stop
  // polling: the poller degrades to the unavailable marker and keeps running.
  const failing = createReviewFollowUpsSource({
    async openFollowUps() {
      throw new Error("ledger gone");
    },
    async close() {},
  }, 8);
  await failing.refresh();
  assert.equal(failing.current().available, false, "a rejected read must read as unavailable");
  assert.equal(failing.current().followUps.length, 0);
  assert.deepEqual(failing.current(), UNAVAILABLE_REVIEW_FOLLOW_UPS);
});
