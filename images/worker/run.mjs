#!/usr/bin/env node
// The Shape-A worker entry (C1 deploy plan §2.d; spec §3:71-91). ONE queue
// message = ONE execution = ONE bounded agent run.
//
// Design constraints this file honors:
//   - Zero dependencies, REST-only (no Azure SDK). It re-implements the exact
//     wire shapes the hub-side dispatch client already speaks (Storage Queue
//     REST with an Entra ID Bearer, IMDS-first token chain) so the pod and the
//     hub share one protocol without a shared package.
//   - It RE-VALIDATES the message structurally before any work. The validator
//     is a faithful copy of the pure contract in
//     `src/integrations/azure-jobs-schema.ts` (specVersion 1). A copy is the
//     honest choice: the runtime image is built from a Dockerfile, not `npm ci`
//     of the repo, so importing the TypeScript module would drag a build step
//     (and the whole product tree) into a pod whose spec footprint is "zero".
//     The mirror is pinned by `test/worker-image.test.ts` so it cannot drift.
//   - Fail-closed everywhere: a malformed/expired message, a corpus mismatch, a
//     missing secret ref, a missing config value, or a budget overrun all exit
//     non-zero (KEDA's max-retries then handles the poison message). It never
//     degrades to running unverified or unbounded.
//   - Secrets are materialized in memory and passed ONLY through the child
//     process's environment for the single variable opencode needs. They are
//     never written to disk and never all logged (the ref NAME is logged, the
//     value is not).

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SPEC_VERSION = 1;
// The runtime location the image writes the build-time corpus digest to. Kept
// in sync with the Dockerfile (`RUN ... run.mjs --write-fingerprint ...`).
const FINGERPRINT_FILE = process.env.WORKFLOW_WORKER_FINGERPRINT_FILE ?? "/opt/workflow/corpus-fingerprint";
// The toolbox is built at the image WORKDIR (`/app`) by the Dockerfile, so the
// corpus lives there at build and run time.
const CORPUS_APPS_ROOT = process.env.WORKFLOW_WORKER_CORPUS_ROOT ?? "/app/mcp-toolbox/apps";

// ── 1. The message contract (mirror of azure-jobs-schema.ts) ────────────────

class WorkerMessageError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerMessageError";
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATH_SEGMENTS = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function hasDotSegment(path) {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkerMessageError(`invalid azure job message: ${path} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value, path, { allowEmpty }) {
  if (!Array.isArray(value)) throw new WorkerMessageError(`invalid azure job message: ${path} must be an array`);
  const out = [];
  for (let i = 0; i < value.length; i += 1) out.push(requireString(value[i], `${path}[${i}]`));
  if (!allowEmpty && out.length === 0) {
    throw new WorkerMessageError(`invalid azure job message: ${path} must not be empty (a run declares its expected evidence)`);
  }
  return out;
}

/** Structurally validates a dispatch message; returns a fresh typed copy. */
export function validateAzureJobMessage(value) {
  if (!isRecord(value)) throw new WorkerMessageError("invalid azure job message: the message must be an object");
  if (value.specVersion !== SPEC_VERSION) {
    throw new WorkerMessageError(`invalid azure job message: unsupported or missing specVersion (expected ${SPEC_VERSION})`);
  }
  const taskId = requireString(value.taskId, "taskId");
  if (!SAFE_SEGMENT.test(taskId)) {
    throw new WorkerMessageError("invalid azure job message: taskId must be a safe path segment (alphanumerics, dot, underscore, dash)");
  }
  if (!isRecord(value.repo)) throw new WorkerMessageError("invalid azure job message: repo must be an object");
  const repoUrl = requireString(value.repo.url, "repo.url");
  if (!/^https:\/\/[^\s]+$/.test(repoUrl)) {
    throw new WorkerMessageError("invalid azure job message: repo.url must be an https clone URL");
  }
  const repo = { url: repoUrl, ref: requireString(value.repo.ref, "repo.ref") };
  if (!isRecord(value.gitPush)) throw new WorkerMessageError("invalid azure job message: gitPush must be an object");
  const gitPush = { secretRef: requireString(value.gitPush.secretRef, "gitPush.secretRef") };
  if (!isRecord(value.model)) throw new WorkerMessageError("invalid azure job message: model must be an object");
  const model = {
    id: requireString(value.model.id, "model.id"),
    secretRef: requireString(value.model.secretRef, "model.secretRef"),
  };
  if (!isRecord(value.task)) throw new WorkerMessageError("invalid azure job message: task must be an object");
  const message = requireString(value.task.message, "task.message");
  const declaredEvidence = requireStringArray(value.task.declaredEvidence, "task.declaredEvidence", { allowEmpty: false });
  const budgetSeconds = value.task.budgetSeconds;
  if (typeof budgetSeconds !== "number" || !Number.isInteger(budgetSeconds) || budgetSeconds <= 0) {
    throw new WorkerMessageError("invalid azure job message: task.budgetSeconds must be a positive integer");
  }
  const declaredPosture = value.task.permissionPosture;
  if (declaredPosture === "enforced") {
    throw new WorkerMessageError(
      'invalid azure job message: task.permissionPosture "enforced" is refused for specVersion 1 ' +
        "(the pod-enforced claim is gated on the P2 model-key probe; plan task 8)",
    );
  }
  if (declaredPosture !== "advisory") {
    throw new WorkerMessageError('invalid azure job message: task.permissionPosture must be "advisory"');
  }
  const task = { message, declaredEvidence, budgetSeconds, permissionPosture: "advisory" };
  if (!isRecord(value.mcp)) throw new WorkerMessageError("invalid azure job message: mcp must be an object");
  const mcp = {
    manifest: requireStringArray(value.mcp.manifest, "mcp.manifest", { allowEmpty: true }),
    corpusFingerprint: requireString(value.mcp.corpusFingerprint, "mcp.corpusFingerprint"),
  };
  if (!isRecord(value.artifacts)) throw new WorkerMessageError("invalid azure job message: artifacts must be an object");
  const evidenceContainer = requireString(value.artifacts.evidenceContainer, "artifacts.evidenceContainer");
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(evidenceContainer)) {
    throw new WorkerMessageError("invalid azure job message: artifacts.evidenceContainer must be a valid container name");
  }
  const blobPrefix = requireString(value.artifacts.blobPrefix, "artifacts.blobPrefix");
  if (!SAFE_PATH_SEGMENTS.test(blobPrefix) || hasDotSegment(blobPrefix)) {
    throw new WorkerMessageError(
      'invalid azure job message: artifacts.blobPrefix must be a safe blob path (no leading/trailing slash, no "."/".." segments)',
    );
  }
  return { specVersion: SPEC_VERSION, taskId, repo, gitPush, model, task, mcp, artifacts: { evidenceContainer, blobPrefix } };
}

/** Distinguishes the small blob-ref envelope from a full message. */
export function isRefEnvelope(value) {
  return isRecord(value) && isRecord(value.bodyRef);
}

/** Structurally validates a blob-ref envelope; returns a fresh typed copy. */
export function validateRefEnvelope(value) {
  if (!isRecord(value)) throw new WorkerMessageError("invalid azure job envelope: the envelope must be an object");
  if (value.specVersion !== SPEC_VERSION) {
    throw new WorkerMessageError(`invalid azure job envelope: unsupported or missing specVersion (expected ${SPEC_VERSION})`);
  }
  if (!isRecord(value.bodyRef)) throw new WorkerMessageError("invalid azure job envelope: bodyRef must be an object");
  return {
    specVersion: SPEC_VERSION,
    taskId: requireString(value.taskId, "taskId"),
    bodyRef: {
      container: requireString(value.bodyRef.container, "bodyRef.container"),
      blob: requireString(value.bodyRef.blob, "bodyRef.blob"),
    },
  };
}

// ── 2. The corpus fingerprint (mirror of the Dockerfile's build-time call) ──

function collectJsFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

/**
 * Digest of the toolbox corpus under `appsRoot`. Deterministic and identical
 * at build time and run time: only `.js` files, POSIX-relative paths sorted by
 * byte order, each contributing `"<relpath>\0<sha256(content)>\n"`. A missing
 * or empty corpus throws (a missing corpus must never "match").
 */
export function fingerprintCorpus(appsRoot) {
  const root = resolve(appsRoot);
  if (!existsSync(root)) throw new Error(`corpus fingerprint: apps root does not exist: ${root}`);
  const files = collectJsFiles(root, []);
  if (files.length === 0) throw new Error(`corpus fingerprint: no built .js corpus under ${root} (build the toolbox first)`);
  const entries = files
    .map((abs) => ({
      rel: abs.slice(root.length + 1).split(sep).join("/"),
      hash: createHash("sha256").update(readFileSync(abs)).digest("hex"),
    }))
    .sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
  const digest = createHash("sha256");
  for (const { rel, hash } of entries) digest.update(`${rel}\0${hash}\n`);
  return { fingerprint: digest.digest("hex"), fileCount: entries.length };
}

/** Reads the build-time fingerprint file; throws if it is absent or malformed. */
export function readRecordedFingerprint(path) {
  if (!existsSync(path)) throw new Error(`corpus fingerprint: no recorded fingerprint at ${path}`);
  const recorded = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(recorded)) throw new Error(`corpus fingerprint: recorded value at ${path} is not a 64-hex digest`);
  return recorded;
}

/**
 * Verifies the pod's local corpus against the dispatch's declared fingerprint.
 * Returns the local digest on a match; throws on any mismatch or absence.
 * Fail-closed: a mismatch never degrades to a warning. `fingerprintFile`
 * defaults to the image's recorded path and is injectable for tests.
 */
export function verifyCorpus(corpusAppsRoot, declared, fingerprintFile = FINGERPRINT_FILE) {
  const local = fingerprintCorpus(corpusAppsRoot);
  const recorded = readRecordedFingerprint(fingerprintFile);
  if (recorded !== local.fingerprint) {
    throw new Error(
      `corpus fingerprint: the image's recorded digest ${recorded} does not match the live corpus ${local.fingerprint} (the image was tampered with or built inconsistently)`,
    );
  }
  if (declared !== local.fingerprint) {
    throw new Error(
      `corpus fingerprint: the dispatch declared ${declared} but this pod's verified corpus is ${local.fingerprint} (mismatch refused, fail-closed)`,
    );
  }
  return local;
}

// ── 3. Azure REST helpers (no SDK) ──────────────────────────────────────────

const STORAGE_SCOPE = "https://storage.azure.com/";
const STORAGE_API_VERSION = "2023-11-03";

/** IMDS-first, azure-cli-fallback token fetch, exactly as azure-token.ts does. */
export async function getAccessToken(scope, fetcher = fetch) {
  const imds = process.env.MSI_ENDPOINT ?? process.env.IDENTITY_ENDPOINT ?? "http://169.254.169.254/metadata/identity/oauth2/token";
  const imdsResponse = await fetcher(`${imds}?resource=${encodeURIComponent(scope)}&api-version=2018-02-01`, {
    headers: { Metadata: "true" },
  }).catch(() => undefined);
  if (imdsResponse?.ok) {
    const body = await imdsResponse.json();
    if (body.access_token) return body.access_token;
  }
  const az = await execFileAsync("az", ["account", "get-access-token", "--resource", scope, "--query", "accessToken", "-o", "tsv"]);
  const token = az.stdout.trim();
  if (!token) throw new Error("azure-cli returned no access token");
  return token;
}

function storageAuthHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, "x-ms-version": STORAGE_API_VERSION, "x-ms-date": new Date().toUTCString(), ...extra };
}

/**
 * Pulls ONE message from the queue with a visibility timeout, decoding the
 * base64 `<MessageText>` XML wrapper. Returns `{ raw, encoded, messageId,
 * popReceipt }` where `raw` is the UTF-8 JSON string and `encoded` is the
 * original base64 (needed to DELETE the message later, since Delete requires
 * the same popReceipt + the URL-encoded MessageText).
 */
export async function dequeue(queueUrl, token, visibilitySeconds, fetcher = fetch) {
  const url = `${queueUrl}/messages?visibilitytimeout=${visibilitySeconds}&numofmessages=1`;
  const response = await fetcher(url, { headers: storageAuthHeaders(token) });
  if (!response.ok) throw new Error(`azure worker: the queue answered ${response.status} on dequeue`);
  const xml = await response.text();
  const messageId = /<MessageId>([^<]*)<\/MessageId>/.exec(xml)?.[1];
  const popReceipt = /<PopReceipt>([^<]*)<\/PopReceipt>/.exec(xml)?.[1];
  const encoded = /<MessageText>([^<]*)<\/MessageText>/.exec(xml)?.[1];
  if (messageId === undefined || popReceipt === undefined || encoded === undefined) return undefined; // empty queue
  const raw = Buffer.from(encoded, "base64").toString("utf8");
  return { raw, encoded, messageId, popReceipt };
}

/** Deletes a message by its id + popReceipt (the completion signal). */
export async function deleteMessage(queueUrl, token, messageId, popReceipt, fetcher = fetch) {
  const url = `${queueUrl}/messages/${encodeURIComponent(messageId)}?popreceipt=${encodeURIComponent(popReceipt)}`;
  const response = await fetcher(url, { method: "DELETE", headers: storageAuthHeaders(token) });
  if (!response.ok) throw new Error(`azure worker: the queue answered ${response.status} on delete`);
}

/** Fetches a blob body as UTF-8 (the oversized-message lane). */
export async function readBlob(accountUrl, container, blobPath, token, fetcher = fetch) {
  const path = blobPath.split("/").map(encodeURIComponent).join("/");
  const url = `${accountUrl}/${encodeURIComponent(container)}/${path}`;
  const response = await fetcher(url, { headers: storageAuthHeaders(token) });
  if (!response.ok) throw new Error(`azure worker: the blob answered ${response.status} on read`);
  return await response.text();
}

/** Uploads a UTF-8 body as a block blob (the evidence lane). */
export async function putBlob(accountUrl, container, blobPath, body, token, fetcher = fetch) {
  const path = blobPath.split("/").map(encodeURIComponent).join("/");
  const url = `${accountUrl}/${encodeURIComponent(container)}/${path}`;
  const response = await fetcher(url, {
    method: "PUT",
    headers: storageAuthHeaders(token, { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/json" }),
    body,
  });
  if (!response.ok) throw new Error(`azure worker: the blob answered ${response.status} on upload`);
}

// ── 4. Key Vault secret materialization (in-memory, never on disk) ──────────

const KV_SCOPE = "https://vault.azure.net/";

/**
 * Reads one secret from Key Vault by its ref NAME and returns its VALUE. The
 * value lives only in the returned string (passed straight into the child's
 * env) — it is never written to disk and never logged.
 */
export async function readKeyVaultSecret(vaultName, secretRef, token, fetcher = fetch) {
  if (!/^[a-z0-9-]{3,24}$/.test(vaultName)) throw new Error(`azure worker: WORKFLOW_KEYVAULT_NAME is invalid: ${vaultName}`);
  const url = `https://${vaultName}.vault.azure.net/secrets/${encodeURIComponent(secretRef)}?api-version=7.4`;
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`azure worker: Key Vault answered ${response.status} for secretRef '${secretRef}'`);
  const body = await response.json();
  if (typeof body.value !== "string" || body.value.length === 0) {
    throw new Error(`azure worker: Key Vault secret '${secretRef}' carried no value`);
  }
  return body.value;
}

// ── 5. The run itself ───────────────────────────────────────────────────────

/**
 * Runs the stock `opencode run` headless against the checkout with a wall-clock
 * kill at `task.budgetSeconds`. Returns `{ stdout, stderr, exitCode }`; the
 * child is killed (SIGKILL) and an error thrown when the budget elapses.
 * `modelEnv` is the single provider env var the model key maps to (or `{}` when
 * the model declares no env mapping — a caller concern validated upstream).
 */
export async function runOpencode({ cwd, prompt, modelId, modelEnv, budgetSeconds, opencodeBin = "opencode" }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`azure worker: task budget of ${budgetSeconds}s exceeded`)), budgetSeconds * 1000);
  try {
    const result = await execFileAsync(opencodeBin, ["run", "--model", modelId, prompt], {
      cwd,
      env: { ...process.env, ...modelEnv },
      maxBuffer: 64 * 1024 * 1024,
      signal: controller.signal,
      killSignal: "SIGKILL",
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`azure worker: task budget of ${budgetSeconds}s exceeded (run killed)`, { cause: error });
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    return { stdout, stderr, exitCode: typeof error.code === "number" ? error.code : 1 };
  } finally {
    clearTimeout(timer);
  }
}

/** Clones `url`@`ref` into a fresh dir under `parent`, returning the checkout path. */
export async function cloneCheckout({ parent, url, ref }) {
  const dir = mkdtempSync(join(parent, "checkout-"));
  await execFileAsync("git", ["clone", "--no-checkout", url, dir]);
  await execFileAsync("git", ["-C", dir, "checkout", ref]);
  return dir;
}

/**
 * Builds an https clone URL carrying a token for private repos, preserving the
 * original host/path. Non-https URLs are returned unchanged (the schema already
 * requires an https repo.url, so this is defense in depth).
 */
export function authedCloneUrl(url, token) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") return url;
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
}

/**
 * Parses a GitHub https clone URL into `{ owner, repo }` and the API base.
 * Non-GitHub hosts return `undefined` (PR-open is GitHub-specific; push still
 * works). Accepts `https://github.com/<owner>/<repo>[.git]`.
 */
export function parseGithubRepo(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (match === null) return undefined;
  return { owner: match[1], repo: match[2], apiBase: "https://api.github.com" };
}

/**
 * Publishes the run's work: a branch + commit on the checkout, a push with the
 * materialized git credential, and (on GitHub) a PR. Returns the branch name and
 * the PR URL when one was opened. `token` is the git-push secret value; it is
 * injected into the push URL and never logged. Fail-closed: any git or API
 * non-success throws.
 */
export async function publishResult({ checkout, taskId, baseRef, repoUrl, gitToken, title, fetcher = fetch }) {
  const branch = `workflow/${taskId}`;
  const commitEnv = {
    GIT_AUTHOR_NAME: "workflow-worker",
    GIT_AUTHOR_EMAIL: "workflow-worker@users.noreply.github.com",
    GIT_COMMITTER_NAME: "workflow-worker",
    GIT_COMMITTER_EMAIL: "workflow-worker@users.noreply.github.com",
  };
  await execFileAsync("git", ["-C", checkout, "checkout", "-b", branch]);
  await execFileAsync("git", ["-C", checkout, "add", "-A"]);
  // `--allow-empty` keeps the contract honest: a run that changed nothing still
  // produces a reviewable branch rather than failing opaquely.
  await execFileAsync("git", ["-C", checkout, "commit", "--allow-empty", "-m", `workflow: ${taskId}`], { env: commitEnv });
  const repo = parseGithubRepo(repoUrl);
  const host = repo === undefined ? new URL(repoUrl).host : "github.com";
  const authedUrl = `https://x-access-token:${encodeURIComponent(gitToken)}@${host}${new URL(repoUrl).pathname}`;
  await execFileAsync("git", ["-C", checkout, "push", authedUrl, `${branch}:${branch}`]);
  if (repo === undefined) return { branch };
  const response = await fetcher(`${repo.apiBase}/repos/${repo.owner}/${repo.repo}/pulls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gitToken}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ title: title ?? `workflow: ${taskId}`, head: branch, base: baseRef }),
  });
  if (!response.ok) throw new Error(`azure worker: the PR API answered ${response.status}`);
  const body = await response.json();
  return { branch, prUrl: typeof body.html_url === "string" ? body.html_url : undefined };
}

/**
 * The end-to-end worker turn: verify corpus, resolve secrets, clone, run, and
 * upload evidence. Every phase is fail-closed. `now`/`fetcher`/`run` are
 * injectable for hermetic tests. Returns the evidence blob path on success.
 */
export async function runWorkerTurn({ message, config, deps = {} }) {
  const fetcher = deps.fetcher ?? fetch;
  const run = deps.run ?? runOpencode;
  const clone = deps.clone ?? cloneCheckout;
  const publish = deps.publish ?? publishResult;
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? ((line) => process.stderr.write(`azure worker: ${line}\n`));
  const corpusRoot = deps.corpusRoot ?? CORPUS_APPS_ROOT;
  const fingerprintFile = deps.fingerprintFile ?? FINGERPRINT_FILE;

  // 2. Verify the corpus BEFORE any work (spec §11:295-296).
  const corpus = verifyCorpus(corpusRoot, message.mcp.corpusFingerprint, fingerprintFile);
  log(`corpus verified (${corpus.fileCount} files, ${corpus.fingerprint})`);

  // 3. Materialize ONLY the named secrets, in memory.
  const storageToken = await getAccessToken(STORAGE_SCOPE, fetcher);
  const kvToken = await getAccessToken(KV_SCOPE, fetcher);
  const modelKey = await readKeyVaultSecret(config.vaultName, message.model.secretRef, kvToken, fetcher);
  log(`materialized secret ref '${message.model.secretRef}' (value not logged)`);
  const gitPushKey = await readKeyVaultSecret(config.vaultName, message.gitPush.secretRef, kvToken, fetcher);
  log(`materialized secret ref '${message.gitPush.secretRef}' (value not logged)`);
  // The model key is exposed to the child ONLY through the declared provider
  // env var; the git credential rides the clone + push URL (host/path preserved;
  // never logged — the log names the unauthenticated URL).
  const modelEnv = config.modelEnvVar ? { [config.modelEnvVar]: modelKey } : {};

  // 4. Clone a disposable checkout (authenticated URL for private repos).
  const workParent = mkdtempSync(join(tmpdir(), "workflow-worker-"));
  const checkout = await clone({
    parent: workParent,
    url: authedCloneUrl(message.repo.url, gitPushKey),
    ref: message.repo.ref,
  });
  log(`cloned ${message.repo.url}@${message.repo.ref}`);

  // 5. Run stock opencode headless with the wall-clock budget.
  const started = now();
  const result = await run({
    cwd: checkout,
    prompt: message.task.message,
    modelId: message.model.id,
    modelEnv,
    budgetSeconds: message.task.budgetSeconds,
  });
  log(`opencode run exited ${result.exitCode} (started ${started})`);

  // 6. On success, publish the work as a branch + PR; always upload the
  //    evidence blob (opencode output, usage-honest exit, corpus fingerprint,
  //    taskId). The hub validates declared evidence before state advances, so
  //    the blob carries everything the run observed — including failures.
  const published = result.exitCode === 0
    ? await publish({
        checkout,
        taskId: message.taskId,
        baseRef: message.repo.ref,
        repoUrl: message.repo.url,
        gitToken: gitPushKey,
        fetcher,
      })
    : undefined;
  if (published !== undefined) {
    log(`published branch ${published.branch}${published.prUrl ? ` (PR ${published.prUrl})` : ""}`);
  }

  const evidence = {
    specVersion: SPEC_VERSION,
    taskId: message.taskId,
    startedAt: started,
    finishedAt: now(),
    exitCode: result.exitCode,
    corpusFingerprint: corpus.fingerprint,
    declaredEvidence: message.task.declaredEvidence,
    model: { id: message.model.id },
    ...(published === undefined ? {} : { branch: published.branch, prUrl: published.prUrl }),
    stdout: result.stdout,
    stderr: result.stderr,
  };
  const blob = `${message.artifacts.blobPrefix}/${message.taskId}.json`;
  await putBlob(config.accountUrl, message.artifacts.evidenceContainer, blob, JSON.stringify(evidence), storageToken, fetcher);
  log(`evidence uploaded to ${message.artifacts.evidenceContainer}/${blob}`);

  if (result.exitCode !== 0) throw new Error(`azure worker: opencode run failed with exit code ${result.exitCode}`);
  return { blob, corpusFingerprint: corpus.fingerprint };
}

// ── 6. Config from env (fail-closed) + the CLI entry ────────────────────────

/**
 * Reads the pod's required config from env. A missing value is NAMED and
 * refused — never defaulted. `WORKFLOW_WORKER_MODEL_ENV_VAR` maps the model key
 * to the provider variable opencode reads (e.g. OPENROUTER_API_KEY); when set
 * it is used, and its NAME (never value) reaches the log.
 */
export function workerConfigFromEnv(env = process.env) {
  const missing = [];
  const queueUrl = (env.WORKFLOW_AZURE_QUEUE_URL ?? "").trim();
  if (queueUrl === "") missing.push("WORKFLOW_AZURE_QUEUE_URL");
  const vaultName = (env.WORKFLOW_KEYVAULT_NAME ?? "").trim();
  if (vaultName === "") missing.push("WORKFLOW_KEYVAULT_NAME");
  const accountUrl = (env.WORKFLOW_AZURE_ACCOUNT_URL ?? "").trim();
  if (accountUrl === "") missing.push("WORKFLOW_AZURE_ACCOUNT_URL");
  if (queueUrl !== "" && !/^https:\/\/[a-z0-9]{3,24}\.queue\.core\.windows\.net\/[A-Za-z0-9-]{3,63}$/.test(queueUrl)) {
    missing.push("WORKFLOW_AZURE_QUEUE_URL (invalid — expected https://<account>.queue.core.windows.net/<queue>)");
  }
  if (accountUrl !== "" && !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(accountUrl)) {
    missing.push("WORKFLOW_AZURE_ACCOUNT_URL (invalid — expected https://<account>.blob.core.windows.net)");
  }
  // The visibility timeout must stay UNDER the job's replicaTimeout so a
  // still-running message re-appears for retry; default 60s, operator-tunable.
  const visibility = Number.parseInt(env.WORKFLOW_AZURE_VISIBILITY_SECONDS ?? "60", 10);
  if (!Number.isInteger(visibility) || visibility <= 0) missing.push("WORKFLOW_AZURE_VISIBILITY_SECONDS (invalid — positive integer)");
  if (missing.length > 0) return { kind: "invalid", missing };
  return {
    kind: "configured",
    queueUrl,
    vaultName,
    accountUrl,
    visibilitySeconds: visibility,
    modelEnvVar: (env.WORKFLOW_WORKER_MODEL_ENV_VAR ?? "").trim() || undefined,
  };
}

/** The top-level entry: pull one message, run one turn, delete on success. */
export async function main(env = process.env, deps = {}) {
  const fetcher = deps.fetcher ?? fetch;
  const config = workerConfigFromEnv(env);
  if (config.kind === "invalid") {
    throw new Error(`azure worker: missing or invalid config: ${config.missing.join(", ")}`);
  }
  const token = await getAccessToken(STORAGE_SCOPE, fetcher);
  const pulled = await dequeue(config.queueUrl, token, config.visibilitySeconds, fetcher);
  if (pulled === undefined) {
    process.stderr.write("azure worker: no message in the queue; exiting 0\n");
    return;
  }
  let parsed = JSON.parse(pulled.raw);
  if (isRefEnvelope(parsed)) {
    const envelope = validateRefEnvelope(parsed);
    const accountUrl = config.accountUrl;
    const body = await readBlob(accountUrl, envelope.bodyRef.container, envelope.bodyRef.blob, token, fetcher);
    parsed = JSON.parse(body);
  }
  const message = validateAzureJobMessage(parsed);
  await runWorkerTurn({ message, config, deps });
  await deleteMessage(config.queueUrl, token, pulled.messageId, pulled.popReceipt, fetcher);
}

// ── 7. Build-time fingerprint write + CLI dispatch ──────────────────────────

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const mode = process.argv[2];
  if (mode === "--write-fingerprint") {
    const outPath = process.argv[3] ?? FINGERPRINT_FILE;
    const { fingerprint, fileCount } = fingerprintCorpus(CORPUS_APPS_ROOT);
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(outPath, `${fingerprint}\n`);
    process.stderr.write(`corpus fingerprint: wrote ${fingerprint} (${fileCount} files) to ${outPath}\n`);
  } else {
    main().catch((error) => {
      process.stderr.write(`azure worker: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  }
}
