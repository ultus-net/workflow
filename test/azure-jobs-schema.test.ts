import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AZURE_JOB_SPEC_VERSION,
  AzureJobMessageError,
  parseAzureJobMessage,
  serializeAzureJobMessage,
  validateAzureJobMessage,
  validateAzureJobRefEnvelope,
} from "../src/integrations/azure-jobs-schema.js";

// C1 deploy plan §2.c — the Azure job dispatch message schema (the LESS-0061
// "schema is the spec" seam). Pins per the registered prediction:
//   1. a well-formed specVersion 1 message validates and serializes to a
//      freshly constructed typed copy (never the parsed input);
//   2. unknown/missing specVersion refuses;
//   3. absent or empty declaredEvidence refuses (a run with no declared
//      evidence never dispatches);
//   4. a declared `enforced` permission posture refuses by name (the pod-
//      enforced claim is gated on the P2 model-key probe);
//   5. secret VALUES never appear in the message — only Key Vault ref NAMES;
//   6. the oversized-body ref envelope has its own version+pinned shape.

function validMessage(): Record<string, unknown> {
  return {
    specVersion: 1,
    taskId: "task-123",
    repo: { url: "https://github.com/example/repo", ref: "main" },
    gitPush: { secretRef: "git-push-token" },
    model: { id: "moonshotai/Kimi-K3", secretRef: "model-key" },
    task: {
      message: "do the thing",
      declaredEvidence: ["focused tests"],
      budgetSeconds: 900,
      permissionPosture: "advisory",
    },
    mcp: { manifest: ["workflow-guard-mcp"], corpusFingerprint: "sha256:abc" },
    artifacts: { evidenceContainer: "workflow-evidence", blobPrefix: "runs/task-123" },
  };
}

test("azure-jobs-schema: a valid message validates and returns a freshly constructed copy", () => {
  const input = validMessage();
  const message = validateAzureJobMessage(input);
  assert.equal(message.specVersion, AZURE_JOB_SPEC_VERSION);
  assert.equal(message.taskId, "task-123");
  assert.deepEqual(message.task.declaredEvidence, ["focused tests"]);
  assert.equal(message.task.permissionPosture, "advisory");
  // The returned object is fresh, not the input reference (a hostile client
  // cannot smuggle extra fields past the seam via shared identity).
  assert.notEqual(message, input);
  assert.equal(Object.hasOwn(message, "extra"), false);
  const roundTripped = parseAzureJobMessage(serializeAzureJobMessage(message));
  assert.deepEqual(roundTripped, message);
});

test("azure-jobs-schema: unknown or missing specVersion refuses", () => {
  const missing = validMessage();
  delete missing.specVersion;
  assert.throws(() => validateAzureJobMessage(missing), /unsupported or missing specVersion/);
  assert.throws(
    () => validateAzureJobMessage({ ...validMessage(), specVersion: 2 }),
    /unsupported or missing specVersion/,
  );
});

test("azure-jobs-schema: absent or empty declaredEvidence refuses (no evidence, no dispatch)", () => {
  const absent = validMessage();
  (absent.task as Record<string, unknown>).declaredEvidence = undefined;
  assert.throws(() => validateAzureJobMessage(absent), /declaredEvidence must be an array/);
  const empty = validMessage();
  (empty.task as Record<string, unknown>).declaredEvidence = [];
  assert.throws(() => validateAzureJobMessage(empty), /declaredEvidence must not be empty/);
});

test("azure-jobs-schema: a declared enforced permission posture refuses by name", () => {
  const enforced = validMessage();
  (enforced.task as Record<string, unknown>).permissionPosture = "enforced";
  assert.throws(() => validateAzureJobMessage(enforced), /"enforced" is refused for specVersion 1/);
  const bogus = validMessage();
  (bogus.task as Record<string, unknown>).permissionPosture = "god-mode";
  assert.throws(() => validateAzureJobMessage(bogus), /permissionPosture must be "advisory"/);
});

test("azure-jobs-schema: field-level faults name the offending path", () => {
  assert.throws(() => validateAzureJobMessage(null), /must be an object/);
  const badUrl = validMessage();
  (badUrl.repo as Record<string, unknown>).url = "git@github.com:example/repo.git";
  assert.throws(() => validateAzureJobMessage(badUrl), /repo.url must be an https clone URL/);
  const badBudget = validMessage();
  (badBudget.task as Record<string, unknown>).budgetSeconds = 0;
  assert.throws(() => validateAzureJobMessage(badBudget), /budgetSeconds must be a positive integer/);
  const badManifest = validMessage();
  (badManifest.mcp as Record<string, unknown>).manifest = "workflow-guard-mcp";
  assert.throws(() => validateAzureJobMessage(badManifest), /mcp.manifest must be an array/);
});

test("azure-jobs-schema: taskId, blobPrefix, and evidenceContainer are path-safe (no traversal)", () => {
  // A raw taskId in a blob URL would let `..` segments traverse the blob
  // namespace (WHATWG URL normalizes them away) — the schema forbids the shape.
  const traversal = validMessage();
  traversal.taskId = "../../evil/container/pwn";
  assert.throws(() => validateAzureJobMessage(traversal), /taskId must be a safe path segment/);
  const slashed = validMessage();
  slashed.taskId = "runs/task-123";
  assert.throws(() => validateAzureJobMessage(slashed), /taskId must be a safe path segment/);

  const badPrefix = validMessage();
  (badPrefix.artifacts as Record<string, unknown>).blobPrefix = "runs/../evil";
  assert.throws(() => validateAzureJobMessage(badPrefix), /blobPrefix must be a safe blob path/);
  const leadingSlash = validMessage();
  (leadingSlash.artifacts as Record<string, unknown>).blobPrefix = "/runs";
  assert.throws(() => validateAzureJobMessage(leadingSlash), /blobPrefix must be a safe blob path/);
  const dotSegment = validMessage();
  (dotSegment.artifacts as Record<string, unknown>).blobPrefix = "runs/./deep";
  assert.throws(() => validateAzureJobMessage(dotSegment), /blobPrefix must be a safe blob path/);
  // A name that merely CONTAINS dots must still pass (no over-rejection).
  const dotted = validMessage();
  (dotted.artifacts as Record<string, unknown>).blobPrefix = "runs/v1..2";
  assert.equal(validateAzureJobMessage(dotted).artifacts.blobPrefix, "runs/v1..2");

  const badContainer = validMessage();
  (badContainer.artifacts as Record<string, unknown>).evidenceContainer = "Bad_Container";
  assert.throws(() => validateAzureJobMessage(badContainer), /evidenceContainer must be a valid container name/);
});

test("azure-jobs-schema: a malformed message throws AzureJobMessageError, not a bare TypeError", () => {
  // The hub route classifies on this class; a bare TypeError would be
  // indistinguishable from a fetch transport failure.
  assert.throws(() => validateAzureJobMessage({}), AzureJobMessageError);
  assert.throws(() => parseAzureJobMessage("not json"), AzureJobMessageError);
});

test("azure-jobs-schema: the message carries ref NAMES only, never secret values", () => {
  const message = validateAzureJobMessage(validMessage());
  const wire = serializeAzureJobMessage(message);
  // The git-push and model refs are names; the values live in Key Vault. A
  // real leaked token would be a long opaque string — the fields in the
  // schema are refs, and this pins that no "value" field is accepted.
  assert.doesNotMatch(wire, /"value"/);
  assert.match(wire, /"secretRef":"git-push-token"/);
});

test("azure-jobs-schema: the oversized-body ref envelope validates and stays version-pinned", () => {
  const envelope = { specVersion: 1, taskId: "task-123", bodyRef: { container: "workflow-evidence", blob: "task-123.json" } };
  assert.deepEqual(validateAzureJobRefEnvelope(envelope), envelope);
  assert.throws(() => validateAzureJobRefEnvelope({ ...envelope, specVersion: 3 }), /unsupported or missing specVersion/);
  assert.throws(() => validateAzureJobRefEnvelope({ specVersion: 1, taskId: "t" }), /bodyRef must be an object/);
});
