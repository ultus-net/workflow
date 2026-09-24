import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// W125 — the compiled-artifact smoke: the suite's seats were all SOURCE seats.
// test/web.test.ts and test/fixtures/webui-demo-server.ts load
// ../src/ui/webapp/bundle.js under the tsx loader, where the module is
// src/ui/webapp/bundle.ts and the sibling-entry resolution is valid; the
// compiled layout (dist/cli/web-service.js -> dist/ui/webapp/bundle.js) was
// never a test seat, so W124's entry-resolution skew was found by the
// operator's manual UAT run (`npm run build && node dist/cli/workflow.js`)
// and not by the suite. The W124 pins exercise resolveWebappEntry with
// simulated dist-shaped module URLs (its own recorded residual: "the pin
// exercises the fallback logic, not a built artifact") — they never import
// the real compiled module. This file closes that class (LESS-0048's
// two-seats rule made executable): the REAL dist bundle is imported and
// executed, and the compiled launcher bin is spawned end-to-end.
//
// Conditional on the artifact existing, self-healing like the W120
// freshness gate: a missing or stale dist triggers `npm run build` (the
// rebuild is deterministic and idempotent; the mtime false-positive class —
// a checkout touching mtimes without a content change — is W120's recorded,
// deliberate trade). A missing artifact is NOT staleness: it is the
// rebuild's job (the same two-error-class split as the W120 gate).

const repoRoot = process.cwd();
const bundleArtifact = join(repoRoot, "dist", "ui", "webapp", "bundle.js");
const launcherArtifact = join(repoRoot, "dist", "cli", "workflow.js");

/** Newest mtime under a src tree, or undefined when the tree is absent. */
function newestSrcMtime(srcRoot: string): number | undefined {
  if (!existsSync(srcRoot)) return undefined;
  let newest: number | undefined;
  const stack = [srcRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      const mtimeMs = statSync(path).mtimeMs;
      if (newest === undefined || mtimeMs > newest) newest = mtimeMs;
    }
  }
  return newest;
}

/** W120's staleness semantics, scoped to the artifact under test: a missing
 * artifact is the rebuild's job; any input newer than the artifact is
 * stale (the fail-closed direction — the remedy is an idempotent rebuild).
 * The inputs are the src walk PLUS the build's config inputs (the tsconfigs
 * and the package manifest — a config-only change with no src mtime bump
 * must still rebuild; the W125 round-1 review P2, LESS-0049(4) applied to
 * this pin's own walk). */
const BUILD_CONFIG_INPUTS = ["tsconfig.json", "tsconfig.build.json", "package.json", "package-lock.json"] as const;

function artifactIsStale(artifact: string, srcRoot: string): boolean {
  if (!existsSync(artifact)) return false;
  const artifactMtime = statSync(artifact).mtimeMs;
  const newest = newestSrcMtime(srcRoot);
  if (newest !== undefined && newest > artifactMtime) return true;
  return BUILD_CONFIG_INPUTS.some((name) => {
    const path = join(repoRoot, name);
    return existsSync(path) && statSync(path).mtimeMs > artifactMtime;
  });
}

function ensureBuilt(artifact: string, srcRoot: string): void {
  if (existsSync(artifact) && !artifactIsStale(artifact, srcRoot)) return;
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
}

test("W125: the real compiled webapp bundle produces js and css in the dist seat", async () => {
  ensureBuilt(bundleArtifact, join(repoRoot, "src", "ui", "webapp"));
  // The source-seat tests import ../src/ui/webapp/bundle.js; THIS import is
  // the compiled module the operator's launcher actually serves. A resolution
  // regression here fails exactly as the operator's live run did
  // ("Could not resolve .../dist/ui/webapp/main.tsx" — the W124 repro).
  const compiled = (await import(pathToFileURL(bundleArtifact).href)) as {
    buildWebappBundle(): Promise<{ js: string; css: string }>;
  };
  const built = await compiled.buildWebappBundle();
  assert.ok(built.js.length > 0, "the dist seat bundles non-empty js");
  assert.ok(
    built.js.includes("composer-chips"),
    "the compiled js carries the app's markup hooks (a string literal survives minification)",
  );
  assert.ok(built.css.length > 0, "the dist seat bundles non-empty css");
  assert.ok(
    built.css.includes("--accent"),
    "the compiled css carries the styles.css design tokens (the css side-effect import must resolve in the dist graph)",
  );
});

test("W125: the compiled launcher runs end-to-end non-interactively (node dist/cli/workflow.js doctor)", () => {
  ensureBuilt(launcherArtifact, join(repoRoot, "src"));
  // The first compiled execution the suite has ever performed of a bin
  // (the operator's manual UAT was the only prior runner). doctor is the
  // safe probe: read-only checks, no daemon spawn, non-interactive by
  // contract. Exit 0/1 are BOTH honest outcomes (warns and fail rows are
  // environment truth); a signal, a timeout, or any other status is a
  // crash of the compiled tree, which is what this pin exists to catch.
  const result = spawnSync(process.execPath, ["dist/cli/workflow.js", "doctor"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(
    result.error,
    undefined,
    `the compiled launcher spawned cleanly (${result.error?.message ?? "no spawn error"})`,
  );
  assert.ok(
    result.stdout.includes("Workflow doctor"),
    "the compiled launcher dispatched the doctor verb and rendered its report",
  );
  assert.ok(
    result.stdout.includes("settings documents"),
    "the rendered report carries the doctor's checks (runDoctor's first push)",
  );
  assert.ok(
    result.status === 0 || result.status === 1,
    `exit ${result.status} (signal ${result.signal}) — the doctor's honest exits are 0 (pass/warn) and 1 (fail rows); anything else is a compiled-runtime crash`,
  );
});