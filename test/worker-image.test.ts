import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  validateAzureJobMessage as validateHubMessage,
  validateAzureJobRefEnvelope as validateHubEnvelope,
} from "../src/integrations/azure-jobs-schema.js";
import {
  fingerprintCorpus,
  gitAuthEnv,
  isRefEnvelope,
  main as workerMain,
  redactSecret,
  runWorkerTurn,
  validateAzureJobMessage as validateWorkerMessage,
  validateRefEnvelope as validateWorkerEnvelope,
  verifyCorpus,
  workerConfigFromEnv,
} from "../images/worker/run.mjs";

/**
 * Worker image pins (C1 deploy plan §2.d, task 5). The worker pod is the
 * remote execution boundary; a silent regression in these lines is a
 * deploy-path defect. The structural pins mirror the control-plane suite; the
 * behavioral pins prove the entry script's fail-closed posture hermetically
 * (no queue, no container: injected fetchers + fakes).
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dockerfile = readFileSync(join(repoRoot, "images", "worker", "Dockerfile"), "utf8");

function instructionLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.trim());
}

function scratchCorpus(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "wf-worker-corpus-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

test("worker Dockerfile: USER node with a pre-created node-owned state root (D6)", () => {
  const lines = instructionLines(dockerfile);
  assert.ok(lines.includes("USER node"), "the worker must run as the node user");
  assert.ok(
    lines.some((line) => /^RUN mkdir -p \/home\/node\/\.workflow\b/.test(line)),
    "the node user's state root must be pre-created",
  );
});

test("worker Dockerfile: the smoke-succeeds || branch is gone (every RUN must genuinely succeed)", () => {
  // The first draft chained `chown /workspace 2>/dev/null || chown /home/node`
  // so the RUN would exit 0 even if `/workspace` was absent. Every RUN must
  // succeed on its own; a success-swallowing fallback is a hidden defect.
  const lines = instructionLines(dockerfile);
  assert.ok(!lines.some((line) => /\|\|/.test(line)), "no RUN may swallow a failure with ||");
  assert.ok(!lines.some((line) => /2>\/dev\/null/.test(line)), "no RUN may discard stderr to hide a failure");
});

test("worker Dockerfile: the vendored opencode is sha-verified (same pin as the plane image)", () => {
  const body = instructionLines(dockerfile).join("\n");
  assert.ok(body.includes("sha256sum -c /opt/opencode.sha256"), "the vendored binary must be sha-verified at build");
  assert.ok(body.includes("COPY images/control-plane/opencode /usr/local/bin/opencode"), "the same release asset path");
  assert.ok(!body.includes("/tmp/opencode"), "the binary must never stage at opencode's runtime dir");
});

test("worker Dockerfile: the corpus fingerprint is written at build after the toolbox build", () => {
  const lines = instructionLines(dockerfile);
  const fingerprintIndex = lines.findIndex((line) => line.includes("run.mjs --write-fingerprint"));
  const toolboxIndex = lines.findIndex((line) => line.includes("prepare-tool.mjs"));
  assert.ok(toolboxIndex >= 0, "the toolbox must be built");
  assert.ok(fingerprintIndex > toolboxIndex, "the fingerprint must be written AFTER the toolbox build");
});

test("worker Dockerfile: no ingress, no baked tokens, no instance values", () => {
  const envLines = instructionLines(dockerfile).filter((line) => line.startsWith("ENV "));
  assert.ok(!envLines.some((line) => /secret|token|key|password/i.test(line)), "no credential may be baked");
  assert.ok(!/EXPOSE\b/.test(dockerfile), "the worker job has no ingress (no EXPOSE)");
  assert.ok(!instructionLines(dockerfile).some((line) => line.includes("WORKFLOW_KEYVAULT_NAME")), "instance values are not baked");
});

test("worker entry: the schema mirror agrees with the hub contract on accept + reject", () => {
  // The pod re-implements the pure schema module (it ships no TypeScript build).
  // The copy must not drift: identical verdicts on the accept case and each
  // reject class that matters at the seam.
  const good = {
    specVersion: 1,
    taskId: "task-1",
    repo: { url: "https://github.com/o/r.git", ref: "main" },
    gitPush: { secretRef: "git-push" },
    model: { id: "openrouter/anthropic/claude", secretRef: "model-key" },
    task: { message: "do the thing", declaredEvidence: ["tests"], budgetSeconds: 300, permissionPosture: "advisory" },
    mcp: { manifest: ["workflow-guard-mcp"], corpusFingerprint: "a".repeat(64) },
    artifacts: { evidenceContainer: "evidence", blobPrefix: "runs" },
  };
  assert.deepEqual(validateWorkerMessage(good), validateHubMessage(good));

  const rejects: Array<[string, unknown]> = [
    ["unknown specVersion", { ...good, specVersion: 2 }],
    ["empty declaredEvidence", { ...good, task: { ...good.task, declaredEvidence: [] } }],
    ["enforced posture", { ...good, task: { ...good.task, permissionPosture: "enforced" } }],
    ["non-advisory posture", { ...good, task: { ...good.task, permissionPosture: "mediated" } }],
    ["unsafe taskId", { ...good, taskId: "../escape" }],
    ["empty taskId", { ...good, taskId: "  " }],
    ["non-https repo url", { ...good, repo: { ...good.repo, url: "git://x" } }],
    ["dot-segment blobPrefix", { ...good, artifacts: { ...good.artifacts, blobPrefix: "a/../b" } }],
    ["invalid evidenceContainer", { ...good, artifacts: { ...good.artifacts, evidenceContainer: "Bad_Name" } }],
    ["non-integer budgetSeconds", { ...good, task: { ...good.task, budgetSeconds: 1.5 } }],
    ["zero budgetSeconds", { ...good, task: { ...good.task, budgetSeconds: 0 } }],
    ["empty corpusFingerprint", { ...good, mcp: { ...good.mcp, corpusFingerprint: "" } }],
  ];
  for (const [name, value] of rejects) {
    const hub = (() => {
      try {
        validateHubMessage(value);
        return "accepted";
      } catch {
        return "rejected";
      }
    })();
    const worker = (() => {
      try {
        validateWorkerMessage(value);
        return "accepted";
      } catch {
        return "rejected";
      }
    })();
    assert.equal(hub, "rejected", `hub must reject: ${name}`);
    assert.equal(worker, "rejected", `worker must reject: ${name}`);
  }
});

test("worker entry: the ref-envelope mirror agrees with the hub contract", () => {
  const envelope = { specVersion: 1, taskId: "task-1", bodyRef: { container: "evidence", blob: "runs/task-1.json" } };
  assert.deepEqual(validateWorkerEnvelope(envelope), validateHubEnvelope(envelope));
  assert.equal(isRefEnvelope(envelope), true);
  assert.equal(isRefEnvelope({ specVersion: 1, taskId: "t" }), false);
});

test("corpus fingerprint: deterministic, order-independent, and sensitive to content + additions", () => {
  const base = scratchCorpus({ "a/server.js": "console.log(1)", "b/util.js": "export const x=1" });
  try {
    const first = fingerprintCorpus(base);
    const second = fingerprintCorpus(base);
    assert.equal(first.fingerprint, second.fingerprint, "the digest is deterministic");
    assert.equal(first.fileCount, 2);
    assert.match(first.fingerprint, /^[0-9a-f]{64}$/);

    // A content change in any file changes the digest.
    writeFileSync(join(base, "a", "server.js"), "console.log(2)");
    const changed = fingerprintCorpus(base);
    assert.notEqual(changed.fingerprint, first.fingerprint, "a content change must move the digest");

    // A new .js file changes the digest; a non-.js file does not.
    mkdirSync(join(base, "c"), { recursive: true });
    writeFileSync(join(base, "c", "extra.js"), "export {}");
    const added = fingerprintCorpus(base);
    assert.notEqual(added.fingerprint, changed.fingerprint, "an added .js changes the digest");
    writeFileSync(join(base, "c", "readme.md"), "not code");
    assert.equal(fingerprintCorpus(base).fingerprint, added.fingerprint, "a non-.js file is ignored");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corpus fingerprint: a missing or empty corpus refuses (fail-closed)", () => {
  assert.throws(() => fingerprintCorpus(join(tmpdir(), "wf-worker-nope-does-not-exist")), /does not exist/);
  const empty = mkdtempSync(join(tmpdir(), "wf-worker-empty-"));
  try {
    assert.throws(() => fingerprintCorpus(empty), /no built \.js corpus/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("verifyCorpus: refuses a declared mismatch and an image/local mismatch", () => {
  const root = scratchCorpus({ "a/server.js": "console.log(1)" });
  try {
    const { fingerprint } = fingerprintCorpus(root);
    const recorded = join(root, "..", `recorded-${process.pid}.txt`);
    writeFileSync(recorded, `${fingerprint}\n`);
    try {
      // Match: returns the local digest.
      assert.equal(verifyCorpus(root, fingerprint, recorded).fingerprint, fingerprint);
      // A declared fingerprint that disagrees refuses.
      assert.throws(() => verifyCorpus(root, "b".repeat(64), recorded), /mismatch refused/);
      // A recorded fingerprint that disagrees with the live corpus refuses
      // (the image-tamper guard), independent of what the dispatch declared.
      writeFileSync(recorded, `${"c".repeat(64)}\n`);
      assert.throws(() => verifyCorpus(root, fingerprint, recorded), /does not match the live corpus/);
      // An absent recorded file refuses.
      assert.throws(() => verifyCorpus(root, fingerprint, join(root, "missing")), /no recorded fingerprint/);
    } finally {
      rmSync(recorded, { force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workerConfigFromEnv: names every missing/invalid value and refuses (fail-closed)", () => {
  const empty = workerConfigFromEnv({});
  assert.equal(empty.kind, "invalid");
  const missing = empty.kind === "invalid" ? empty.missing : [];
  assert.ok(missing.includes("WORKFLOW_AZURE_QUEUE_URL"));
  assert.ok(missing.includes("WORKFLOW_KEYVAULT_NAME"));
  assert.ok(missing.includes("WORKFLOW_AZURE_ACCOUNT_URL"));

  const invalid = workerConfigFromEnv({
    WORKFLOW_AZURE_QUEUE_URL: "https://acct.queue.core.windows.net/queue",
    WORKFLOW_KEYVAULT_NAME: "kv",
    WORKFLOW_AZURE_ACCOUNT_URL: "not-a-url",
  });
  assert.equal(invalid.kind, "invalid");
  assert.ok(
    invalid.kind === "invalid" && invalid.missing.some((item) => item.includes("WORKFLOW_AZURE_ACCOUNT_URL (invalid")),
  );

  const ok = workerConfigFromEnv({
    WORKFLOW_AZURE_QUEUE_URL: "https://acct.queue.core.windows.net/queue",
    WORKFLOW_KEYVAULT_NAME: "kv",
    WORKFLOW_AZURE_ACCOUNT_URL: "https://acct.blob.core.windows.net",
  });
  assert.equal(ok.kind, "configured");
  if (ok.kind === "configured") assert.equal(ok.visibilitySeconds, 60);
});

test("worker intake: an empty queue exits 0 without work (no false failure)", async () => {
  // Hermetic: the token fetch and dequeue are faked. No message means the run's
  // job is done (the KEDA execution ends cleanly), never an error.
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    if (url.includes("oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }
    // Dequeue: an empty <QueueMessagesList/>.
    return new Response("<?xml version=\"1.0\"?><QueueMessagesList/>", { status: 200 });
  };
  await workerMain(
    {
      WORKFLOW_AZURE_QUEUE_URL: "https://acct.queue.core.windows.net/queue",
      WORKFLOW_KEYVAULT_NAME: "kv",
      WORKFLOW_AZURE_ACCOUNT_URL: "https://acct.blob.core.windows.net",
    },
    { fetcher },
  );
  assert.ok(calls.some((url) => url.includes("/messages?visibilitytimeout=")), "the worker must attempt one dequeue");
});

test("worker intake: an invalid config refuses before any network call", async () => {
  let called = false;
  const fetcher = async () => {
    called = true;
    return new Response("", { status: 200 });
  };
  await assert.rejects(() => workerMain({}, { fetcher }), /missing or invalid config/);
  assert.equal(called, false, "a config fault must not reach the network");
});

test("git auth (P1 fix): the token rides an env-scoped extraheader, never argv or disk", () => {
  const token = "ghs_supersecret_token_value";
  const env = gitAuthEnv("https://github.com/o/r.git", token);
  // The token is base64'd into GIT_CONFIG_VALUE_0 (Basic auth), scoped to the
  // exact origin. It is NOT a URL credential (which git persists to
  // .git/config and echoes in errors).
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
});

test("redactSecret (P1 fix): the git token is removed from any error text", () => {
  const token = "ghs_supersecret_token_value";
  const error = new Error(`Command failed: git push https://x-access-token:${token}@github.com/o/r.git`);
  const redacted = redactSecret(error, token);
  assert.ok(!redacted.includes(token), "the token must be scrubbed");
  assert.ok(redacted.includes("[REDACTED]"));
  // A non-string/absent secret is a no-op, never a crash.
  assert.equal(redactSecret(new Error("plain"), ""), "plain");
});

test("worker turn: a corpus mismatch refuses BEFORE any clone or run (fail-closed)", async () => {
  // The plan's task-5 acceptance: "corpus mismatch refuses". A run whose
  // declared fingerprint disagrees with the pod's verified corpus must abort
  // before it clones, runs, or materializes a secret.
  const root = scratchCorpus({ "a/server.js": "console.log(1)" });
  const { fingerprint } = fingerprintCorpus(root);
  const recorded = join(root, "..", `recorded-turn-${process.pid}.txt`);
  writeFileSync(recorded, `${fingerprint}\n`);
  const message = validateWorkerMessage({
    specVersion: 1,
    taskId: "task-1",
    repo: { url: "https://github.com/o/r.git", ref: "main" },
    gitPush: { secretRef: "git-push" },
    model: { id: "openrouter/x", secretRef: "model-key" },
    task: { message: "do it", declaredEvidence: ["tests"], budgetSeconds: 10, permissionPosture: "advisory" },
    mcp: { manifest: [], corpusFingerprint: "b".repeat(64) },
    artifacts: { evidenceContainer: "evidence", blobPrefix: "runs" },
  });
  let cloned = false;
  let ran = false;
  try {
    await assert.rejects(
      () =>
        runWorkerTurn({
          message,
          config: {
            kind: "configured",
            queueUrl: "https://a.queue.core.windows.net/queue",
            vaultName: "kv",
            accountUrl: "https://a.blob.core.windows.net",
            visibilitySeconds: 60,
            modelEnvVar: undefined,
          },
          deps: {
            corpusRoot: root,
            fingerprintFile: recorded,
            log: () => {},
            clone: async () => {
              cloned = true;
              return root;
            },
            run: async () => {
              ran = true;
              return { stdout: "", stderr: "", exitCode: 0 };
            },
          },
        }),
      /mismatch refused/,
    );
  } finally {
    rmSync(recorded, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(cloned, false, "a corpus mismatch must refuse before the clone");
  assert.equal(ran, false, "a corpus mismatch must refuse before the run");
});

test("worker turn: an unmapped model env var refuses keyless (fail-closed)", async () => {
  // With a verified corpus but no WORKFLOW_WORKER_MODEL_ENV_VAR, the worker must
  // refuse rather than fetch a key it never passes to opencode (a silent
  // keyless run dressed as a real one).
  const root = scratchCorpus({ "a/server.js": "console.log(1)" });
  const { fingerprint } = fingerprintCorpus(root);
  const recorded = join(root, "..", `recorded-keyless-${process.pid}.txt`);
  writeFileSync(recorded, `${fingerprint}\n`);
  const message = validateWorkerMessage({
    specVersion: 1,
    taskId: "task-1",
    repo: { url: "https://github.com/o/r.git", ref: "main" },
    gitPush: { secretRef: "git-push" },
    model: { id: "openrouter/x", secretRef: "model-key" },
    task: { message: "do it", declaredEvidence: ["tests"], budgetSeconds: 10, permissionPosture: "advisory" },
    mcp: { manifest: [], corpusFingerprint: fingerprint },
    artifacts: { evidenceContainer: "evidence", blobPrefix: "runs" },
  });
  const fetcher = async (url: string) => {
    if (url.includes("oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    if (url.includes("vault.azure.net")) return new Response(JSON.stringify({ value: "secret-value" }), { status: 200 });
    return new Response("", { status: 200 });
  };
  let cloned = false;
  try {
    await assert.rejects(
      () =>
        runWorkerTurn({
          message,
          config: {
            kind: "configured",
            queueUrl: "https://a.queue.core.windows.net/queue",
            vaultName: "kv",
            accountUrl: "https://a.blob.core.windows.net",
            visibilitySeconds: 60,
            modelEnvVar: undefined,
          },
          deps: {
            fetcher,
            corpusRoot: root,
            fingerprintFile: recorded,
            log: () => {},
            clone: async () => {
              cloned = true;
              return root;
            },
          },
        }),
      /refusing to run keyless/,
    );
  } finally {
    rmSync(recorded, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(cloned, false, "a keyless run must refuse before the clone");
});
