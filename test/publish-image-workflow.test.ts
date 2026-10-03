import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * W149 (issue #142): the publish workflow's digest record must be EXACTLY ONE
 * `sha256:<64hex>` line. build-push-action's `digest` output already carries
 * the `sha256:` prefix, and the original record step re-prefixed it
 * (`printf 'sha256:%s'`) into the malformed `sha256:sha256:<64hex>` — which
 * shipped silently because `instances/azure/verify-pin.sh` `grep -oE`s the
 * inner hash out of the doubled value.
 *
 * These pins EXECUTE the real record step's `run:` block against a stub `gh`
 * (a static string assert alone could be satisfied by a comment), so the
 * double prefix cannot come back: a valid digest records verbatim, a
 * non-contract digest fails closed with `::error::` and writes nothing.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowPath = join(repoRoot, ".github", "workflows", "publish-image.yml");
const workflow = readFileSync(workflowPath, "utf8");

const STEP_NAME = "Record the digest at the tagged release (the verify-pin contract)";

/** Extract a step's `run: |` block scalar (two-space body indent). */
function runBlockForStep(name: string): string {
  const lines = workflow.split("\n");
  const nameIdx = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(nameIdx >= 0, `workflow step not found: ${name}`);
  const runIdx = lines.findIndex((line, index) => index > nameIdx && line.trim() === "run: |");
  assert.ok(runIdx >= 0, `run block not found for step: ${name}`);
  const runIndent = (lines[runIdx] ?? "").search(/\S/);
  const body: string[] = [];
  for (let index = runIdx + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (line.search(/\S/) <= runIndent) break;
    body.push(line);
  }
  const bodyIndent = Math.min(...body.filter((line) => line.trim() !== "").map((line) => line.search(/\S/)));
  return body.map((line) => (line.trim() === "" ? "" : line.slice(bodyIndent))).join("\n");
}

interface RecordRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly recorded: string | undefined;
}

function recordDigest(digest: string): RecordRun {
  const workdir = mkdtempSync(join(tmpdir(), "w149-publish-"));
  try {
    const bin = join(workdir, "bin");
    mkdirSync(bin);
    // Stub `gh`: `release view` yields no body (exit 0); upload/edit are no-ops.
    const gh = join(bin, "gh");
    writeFileSync(gh, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(gh, 0o755);
    const scriptPath = join(workdir, "record.sh");
    writeFileSync(scriptPath, runBlockForStep(STEP_NAME));
    const result = spawnSync("bash", ["-e", scriptPath], {
      cwd: workdir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "test-token",
        RELEASE_TAG: "v2.0.10",
        GITHUB_REPOSITORY: "ultus-net/Workflow",
        IMAGE_DIGEST: digest,
      },
    });
    const recordedPath = join(workdir, "image-digest.txt");
    const recorded = existsSync(recordedPath) ? readFileSync(recordedPath, "utf8") : undefined;
    return { status: result.status, stderr: result.stderr, recorded };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("W149: the record step writes exactly one sha256:<64hex> line", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const result = recordDigest(digest);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.recorded, `${digest}\n`);
  assert.ok(!(result.recorded ?? "").includes("sha256:sha256:"), "the double prefix must never be written");
});

test("W149: a double-prefixed digest fails closed instead of being recorded", () => {
  const result = recordDigest(`sha256:sha256:${"a".repeat(64)}`);
  assert.notEqual(result.status, 0, "a non-contract digest must exit nonzero");
  assert.match(result.stderr, /::error::/);
  assert.equal(result.recorded, undefined, "no expectation file may be written on a malformed digest");
});

test("W149: the record step keeps the verbatim single-prefix write and the format assertion", () => {
  const block = runBlockForStep(STEP_NAME);
  assert.ok(block.includes(`printf '%s\\n' "$IMAGE_DIGEST" > image-digest.txt`), "the value must be written verbatim");
  assert.ok(
    !block.includes(`printf 'sha256:%s\\n' "$IMAGE_DIGEST" > image-digest.txt`),
    "the double-prefixing write must be gone",
  );
  assert.ok(block.includes("^sha256:[0-9a-f]{64}$"), "the fail-closed format assertion must be present");
});

/**
 * W149 review P3: `workflow_dispatch` had no `tag` input, so a manual run had
 * to be dispatched from the `v*` tag ref or `github.ref_name` resolved to the
 * branch (`main`) and every release step targeted the wrong ref. The fix adds
 * a required `tag` input plus a resolve step that prefers it over the pushed
 * ref and fails closed on a non-`v` value.
 */
test("W149: workflow_dispatch declares a required tag input", () => {
  const match = /^ {2}workflow_dispatch:\n((?: {4}.*\n)+)/m.exec(workflow);
  assert.ok(match, "workflow_dispatch must be declared");
  const block = match[1] ?? "";
  assert.match(block, /inputs:/, "workflow_dispatch must declare inputs");
  assert.match(block, /tag:/, "workflow_dispatch must declare a tag input");
  assert.match(block, /required: true/, "the tag input must be required");
});

test("W149: the tag resolve step prefers the dispatch input and fails closed on a non-v tag", () => {
  const resolveTag = (input: string, pushedRef: string): { status: number | null; resolved: string | undefined; stderr: string } => {
    const workdir = mkdtempSync(join(tmpdir(), "w149-tag-"));
    try {
      // GITHUB_ENV is a file the step appends to; point it inside workdir.
      const envFile = join(workdir, "github_env");
      writeFileSync(envFile, "");
      const scriptPath = join(workdir, "tag.sh");
      writeFileSync(scriptPath, runBlockForStep("Resolve the release tag (dispatch input or pushed tag, fail closed)"));
      const result = spawnSync("bash", ["-e", scriptPath], {
        cwd: workdir,
        encoding: "utf8",
        env: { ...process.env, RELEASE_TAG_INPUT: input, PUSHED_REF: pushedRef, GITHUB_ENV: envFile },
      });
      const text = readFileSync(envFile, "utf8");
      const resolved = /^RELEASE_TAG=(.*)$/m.exec(text)?.[1];
      return { status: result.status, resolved, stderr: result.stderr };
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  };

  const fromInput = resolveTag("v2.0.10", "main");
  assert.equal(fromInput.status, 0, fromInput.stderr);
  assert.equal(fromInput.resolved, "v2.0.10", "the dispatch input must win over the branch ref");

  const fromPush = resolveTag("", "v2.0.10");
  assert.equal(fromPush.status, 0, fromPush.stderr);
  assert.equal(fromPush.resolved, "v2.0.10", "a pushed tag ref must be used when no input is given");

  const rejected = resolveTag("2.0.10", "main");
  assert.notEqual(rejected.status, 0, "a non-v tag must fail closed");
  assert.match(rejected.stderr, /::error::/);
  assert.equal(rejected.resolved, undefined, "no RELEASE_TAG may be exported on a bad tag");

  // A newline in the tag would let a caller inject extra GITHUB_ENV entries;
  // the character-class guard must reject it (grep alone is line-based and
  // would accept it).
  const injected = resolveTag("v2.0.10\nINJECTED_VAR=attacker-controlled", "main");
  assert.notEqual(injected.status, 0, "a newline-bearing tag must fail closed");
  assert.equal(injected.resolved, undefined, "no RELEASE_TAG may be exported on an injected tag");
});
