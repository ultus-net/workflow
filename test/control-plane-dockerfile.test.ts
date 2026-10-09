import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Control-plane Dockerfile pins (W149). The image is the artifact the Azure
 * instance pins by digest, so a silent regression in these lines is a
 * deploy-path defect, not a style nit. Each pin corresponds to a defect
 * MEASURED in the first real local build (podman, 2026-10-09); the assertion
 * text names the observed failure so the pin is not a comment-only check.
 *
 * These are structural pins, not a build: the build itself is the publish
 * workflow's job (and the gated local recipe lives in the ledger). They stop
 * the specific regressions that only surfaced under a real build.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dockerfile = readFileSync(join(repoRoot, "images", "control-plane", "Dockerfile"), "utf8");
const dockerignore = readFileSync(join(repoRoot, ".dockerignore"), "utf8");
const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");

function instructionLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.trim());
}

test("Dockerfile: the source tree COPY has an explicit destination (TS18003 regression)", () => {
  // A multi-source COPY like `COPY src tsconfig.json ./` copies `src`'s
  // CONTENTS into `/app`, so `/app/src` never exists and tsc fails
  // "TS18003: No inputs were found" — measured 2026-10-09. `src` needs its
  // own explicit destination.
  const lines = instructionLines(dockerfile);
  assert.ok(lines.includes("COPY src ./src"), "the src tree must be copied to /app/src explicitly");
  const offenders = lines.filter((line) => /^COPY\b.*\bsrc\b.*\btsconfig/.test(line));
  assert.deepEqual(offenders, [], "src must not share a directory destination with the config files");
  assert.ok(lines.includes("COPY tsconfig.json tsconfig.build.json ./"), "the tsconfig files copy to the workdir");
});

test("Dockerfile: opencode does not stage a file at /tmp/opencode (EEXIST regression)", () => {
  // opencode uses `$TMPDIR/opencode` as its own runtime dir and aborts with
  // `EEXIST: mkdir '/tmp/opencode'` when a file sits there, failing the
  // `opencode --version` gate — measured 2026-10-09. The binary lands at its
  // final path; the pin file stages outside any opencode-known dir.
  const lines = instructionLines(dockerfile);
  assert.ok(
    lines.some((line) => line.startsWith("COPY images/control-plane/opencode ")),
    "the binary must be COPYed to a non-/tmp destination",
  );
  assert.ok(
    !lines.some((line) => /^COPY\b.*\bopencode\s+\/tmp\/opencode$/.test(line)),
    "the binary must never be staged at /tmp/opencode",
  );
  assert.ok(
    !lines.some((line) => /\bcd \/tmp\b/.test(line)),
    "the verify RUN must not work inside /tmp (opencode's runtime dir)",
  );
});

test("Dockerfile: the toolbox build runs with CI=true (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY regression)", () => {
  // prepare-tool.mjs runs `pnpm --dir mcp-toolbox run build`, which reconciles
  // the workspace node_modules; with no TTY pnpm aborts the purge and the
  // toolbox build is SKIPPED, so the guard server never lands — measured
  // 2026-10-09. CI=true is pnpm's documented non-interactive signal.
  const lines = instructionLines(dockerfile);
  const buildLineIndex = lines.findIndex((line) => line.includes("prepare-tool.mjs"));
  assert.ok(buildLineIndex >= 0, "the prepare-tool step must exist");
  // The RUN spans continuations; its FIRST physical line carries the env.
  let runStart = buildLineIndex;
  while (runStart > 0 && !lines[runStart]!.startsWith("RUN ")) runStart -= 1;
  assert.match(lines[runStart]!, /^RUN CI=true\b/, "the toolbox build must set CI=true");
  assert.ok(
    lines.some((line) => line.includes("CI=true node scripts/prepare-tool.mjs")),
    "prepare-tool must run under CI=true",
  );
});

test("Dockerfile: the package's own bins are linked onto PATH (workflow-hub CMD regression)", () => {
  // `npm ci` does not link the root package's bins, so the former
  // `CMD ["workflow-hub"]` failed with `Cannot find module
  // '/workspace/workflow-hub'` — measured 2026-10-09. `npm link` links the
  // root package's bins into the global prefix after the tree is final.
  const body = instructionLines(dockerfile).join("\n");
  assert.ok(body.includes("RUN npm link --ignore-scripts"), "the root package's bins must be linked");
});

test("Dockerfile: the C1 plane is the long-running entry (CMD workflow-plane)", () => {
  // Task 3 (2026-10-09): the single-process hub entry is superseded by the C1
  // plane supervisor, which composes hub + OpenCode server daemon + gateway and
  // binds the gateway to 4096. See docs/ledger/control-plane-c1-deploy-plan.md.
  assert.ok(dockerfile.includes('CMD ["workflow-plane"]'), "the plane supervisor is the long-running entry");
  assert.ok(!dockerfile.includes('CMD ["workflow-hub"]'), "the superseded hub-only CMD must be gone");
});

test("Dockerfile: the plane runs as the unprivileged node user with a writable state root (D6)", () => {
  // D6: USER node, never root at runtime. The default state root (~/.workflow)
  // is pre-created and node-owned so the daemon can write discovery.
  const lines = instructionLines(dockerfile);
  assert.ok(lines.includes("USER node"), "the image must run as the node user");
  assert.ok(
    lines.some((line) => /^RUN mkdir -p \/home\/node\/\.workflow\b/.test(line)),
    "the node user's state root must be pre-created",
  );
  assert.ok(
    lines.some((line) => /chown -R node:node \/home\/node/.test(line)),
    "the state root must be node-owned",
  );
});

test("Dockerfile: the named instance env values are never baked into the image (spec section 5)", () => {
  // spec section 5: the image carries no instance values. The state root is set
  // by the INSTANCE (WORKFLOW_OPENCODE_SERVER_HOME = the Azure Files mount),
  // never baked; and the containment backend is an instance-supplied env var,
  // not an image default (the image must not silently claim container-boundary
  // on a bare host).
  const envLines = instructionLines(dockerfile).filter((line) => line.startsWith("ENV "));
  assert.ok(
    !envLines.some((line) => line.includes("WORKFLOW_OPENCODE_SERVER_HOME")),
    "the state root is an instance value and must not be baked",
  );
  assert.ok(
    !envLines.some((line) => line.includes("WORKFLOW_CONTAINMENT_BACKEND")),
    "the containment backend is instance-supplied, never an image default",
  );
});

test(".dockerignore: nested node_modules are excluded (context hygiene)", () => {
  // A bare `node_modules` pattern matches only the root; mcp-toolbox's nested
  // trees were copied into the context (verified 2026-10-09), defeating the
  // reproducible in-container install. `**/node_modules` catches every depth.
  const patterns = dockerignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  assert.ok(patterns.includes("node_modules"), "the root node_modules stays excluded");
  assert.ok(patterns.includes("**/node_modules"), "nested node_modules trees must be excluded");
});

test(".gitignore: the vendored opencode binary is never committed", () => {
  // The binary is a 198 MB dev-channel build that publish-image.yml downloads
  // into images/control-plane/opencode per publish (and the built image COPYs
  // from that path). `.gitignore` ignored only the C0 path, so `git add -A`
  // would stage the fetched 198 MB binary — measured 2026-10-09. Both vendor
  // paths must stay ignored.
  const lines = gitignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  assert.ok(lines.includes("images/control-plane/opencode"), "the control-plane binary path must be ignored");
  assert.ok(lines.includes("infra/c0/image/opencode"), "the C0 binary path stays ignored");
});
