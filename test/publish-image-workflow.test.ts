import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
 *
 * The verify step (`sha256sum -c opencode.sha256`) is pinned the same way: it
 * hashes the DOWNLOADED asset and compares it to the committed pin, so a
 * matching asset passes and a re-tagged asset fails closed. A characterization
 * pin constrains the check to the committed pin file itself (a download-step
 * output the workflow never wires to this step cannot silently replace it).
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowPath = join(repoRoot, ".github", "workflows", "publish-image.yml");
const workflow = readFileSync(workflowPath, "utf8");

const STEP_NAME = "Record the digest at the tagged release (the verify-pin contract)";
const VERIFY_STEP_NAME = "Verify the vendored binary against the recorded pin";

/**
 * Extract a step's `run:` script. Supports both GitHub Actions forms: the
 * `run: |` block scalar (two-space body indent) and the inline
 * `run: <command>` scalar (a single-line script).
 */
function runBlockForStep(name: string): string {
  const lines = workflow.split("\n");
  const nameIdx = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(nameIdx >= 0, `workflow step not found: ${name}`);
  const runIdx = lines.findIndex((line, index) => index > nameIdx && line.trimStart().startsWith("run:"));
  assert.ok(runIdx >= 0, `run block not found for step: ${name}`);
  const runLine = lines[runIdx] ?? "";
  const runIndent = runLine.search(/\S/);
  const inline = runLine.trim().slice("run:".length).trim();
  // Inline scalar (`run: sha256sum -c opencode.sha256`): return it verbatim.
  if (inline !== "" && inline !== "|" && inline !== ">") return inline;
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

interface VerifyRun {
  readonly status: number | null;
  readonly stderr: string;
}

// The downloaded asset's real bytes (content is arbitrary; only its digest
// against the pin matters). `sha256sum -c` hashes THIS file and compares it to
// `opencode.sha256`, so `actualAssetSha256` is the digest the check computes.
const ASSET_BYTES = "qualified-stock-opencode-binary\n";
const ACTUAL_ASSET_SHA256 = createHash("sha256").update(ASSET_BYTES).digest("hex");

/**
 * Execute the real verify step's `run:` block against a downloaded `opencode`
 * asset plus a recorded `opencode.sha256` pin. The block is `sha256sum -c
 * opencode.sha256`: it hashes the downloaded file and compares that digest to
 * the pin. A matching pin exits 0; a re-tagged asset (whose bytes differ from
 * the pin) exits non-zero.
 */
function verifyAsset(pinSha256: string): VerifyRun {
  const workdir = mkdtempSync(join(tmpdir(), "w149-verify-"));
  try {
    writeFileSync(join(workdir, "opencode"), ASSET_BYTES);
    // The committed pin file's format: "<64hex>  opencode" (GNU coreutils).
    writeFileSync(join(workdir, "opencode.sha256"), `${pinSha256}  opencode\n`);
    const scriptPath = join(workdir, "verify.sh");
    writeFileSync(scriptPath, runBlockForStep(VERIFY_STEP_NAME));
    const result = spawnSync("bash", ["-e", scriptPath], { cwd: workdir, encoding: "utf8" });
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("W149: the verify step passes when the downloaded asset matches the recorded pin", () => {
  const result = verifyAsset(ACTUAL_ASSET_SHA256);
  assert.equal(result.status, 0, result.stderr);
});

test("W149: the verify step fails closed when a re-tagged asset diverges from the recorded pin", () => {
  const result = verifyAsset("a".repeat(64));
  assert.notEqual(result.status, 0, "a re-tagged/mismatched asset must fail the build");
  assert.match(result.stderr, /did NOT match/, "the coreutils mismatch report must be present");
});

test("W149: the verify step hashes the downloaded file against the committed pin file (not a recorded output)", () => {
  const block = runBlockForStep(VERIFY_STEP_NAME);
  assert.ok(block.includes("sha256sum -c opencode.sha256"), "the committed pin must be the comparison source");
  assert.ok(!block.includes("$BINARY_SHA256"), "the check must not depend on a download-step output it never wires");
});

const NORMALIZE_STEP_NAME = "Normalize the image reference (lowercase repository for GHCR)";
const DOWNLOAD_STEP_NAME = "Download the qualified opencode release asset (fail closed)";

interface EnvRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Read a key appended to a GITHUB_ENV file. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

/**
 * W149: GHCR rejects an uppercase repository path, and `ultus-net/Workflow`
 * carries one. The normalize step pipes GITHUB_REPOSITORY through
 * `tr '[:upper:]' '[:lower:]'`; execute the real block to prove the
 * transformation (a mixed-case repo becomes all-lowercase, and a newline in
 * the value cannot inject extra GITHUB_ENV lines).
 */
function normalize(repository: string): EnvRun {
  const workdir = mkdtempSync(join(tmpdir(), "w149-lower-"));
  try {
    const envFile = join(workdir, "github_env");
    writeFileSync(envFile, "");
    const scriptPath = join(workdir, "normalize.sh");
    writeFileSync(scriptPath, runBlockForStep(NORMALIZE_STEP_NAME));
    const result = spawnSync("bash", ["-e", scriptPath], {
      cwd: workdir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: repository, GITHUB_ENV: envFile },
    });
    return { status: result.status, stderr: result.stderr, env: parseEnvFile(readFileSync(envFile, "utf8")) };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("W149: the image reference is lowercased for GHCR", () => {
  const result = normalize("ultus-net/Workflow");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.env.IMAGE_REPOSITORY, "ultus-net/workflow", "GHCR requires a lowercase repository");
});

/**
 * W149: the release must carry the qualified opencode binary as an asset. The
 * download step shells `gh release download`; a stub `gh` lets us execute the
 * real block for the fail-closed arms. `GITHUB_REPOSITORY` is GitHub-format
 * constrained (alphanumeric-plus-dash/dot, per the workflow header), so the
 * newline-injection class the tag-resolve step guards does not apply here.
 *
 * Arm `gh-exit` models gh returning nonzero (the realistic absent-asset case);
 * arm `gh-empty-ok` models gh succeeding yet writing nothing, which the step's
 * explicit presence check must still refuse.
 */
function downloadAsset(arm: "present" | "gh-exit" | "gh-empty-ok"): { readonly status: number | null; readonly stderr: string } {
  const workdir = mkdtempSync(join(tmpdir(), "w149-dl-"));
  try {
    mkdirSync(join(workdir, "images", "control-plane"), { recursive: true });
    const bin = join(workdir, "bin");
    mkdirSync(bin);
    const ghBody = [
      "#!/usr/bin/env bash",
      'dir="."',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--dir" ]; then dir="$2"; shift 2; continue; fi',
      "  shift",
      "done",
      arm === "present" ? 'printf "qualified\\n" > "$dir/opencode"' : "",
      arm === "gh-exit" ? "exit 1" : "exit 0",
    ].join("\n");
    writeFileSync(join(bin, "gh"), `${ghBody}\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const scriptPath = join(workdir, "download.sh");
    writeFileSync(scriptPath, runBlockForStep(DOWNLOAD_STEP_NAME));
    const result = spawnSync("bash", ["-e", scriptPath], {
      cwd: workdir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GH_TOKEN: "t", RELEASE_TAG: "v2.0.10", GITHUB_REPOSITORY: "ultus-net/workflow" },
    });
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("W149: the download step passes when the release carries the opencode asset", () => {
  const result = downloadAsset("present");
  assert.equal(result.status, 0, result.stderr);
});

test("W149: the download step fails closed when gh returns nonzero (no asset)", () => {
  const result = downloadAsset("gh-exit");
  assert.notEqual(result.status, 0, "a release without the asset must fail the build");
});

test("W149: the download step fails closed when gh succeeds but writes no artifact", () => {
  const result = downloadAsset("gh-empty-ok");
  assert.notEqual(result.status, 0, "a missing artifact must fail the build even if gh exits 0");
  assert.match(result.stderr, /::error::/, "the explicit presence check must emit a clear ::error::");
});


