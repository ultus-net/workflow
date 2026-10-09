import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAzureJobsIngest,
  createDispatchRecordRegistry,
  createRecordingEnqueue,
  validateWorkerEvidence,
  WorkerEvidenceError,
  type DispatchRecord,
} from "../src/integrations/azure-jobs-record.js";
import { AzureJobMessageError } from "../src/integrations/azure-jobs-schema.js";

/**
 * C1 deploy plan §2.c (the return leg) — the dispatch-record registry + the
 * `validateDispatch(taskId)` evidence-ingest read path.
 *
 * The registry is the hub-held DENOMINATOR: the ingest checks the returned blob
 * against what the hub recorded at dispatch, so a caller cannot self-satisfy a
 * coverage check. The pins here prove the fail-closed matrix
 * (unknown/missing/invalid/incomplete/stale-corpus/failed/covered) and the
 * recording wrapper's ordering.
 */

const DECLARED = ["test:<workspace>", "diff:"];
const FINGERPRINT = "a".repeat(64);

function record(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    taskId: "task-1",
    declaredEvidence: DECLARED,
    corpusFingerprint: FINGERPRINT,
    blobPath: "runs/task-1.json",
    evidenceContainer: "evidence",
    messageId: "mid-1",
    dispatchedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    specVersion: 1,
    taskId: "task-1",
    exitCode: 0,
    corpusFingerprint: FINGERPRINT,
    declaredEvidence: DECLARED,
    ...overrides,
  });
}

/** A fetcher that answers one blob GET with a chosen status/body. */
function blobFetcher(status: number, body: string, capture?: (url: string, init?: RequestInit) => void): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capture?.(url, init);
    if (status === 404) return new Response("not found", { status: 404 });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function ingest(status: number, body: string, capture?: (url: string, init?: RequestInit) => void) {
  const registry = createDispatchRecordRegistry();
  registry.record(record());
  const validate = createAzureJobsIngest({
    registry,
    accountUrl: "https://acct.blob.core.windows.net",
    evidenceContainer: "evidence",
    fetcher: blobFetcher(status, body, capture),
    getToken: async () => "token",
  });
  return { registry, validate };
}

test("azure-jobs-record: the registry is the hub-held denominator", () => {
  const registry = createDispatchRecordRegistry();
  assert.equal(registry.get("task-1"), undefined);
  registry.record(record());
  assert.equal(registry.get("task-1")?.declaredEvidence.length, 2);
  // A later record replaces the prior one for the same taskId.
  registry.record(record({ messageId: "mid-2" }));
  assert.equal(registry.get("task-1")?.messageId, "mid-2");
  assert.equal(registry.records().length, 2, "the append journal keeps both.");
});

test("azure-jobs-record: the record journal is bounded", () => {
  const registry = createDispatchRecordRegistry();
  for (let index = 0; index < 70; index += 1) registry.record(record({ taskId: `task-${index}` }));
  assert.equal(registry.records().length, 64);
  assert.equal(registry.records()[0]?.taskId, "task-6", "the oldest are evicted first.");
});

test("azure-jobs-record: validateWorkerEvidence accepts a full record and rejects the faults", () => {
  assert.equal(validateWorkerEvidence(JSON.parse(evidence())).taskId, "task-1");
  assert.equal(validateWorkerEvidence(JSON.parse(evidence({ branch: "workflow/task-1", prUrl: "https://pr/1" }))).branch, "workflow/task-1");
  // A missing taskId, a bad specVersion, a non-integer exitCode, and a
  // non-array declaredEvidence each refuse.
  assert.throws(() => validateWorkerEvidence(JSON.parse(evidence({ taskId: "" }))), WorkerEvidenceError);
  assert.throws(() => validateWorkerEvidence(JSON.parse(evidence({ specVersion: 2 }))), /specVersion/);
  assert.throws(() => validateWorkerEvidence(JSON.parse(evidence({ exitCode: 1.5 }))), /exitCode/);
  assert.throws(() => validateWorkerEvidence(JSON.parse(evidence({ declaredEvidence: "x" }))), /declaredEvidence/);
  assert.throws(() => validateWorkerEvidence(JSON.parse(evidence({ declaredEvidence: [""] }))), /declaredEvidence\[0\]/);
  // An empty corpusFingerprint refuses.
  assert.throws(() => validateWorkerEvidence(JSON.parse(evidence({ corpusFingerprint: "" }))), /corpusFingerprint/);
});

test("azure-jobs-record: an unknown taskId is 'unknown', never a fabricated pass", async () => {
  const registry = createDispatchRecordRegistry();
  let called = false;
  const validate = createAzureJobsIngest({
    registry,
    accountUrl: "https://acct.blob.core.windows.net",
    evidenceContainer: "evidence",
    fetcher: (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch,
    getToken: async () => "token",
  });
  assert.deepEqual(await validate("nope"), { taskId: "nope", status: "unknown" });
  assert.equal(called, false, "an unknown task never reaches the network.");
});

test("azure-jobs-record: a 404 blob is 'missing'", async () => {
  const { validate } = ingest(404, "");
  assert.equal((await validate("task-1")).status, "missing");
});

test("azure-jobs-record: a malformed blob is 'invalid' (not JSON, and not a worker record)", async () => {
  assert.equal((await ingest(200, "{ not json").validate("task-1")).status, "invalid");
  assert.equal((await ingest(200, JSON.stringify({ specVersion: 2 })).validate("task-1")).status, "invalid");
});

test("azure-jobs-record: uncovered declared evidence is 'incomplete' and names the gap", async () => {
  // The worker returned only one of the two declared items.
  const { validate } = ingest(200, evidence({ declaredEvidence: ["test:<workspace>"] }));
  const outcome = await validate("task-1");
  assert.equal(outcome.status, "incomplete");
  assert.deepEqual(outcome.missing, ["diff:"]);
});

test("azure-jobs-record: a corpus fingerprint mismatch is 'stale-corpus'", async () => {
  const { validate } = ingest(200, evidence({ corpusFingerprint: "b".repeat(64) }));
  const outcome = await validate("task-1");
  assert.equal(outcome.status, "stale-corpus");
  assert.match(outcome.reason ?? "", /does not match the dispatched/);
});

test("azure-jobs-record: a nonzero worker exit is 'failed' (evidence present, run failed)", async () => {
  const { validate } = ingest(200, evidence({ exitCode: 2 }));
  const outcome = await validate("task-1");
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.exitCode, 2);
});

test("azure-jobs-record: full coverage is 'covered' and carries the branch/PR", async () => {
  const { validate } = ingest(200, evidence({ branch: "workflow/task-1", prUrl: "https://pr/1" }));
  const outcome = await validate("task-1");
  assert.deepEqual(outcome, {
    taskId: "task-1",
    status: "covered",
    exitCode: 0,
    branch: "workflow/task-1",
    prUrl: "https://pr/1",
  });
});

test("azure-jobs-record: the ingest reads the recorded blob path with a Bearer GET", async () => {
  const seen: { url: string; auth: string; method: string } = { url: "", auth: "", method: "" };
  const { validate } = ingest(200, evidence(), (url, init) => {
    seen.url = url;
    seen.method = init?.method ?? "";
    seen.auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
  });
  await validate("task-1");
  assert.equal(seen.url, "https://acct.blob.core.windows.net/evidence/runs/task-1.json");
  assert.equal(seen.method, "GET");
  assert.match(seen.auth, /^Bearer /);
});

test("azure-jobs-record: a non-404 transport fault throws (the route 5xx's), never a fabricated outcome", async () => {
  const { validate } = ingest(503, "unavailable");
  await assert.rejects(() => validate("task-1"), /answered 503/);
});

test("azure-jobs-record: a malformed taskId is a named client fault", async () => {
  const { validate } = ingest(200, evidence());
  await assert.rejects(() => validate("bad/segment"), /safe path segment/);
});

test("azure-jobs-record: every resolved outcome is journaled", async () => {
  const { registry, validate } = ingest(200, evidence({ exitCode: 1 }));
  await validate("task-1");
  assert.deepEqual(registry.outcomes().map((outcome) => outcome.status), ["failed"]);
});

test("azure-jobs-record: the recording enqueue records the dispatch on success", async () => {
  const registry = createDispatchRecordRegistry();
  const enqueue = createRecordingEnqueue({
    registry,
    enqueue: async () => {
      // The record is written AFTER enqueue returns (a failed enqueue must
      // record nothing — the next test), so during enqueue it is still absent.
      assert.equal(registry.get("task-1"), undefined);
      return { taskId: "task-1", messageId: "mid-9", viaBlobRef: false };
    },
    validate: () => ({
      taskId: "task-1",
      task: { declaredEvidence: DECLARED },
      mcp: { corpusFingerprint: FINGERPRINT },
      artifacts: { blobPrefix: "runs", evidenceContainer: "evidence" },
    }),
    now: () => "2026-10-09T01:00:00.000Z",
  });
  const result = await enqueue({ any: "message" });
  assert.deepEqual(result, { taskId: "task-1", messageId: "mid-9", viaBlobRef: false });
  assert.deepEqual(registry.get("task-1"), {
    taskId: "task-1",
    declaredEvidence: DECLARED,
    corpusFingerprint: FINGERPRINT,
    blobPath: "runs/task-1.json",
    evidenceContainer: "evidence",
    messageId: "mid-9",
    dispatchedAt: "2026-10-09T01:00:00.000Z",
  });
});

test("azure-jobs-record: the recording enqueue never records a failed enqueue", async () => {
  const registry = createDispatchRecordRegistry();
  const enqueue = createRecordingEnqueue({
    registry,
    enqueue: async () => { throw new Error("azure job dispatch: the queue answered 503"); },
    validate: () => ({
      taskId: "task-1",
      task: { declaredEvidence: DECLARED },
      mcp: { corpusFingerprint: FINGERPRINT },
      artifacts: { blobPrefix: "runs", evidenceContainer: "evidence" },
    }),
  });
  await assert.rejects(() => enqueue({}), /answered 503/);
  assert.equal(registry.get("task-1"), undefined, "a failed enqueue records nothing.");
});

test("azure-jobs-record: a malformed message refuses at the recording enqueue (the 400 classification)", async () => {
  const registry = createDispatchRecordRegistry();
  const enqueue = createRecordingEnqueue({
    registry,
    enqueue: async () => ({ taskId: "x", messageId: "m", viaBlobRef: false }),
    validate: () => { throw new AzureJobMessageError("invalid azure job message: bad"); },
  });
  await assert.rejects(() => enqueue({}), AzureJobMessageError);
  assert.equal(registry.records().length, 0);
});
