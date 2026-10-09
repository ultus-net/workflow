import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AZURE_STORAGE_API_VERSION,
  QUEUE_BODY_LIMIT_BYTES,
  azureJobsDispatchFromEnv,
  createAzureJobsDispatch,
} from "../src/integrations/azure-jobs-dispatch.js";
import { AzureJobMessageError, serializeAzureJobMessage, validateAzureJobMessage } from "../src/integrations/azure-jobs-schema.js";

// C1 deploy plan §2.c — the Azure Storage Queue dispatch client. Pins per the
// registered prediction:
//   1. env classification is fail-closed: opt-in WORKFLOW_AZURE_JOBS=1 plus a
//      valid queue URL + evidence container; missing/malformed names the var;
//   2. enqueue validates the message BEFORE any wire call (a malformed message
//      never becomes a queued job);
//   3. the wire is Queue REST with Bearer auth + x-ms-version + x-ms-date (no
//      SharedKey signature), the body is the base64 QueueMessage XML shape;
//   4. an oversized message rides a blob PUT + a small ref envelope on the
//      queue;
//   5. transport/queue faults throw (never a silent drop).

const QUEUE_URL = "https://wfdemo.queue.core.windows.net/workflow-dispatch";

function validMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specVersion: 1,
    taskId: "task-123",
    repo: { url: "https://github.com/example/repo", ref: "main" },
    gitPush: { secretRef: "git-push-token" },
    model: { id: "moonshotai/Kimi-K3", secretRef: "model-key" },
    task: { message: "do the thing", declaredEvidence: ["focused tests"], budgetSeconds: 900, permissionPosture: "advisory" },
    mcp: { manifest: ["workflow-guard-mcp"], corpusFingerprint: "sha256:abc" },
    artifacts: { evidenceContainer: "workflow-evidence", blobPrefix: "runs/task-123" },
    ...overrides,
  };
}

test("azure-jobs-dispatch: env classification is fail-closed and names missing/invalid vars", () => {
  // Not opted in → withheld (the ordinary off state).
  assert.deepEqual(azureJobsDispatchFromEnv({}), { kind: "unconfigured", missing: ["WORKFLOW_AZURE_JOBS"] });
  assert.deepEqual(azureJobsDispatchFromEnv({ WORKFLOW_AZURE_JOBS: "0" }), {
    kind: "unconfigured",
    missing: ["WORKFLOW_AZURE_JOBS"],
  });
  // Opted in but missing the required vars → named.
  const missing = azureJobsDispatchFromEnv({ WORKFLOW_AZURE_JOBS: "1" });
  assert.equal(missing.kind, "unconfigured");
  assert.deepEqual(missing.missing, [
    "WORKFLOW_AZURE_QUEUE_URL",
    "WORKFLOW_AZURE_EVIDENCE_CONTAINER",
  ]);
  // A malformed queue URL is named invalid, never coerced.
  const malformed = azureJobsDispatchFromEnv({
    WORKFLOW_AZURE_JOBS: "1",
    WORKFLOW_AZURE_QUEUE_URL: "https://wfdemo.queue.core.windows.net/a/b",
    WORKFLOW_AZURE_EVIDENCE_CONTAINER: "workflow-evidence",
  });
  assert.equal(malformed.kind, "unconfigured");
  assert.match(malformed.missing.join(","), /WORKFLOW_AZURE_QUEUE_URL \(invalid/);
  // A valid declaration classifies configured and derives the account blob URL.
  const configured = azureJobsDispatchFromEnv({
    WORKFLOW_AZURE_JOBS: "1",
    WORKFLOW_AZURE_QUEUE_URL: QUEUE_URL,
    WORKFLOW_AZURE_EVIDENCE_CONTAINER: "workflow-evidence",
  });
  assert.deepEqual(configured, {
    kind: "configured",
    queueUrl: QUEUE_URL,
    accountUrl: "https://wfdemo.blob.core.windows.net",
    evidenceContainer: "workflow-evidence",
  });
});

test("azure-jobs-dispatch: enqueue validates before any wire call, then POSTs the QueueMessage XML", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const dispatch = createAzureJobsDispatch({
    queueUrl: QUEUE_URL,
    accountUrl: "https://wfdemo.blob.core.windows.net",
    evidenceContainer: "workflow-evidence",
    getToken: async () => "test-token",
    fetcher: async (url, init) => {
      calls.push(init === undefined ? { url } : { url, init });
      return new Response(
        "<QueueMessagesList><QueueMessage><MessageId>mid-1</MessageId></QueueMessage></QueueMessagesList>",
        { status: 201 },
      );
    },
  });

  // A malformed message never reaches the wire.
  await assert.rejects(dispatch.enqueue({ specVersion: 1 }), /invalid azure job message/);
  assert.equal(calls.length, 0, "no wire call for a malformed message");

  const result = await dispatch.enqueue(validMessage());
  assert.deepEqual(result, { taskId: "task-123", messageId: "mid-1", viaBlobRef: false });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, `${QUEUE_URL}/messages`);
  assert.equal(call.init?.method, "POST");
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-token");
  assert.equal(headers["x-ms-version"], AZURE_STORAGE_API_VERSION);
  assert.match(headers["x-ms-date"] ?? "", /GMT$/);
  assert.equal(headers["Content-Type"], "application/xml");
  // The body is the base64 QueueMessage XML wrapping the canonical JSON.
  const expectedBase64 = Buffer.from(serializeAzureJobMessage(validateAzureJobMessage(validMessage())), "utf8").toString("base64");
  assert.equal(
    String(call.init?.body),
    `<?xml version="1.0" encoding="utf-8"?><QueueMessage><MessageText>${expectedBase64}</MessageText></QueueMessage>`,
  );
});

test("azure-jobs-dispatch: an oversized message rides a blob PUT plus a small ref envelope", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const dispatch = createAzureJobsDispatch({
    queueUrl: QUEUE_URL,
    accountUrl: "https://wfdemo.blob.core.windows.net",
    evidenceContainer: "workflow-evidence",
    getToken: async () => "test-token",
    fetcher: async (url, init) => {
      calls.push(init === undefined ? { url } : { url, init });
      if (init?.method === "PUT") return new Response(null, { status: 201 });
      return new Response("<QueueMessage><MessageId>mid-2</MessageId></QueueMessage>", { status: 201 });
    },
  });

  const big = validMessage();
  (big.task as Record<string, unknown>).message = "x".repeat(QUEUE_BODY_LIMIT_BYTES + 1);
  const result = await dispatch.enqueue(big);
  assert.equal(result.viaBlobRef, true);
  const put = calls.find((call) => call.init?.method === "PUT");
  assert.ok(put, "an oversized body uploads to blob");
  // The declared blobPrefix is honored: <blobPrefix>/<taskId>.json.
  assert.equal(put.url, "https://wfdemo.blob.core.windows.net/workflow-evidence/runs/task-123/task-123.json");
  assert.equal((put.init?.headers as Record<string, string>)["x-ms-blob-type"], "BlockBlob");
  const post = calls.find((call) => call.init?.method === "POST");
  assert.ok(post, "the ref envelope is enqueued");
  const body = String(post.init?.body);
  const base64 = /<MessageText>([^<]+)<\/MessageText>/.exec(body)?.[1];
  assert.ok(base64, "the envelope rides MessageText");
  const envelope = JSON.parse(Buffer.from(base64!, "base64").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(envelope, {
    specVersion: 1,
    taskId: "task-123",
    bodyRef: { container: "workflow-evidence", blob: "runs/task-123/task-123.json" },
  });
});

test("azure-jobs-dispatch: the inline path stays under Azure's 64 KiB wire limit at the size boundary", async () => {
  // The limit applies to the base64 MessageText, not the raw JSON: a raw
  // payload at the threshold must still produce an encoded body < 64 KiB.
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const dispatch = createAzureJobsDispatch({
    queueUrl: QUEUE_URL,
    accountUrl: "https://wfdemo.blob.core.windows.net",
    evidenceContainer: "workflow-evidence",
    getToken: async () => "test-token",
    fetcher: async (url, init) => {
      calls.push(init === undefined ? { url } : { url, init });
      return new Response("<QueueMessage><MessageId>mid</MessageId></QueueMessage>", { status: 201 });
    },
  });
  const message = validMessage();
  const base = Buffer.byteLength(JSON.stringify(validateAzureJobMessage(message)), "utf8");
  (message.task as Record<string, unknown>).message = "x".repeat(QUEUE_BODY_LIMIT_BYTES - base - 1);
  const result = await dispatch.enqueue(message);
  assert.equal(result.viaBlobRef, false, "a message just under the threshold rides inline");
  const post = calls.find((call) => call.init?.method === "POST");
  assert.ok(post, "the inline message is enqueued");
  const body = String(post.init?.body);
  assert.ok(body.length <= 65_536, `the XML body must stay under Azure's 64 KiB wire limit (was ${body.length})`);
});

test("azure-jobs-dispatch: a message cannot redirect the blob write to another container", async () => {
  const dispatch = createAzureJobsDispatch({
    queueUrl: QUEUE_URL,
    accountUrl: "https://wfdemo.blob.core.windows.net",
    evidenceContainer: "workflow-evidence",
    getToken: async () => "test-token",
    fetcher: async () => new Response("<QueueMessage><MessageId>mid</MessageId></QueueMessage>", { status: 201 }),
  });
  const elsewhere = validMessage();
  (elsewhere.artifacts as Record<string, unknown>).evidenceContainer = "someone-elses-container";
  await assert.rejects(dispatch.enqueue(elsewhere), /does not match the configured WORKFLOW_AZURE_EVIDENCE_CONTAINER/);
});

test("azure-jobs-dispatch: a queue fault throws (never a silent drop)", async () => {
  const dispatch = createAzureJobsDispatch({
    queueUrl: QUEUE_URL,
    accountUrl: "https://wfdemo.blob.core.windows.net",
    evidenceContainer: "workflow-evidence",
    getToken: async () => "test-token",
    fetcher: async () => new Response("denied", { status: 403 }),
  });
  await assert.rejects(dispatch.enqueue(validMessage()), /the queue answered 403/);
});

test("azure-jobs-dispatch: a transport failure is a TypeError (distinct from a message fault)", async () => {
  // A real Node fetch transport failure IS a TypeError. The dispatch client
  // must let it propagate unchanged AND it must NOT be an AzureJobMessageError,
  // so the hub route classifies it as a server fault, not a 400.
  const dispatch = createAzureJobsDispatch({
    queueUrl: QUEUE_URL,
    accountUrl: "https://wfdemo.blob.core.windows.net",
    evidenceContainer: "workflow-evidence",
    getToken: async () => "test-token",
    fetcher: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    dispatch.enqueue(validMessage()),
    (error: unknown) => error instanceof TypeError && !(error instanceof AzureJobMessageError),
  );
});
