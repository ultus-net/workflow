import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import { distArtifact, ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

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
// the real compiled module. The W125 file closed that class (LESS-0048's
// two-seats rule made executable): the REAL dist bundle is imported and
// executed, and the compiled launcher bin is spawned end-to-end. W127
// extends it with the two dist-seat paths that exist since the prebuilt
// bundle: the packaged seat (no src, no node_modules) and the runtime
// fallback (the W124 resolution executed for real).
//
// Conditional on the artifact existing, self-healing like the W120
// freshness gate — the shared gate lives in test/fixtures/compiled-dist.ts
// (the whole-src walk + config inputs; the mtime false-positive class is
// W120's recorded, deliberate trade). A missing artifact is NOT staleness:
// it is the rebuild's job (the same two-error-class split as the W120 gate).

const bundleArtifact = distArtifact("ui", "webapp", "bundle.js");
const launcherArtifact = distArtifact("cli", "workflow.js");

test("W125: the real compiled webapp bundle produces js and css in the dist seat", async () => {
  ensureFresh(bundleArtifact);
  // The source-seat tests import ../src/ui/webapp/bundle.js; THIS import is
  // the compiled module the operator's launcher actually serves. Since W127
  // the dist seat serves the PREBUILT artifact — this pin proves the
  // compiled module serves correct js and css; the runtime fallback path
  // (entry resolution + esbuild) keeps its own pin below, and the W124
  // synthetic-URL pins keep covering the resolution logic itself.
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
  ensureFresh(launcherArtifact);
  // The first compiled execution the suite has ever performed of a bin
  // (the operator's manual UAT was the only prior runner). doctor is the
  // safe probe: read-only checks, no daemon spawn, non-interactive by
  // contract — and deliberately NOT hermetic: it reads the operator's
  // real home (~/.workflow, settings) and probes live local endpoints
  // (bounded: probeHub's 2s AbortSignal, the gateway probe's 2s
  // AbortSignal, and the 120s spawn timeout below) — an honest
  // environment-truth probe, not a sandboxed fixture. Exit 0/1 are BOTH
  // honest outcomes (warns and fail rows are environment truth); a
  // signal, a timeout, or any other status is a crash of the compiled
  // tree, which is what this pin exists to catch.
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

test("W127: the compiled webapp module's runtime fallback resolves and bundles from the src entry (no prebuilt beside it)", async (context) => {
  ensureFresh(bundleArtifact);
  // W127 kept the W124 class alive: with the prebuilt artifact absent, the
  // compiled module must fall back to the runtime build — resolveWebappEntry
  // executed by the REAL compiled module (the W124-class regression the
  // synthetic-URL pins can only model, and the path the W125 dist-seat pin
  // stopped exercising once the prebuilt artifact took over the dist seat).
  // The copy lives under the repo root (not os.tmpdir) so the module's lazy
  // esbuild import resolves this checkout's node_modules — the fallback is
  // only reachable where esbuild is installed, which is what this seat is.
  const fallbackTree = mkdtempSync(join(repoRoot, ".tmp-w127-fallback-"));
  context.after(() => rmSync(fallbackTree, { recursive: true, force: true }));
  mkdirSync(join(fallbackTree, "ui", "webapp"), { recursive: true });
  copyFileSync(bundleArtifact, join(fallbackTree, "ui", "webapp", "bundle.js"));
  const compiled = (await import(pathToFileURL(join(fallbackTree, "ui", "webapp", "bundle.js")).href)) as {
    buildWebappBundle(): Promise<{ js: string; css: string }>;
  };
  const built = await compiled.buildWebappBundle();
  assert.ok(built.js.length > 0, "the fallback runtime build produced js");
  assert.ok(
    built.js.includes("composer-chips"),
    "the fallback bundles the src entry's markup hooks",
  );
  assert.ok(
    built.css.includes("--accent"),
    "the fallback's css side-effect import resolved through the src graph",
  );
});

test("W127: the packaged seat (no src, no node_modules) serves the prebuilt bundle verbatim", async (context) => {
  ensureFresh(bundleArtifact);
  // The packaged install ships dist/ only: no src (the W124 fallback's
  // three-up source entry is absent) and no devDependencies (esbuild
  // absent — the pre-W127 compiled module imported esbuild STATICALLY, so
  // a packaged tree could not even LOAD it: "Cannot find package
  // 'esbuild'" is the module-load mechanism this seat's lazy import
  // removes). The pin's own first red (pre-W127) was the missing prebuilt
  // artifacts themselves (copyFileSync ENOENT — the build emitted none).
  // Post-W127 the seat assembles, and the compiled bundle must (a) import
  // esbuild lazily and (b) serve the prebuilt artifacts beside it — this
  // pin executes exactly that tree: dist/ui/webapp copied WITHOUT src and
  // WITHOUT node_modules. The verbatim equality also proves the served
  // content IS the prebuilt artifact (a runtime build is impossible in
  // this tree).
  const packaged = mkdtempSync(join(tmpdir(), "w127-packaged-"));
  context.after(() => rmSync(packaged, { recursive: true, force: true }));
  mkdirSync(join(packaged, "ui", "webapp"), { recursive: true });
  for (const name of ["bundle.js", "prebuilt.js", "prebuilt.css"]) {
    copyFileSync(distArtifact("ui", "webapp", name), join(packaged, "ui", "webapp", name));
  }
  const compiled = (await import(pathToFileURL(join(packaged, "ui", "webapp", "bundle.js")).href)) as {
    buildWebappBundle(): Promise<{ js: string; css: string }>;
  };
  const built = await compiled.buildWebappBundle();
  assert.equal(
    built.js,
    readFileSync(distArtifact("ui", "webapp", "prebuilt.js"), "utf8"),
    "the packaged seat serves the prebuilt js verbatim",
  );
  assert.equal(
    built.css,
    readFileSync(distArtifact("ui", "webapp", "prebuilt.css"), "utf8"),
    "the packaged seat serves the prebuilt css verbatim",
  );
});