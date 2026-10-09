import assert from "node:assert/strict";
import test from "node:test";

import {
  azureJobsDispatchFromEnv,
  createAzureJobsDispatch,
} from "../src/integrations/azure-jobs-dispatch.js";
import {
  createAzureJobsIngest,
  createDispatchRecordRegistry,
  createRecordingEnqueue,
  type DispatchValidationOutcome,
} from "../src/integrations/azure-jobs-record.js";
import { AZURE_JOB_SPEC_VERSION, validateAzureJobMessage } from "../src/integrations/azure-jobs-schema.js";

/**
 * P0 end-to-end probe (deploy plan §4 task 6) — the acceptance instrument for
 * the Azure Container Apps job fleet.
 *
 * Gated: `WORKFLOW_AZURE_JOBS_PROBE=1`. Skips honestly without the gate (the
 * repo's gated-probe convention; never in the default `test:ci`). Registered
 * in `docs/PROBE_VERDICTS.json`; `pending` until the first live run.
 *
 * The probe drives the REAL production seam against live Azure — it composes
 * the same `createAzureJobsDispatch` + `createRecordingEnqueue` +
 * `createAzureJobsIngest` the hub does, rather than a parallel re-implementation,
 * so a green measures the deployed protocol end to end:
 *
 *   one message enqueued -> a job pod pulls it -> stock `opencode run` ->
 *   branch + PR + evidence blob -> the hub's validateDispatch reads the blob
 *   back and finds the declared evidence covered under the dispatched corpus.
 *
 * Required environment when the gate is set (a missing value fails the probe,
 * never a silent skip):
 *   WORKFLOW_AZURE_JOBS=1                          (the capability opt-in)
 *   WORKFLOW_AZURE_QUEUE_URL                       https://<acct>.queue.core.windows.net/<queue>
 *   WORKFLOW_AZURE_EVIDENCE_CONTAINER              the declared evidence container
 *   WORKFLOW_AZURE_ACCOUNT_URL                     https://<acct>.blob.core.windows.net
 *   WORKFLOW_AZURE_PROBE_REPO_URL                  an https throwaway clone URL
 *   WORKFLOW_AZURE_PROBE_REPO_REF                  the base ref the PR targets
 *   WORKFLOW_AZURE_PROBE_GIT_SECRET_REF            Key Vault ref NAME for the push credential
 *   WORKFLOW_AZURE_PROBE_MODEL_ID                  the model id the run uses
 *   WORKFLOW_AZURE_PROBE_MODEL_SECRET_REF          Key Vault ref NAME for the model credential
 *   WORKFLOW_AZURE_PROBE_CORPUS_FINGERPRINT        the deployed worker image's corpus digest
 *
 * Optional:
 *   WORKFLOW_AZURE_PROBE_TASK_ID                   defaults to a timestamped id
 *   WORKFLOW_AZURE_PROBE_BUDGET_SECONDS            defaults to 600
 *   WORKFLOW_AZURE_PROBE_TIMEOUT_SECONDS           poll bound, defaults to 1500
 *
 * Honesty: this is the P0 e2e; it earns the P-track **Partial** status, not an
 * `enforced` label. Pods stay advisory until the P2 model-key probe (task 8).
 * The interception story is evidence + the human merge gate (spec §6:126-128).
 */

const runJobsProbe = process.env.WORKFLOW_AZURE_JOBS_PROBE === "1";

interface JobsProbeConfig {
  readonly queueUrl: string;
  readonly accountUrl: string;
  readonly evidenceContainer: string;
  readonly repoUrl: string;
  readonly repoRef: string;
  readonly gitSecretRef: string;
  readonly modelId: string;
  readonly modelSecretRef: string;
  readonly corpusFingerprint: string;
  readonly taskId: string;
  readonly budgetSeconds: number;
  readonly timeoutSeconds: number;
}

/** Resolves the live probe config, failing closed on any missing value. */
function resolveConfig(env: NodeJS.ProcessEnv): JobsProbeConfig {
  const dispatch = azureJobsDispatchFromEnv(env);
  if (dispatch.kind !== "configured") {
    throw new Error(`WORKFLOW_AZURE_JOBS probe: dispatch capability not configured (${dispatch.missing.join(", ")})`);
  }
  const require = (name: string): string => {
    const value = env[name]?.trim();
    if (value === undefined || value === "") throw new Error(`WORKFLOW_AZURE_JOBS probe: ${name} is required`);
    return value;
  };
  const budget = Number.parseInt(env.WORKFLOW_AZURE_PROBE_BUDGET_SECONDS ?? "600", 10);
  const timeout = Number.parseInt(env.WORKFLOW_AZURE_PROBE_TIMEOUT_SECONDS ?? "1500", 10);
  return {
    queueUrl: dispatch.queueUrl,
    accountUrl: dispatch.accountUrl,
    evidenceContainer: dispatch.evidenceContainer,
    repoUrl: require("WORKFLOW_AZURE_PROBE_REPO_URL"),
    repoRef: require("WORKFLOW_AZURE_PROBE_REPO_REF"),
    gitSecretRef: require("WORKFLOW_AZURE_PROBE_GIT_SECRET_REF"),
    modelId: require("WORKFLOW_AZURE_PROBE_MODEL_ID"),
    modelSecretRef: require("WORKFLOW_AZURE_PROBE_MODEL_SECRET_REF"),
    corpusFingerprint: require("WORKFLOW_AZURE_PROBE_CORPUS_FINGERPRINT"),
    taskId: env.WORKFLOW_AZURE_PROBE_TASK_ID?.trim() || `probe-${Date.now()}`,
    budgetSeconds: Number.isInteger(budget) && budget > 0 ? budget : 600,
    timeoutSeconds: Number.isInteger(timeout) && timeout > 0 ? timeout : 1500,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("P0 jobs probe: a dispatch round-trips to a covered evidence blob (queue -> pod -> run -> PR + blob)", { skip: !runJobsProbe, timeout: 1_800_000 }, async () => {
  const config = resolveConfig(process.env);
  const registry = createDispatchRecordRegistry();
  const dispatch = createAzureJobsDispatch({
    queueUrl: config.queueUrl,
    accountUrl: config.accountUrl,
    evidenceContainer: config.evidenceContainer,
  });
  // The probe exercises the SAME recording wrapper the hub composes, so the
  // registry the ingest reads is populated exactly as production would.
  const enqueue = createRecordingEnqueue({
    registry,
    enqueue: dispatch.enqueue,
    validate: validateAzureJobMessage,
  });
  const validate = createAzureJobsIngest({ registry, accountUrl: config.accountUrl });

  const message = {
    specVersion: AZURE_JOB_SPEC_VERSION,
    taskId: config.taskId,
    repo: { url: config.repoUrl, ref: config.repoRef },
    gitPush: { secretRef: config.gitSecretRef },
    model: { id: config.modelId, secretRef: config.modelSecretRef },
    task: {
      message: "Report the repository's current HEAD commit hash in one line, then stop.",
      declaredEvidence: ["head-commit-reported"],
      budgetSeconds: config.budgetSeconds,
      permissionPosture: "advisory" as const,
    },
    mcp: { manifest: [], corpusFingerprint: config.corpusFingerprint },
    artifacts: { evidenceContainer: config.evidenceContainer, blobPrefix: "probe" },
  };

  const result = await enqueue(message);
  assert.equal(result.taskId, config.taskId);
  assert.ok(result.messageId.length > 0, "the queue must return a message id");

  // Poll the hub-side return leg until the worker's evidence blob lands and the
  // ingest reaches a terminal verdict, or the bound elapses.
  const terminal = new Set<DispatchValidationOutcome["status"]>(["covered", "failed", "stale-corpus", "invalid", "incomplete"]);
  const deadline = Date.now() + config.timeoutSeconds * 1_000;
  let outcome: DispatchValidationOutcome = { taskId: config.taskId, status: "missing" };
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    outcome = await validate(config.taskId);
    seen.add(outcome.status);
    if (terminal.has(outcome.status)) break;
    await sleep(15_000);
  }

  assert.equal(
    outcome.status,
    "covered",
    `the dispatched job must return a covered evidence blob (last verdict '${outcome.status}': ${outcome.reason ?? ""}; observed ${[...seen].join(", ")})`,
  );
  // The evidence must cite the dispatched corpus: ingest already enforces
  // corpus-fingerprint equality for `covered`, so a covered verdict IS the
  // corpus-fingerprint claim. Assert it explicitly so the probe names the fact.
  assert.equal(outcome.exitCode, 0, "a covered run has a zero exit code");
  // The PR carries the taskId: the worker publishes branch `workflow/<taskId>`,
  // so a covered verdict with a PR must name that branch.
  if (outcome.prUrl !== undefined) {
    assert.equal(outcome.branch, `workflow/${config.taskId}`, "the PR branch must carry the dispatched taskId");
    assert.match(outcome.prUrl, /^https:\/\//, "the PR URL must be a real link");
  }
});

test("P0 jobs probe: an unknown taskId validates as unknown (the hub-held denominator)", { skip: !runJobsProbe, timeout: 60_000 }, async () => {
  const config = resolveConfig(process.env);
  // An id the hub never dispatched must NOT self-satisfy: the registry is the
  // denominator, so an unknown id is `unknown`, never a fabricated pass.
  const registry = createDispatchRecordRegistry();
  const validate = createAzureJobsIngest({ registry, accountUrl: config.accountUrl });
  const outcome = await validate(`never-dispatched-${Date.now()}`);
  assert.equal(outcome.status, "unknown");
});
