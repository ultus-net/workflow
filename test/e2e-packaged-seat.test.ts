import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

import { distArtifact, ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

// W128 — the PACKAGED seat end to end (W127's honest gap). W127 made the
// webapp payload self-sufficient: scripts/build-webapp-bundle.mjs emits
// dist/ui/webapp/prebuilt.js + prebuilt.css at BUILD time, and
// src/ui/webapp/bundle.ts serves them when present while importing esbuild
// LAZILY, so the packaged seat never loads the esbuild devDependency. But the
// W127 pin (test/webapp-bundle-dist.test.ts) exercised a HAND-ASSEMBLED copy
// of three dist files — the class that catches "works in the repo, breaks in
// the package" was still untested, because package.json's files[] (dist,
// assets, README.md, THREAT_MODEL.md, docs, mcp-toolbox, packaging) decides
// what a real install carries and nothing ran the real tarball. This file
// does: npm pack from the repo root, the tarball-shape pin, the extracted
// dependency-free module execution (a SECOND tree deliberately under
// os.tmpdir(), never under repoRoot, so the repo's node_modules can never
// resolve — a runtime esbuild build is impossible there), and — the deepest
// e2e — the full `npm install` of the tarball into a third prefix followed by
// the packaged doctor run from the installed bin.
//
// Honesty claims: (1) the shape pin asserts the contract the tarball ACTUALLY
// carries (prebuilt artifacts present, no src/, no test/ entries) rather than
// what package.json promises; (2) the install step is environment-dependent —
// if it fails here the test SKIPs with the observed stderr recorded in the
// skip message and the limit is reported, never faked; (3) the doctor pin
// keeps the W125 contract exactly: stdout includes "Workflow doctor" and exit
// 0 (pass/warn) or 1 (fail rows) are BOTH honest outcomes — anything else is
// a crash of the packaged tree. (4) One environment caveat recorded from the
// actual runs: npm 12's `install-scripts` gate does NOT execute the
// package's own postinstall during a plain tarball install (it warns and
// requires explicit approval), so this pin never exercises
// `postinstall: node scripts/prepare-tool.mjs` directly — and the sweep
// found that file shipped NOWHERE (files[] had no scripts entry: every
// lifecycle-executing install would fail with ENOENT). Fixed in this loop
// (files[] ships scripts/prepare-tool.mjs) and pinned by the shape test;
// the hook's own execution remains an npm-12-gated residual.
//
// SAFETY CONTRACT (LESS-0051): no agent or PTY spawns ever; every spawned
// process is a short-lived, non-interactive npm/tar/node invocation; all
// scratch state lives in mkdtemp trees under os.tmpdir() and the doctor runs
// with a redirected HOME (its own mkdtemp), so no ~/.workflow state is read
// or written; the doctor exits by itself so spawnSync with a generous
// timeout is correct here (no long-running process to tear down —
// spawnSync's timeout-kill is only blind to clean teardown, and there is
// none to observe). npm's HOME is redirected too; the shared npm cache is
// passed via --cache so install can stay warm and offline-tolerant while
// writing nothing into the operator's home dotfiles.

interface PackedTarball {
  /** The pack destination (a mkdtemp tree). */
  readonly dir: string;
  readonly tarball: string;
  /** `tar -tzf` lines of the packed tarball. */
  readonly listing: readonly string[];
}

/** Scratch roots to remove when the file's tests are done. */
const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

let packedCache: PackedTarball | undefined;

/** Pack the real tarball once (the build freshness gate runs before it). */
function packOnce(): PackedTarball {
  if (packedCache !== undefined) return packedCache;
  // Nothing ships before the compiled tree is fresh — the shared W125 gate
  // runs `npm run build` when dist is missing or older than its input graph.
  ensureFresh(distArtifact("cli", "workflow.js"));
  const dir = mkdtempSync(join(tmpdir(), "w128-pack-"));
  tempRoots.push(dir);
  const packed = spawnSync("npm", ["pack", "--pack-destination", dir], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
  });
  assert.equal(
    packed.status,
    0,
    `npm pack must succeed from the repo root (status ${packed.status}, stderr: ${packed.stderr})`,
  );
  const tarballs = readdirSync(dir).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, `npm pack produced exactly one tarball (${tarballs.join(", ")})`);
  const tarball = join(dir, tarballs[0]!);
  const listed = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8", timeout: 60_000 });
  assert.equal(listed.status, 0, `tar -tzf must list the tarball (stderr: ${listed.stderr})`);
  packedCache = { dir, tarball, listing: listed.stdout.split("\n") };
  return packedCache;
}

test("W128: the packed tarball ships the prebuilt webapp payload and never src or test trees", () => {
  const { listing } = packOnce();
  // The W127 prebuilt artifacts are the packaged seat's whole payload —
  // their absence in the TARBALL (as opposed to the dist tree the W127 pin
  // copied from) is exactly the "works in the repo, breaks in the package"
  // class this file exists for.
  assert.ok(
    listing.includes("package/dist/ui/webapp/prebuilt.js"),
    "the tarball carries dist/ui/webapp/prebuilt.js (the build-time-emitted bundle)",
  );
  assert.ok(
    listing.includes("package/dist/ui/webapp/prebuilt.css"),
    "the tarball carries dist/ui/webapp/prebuilt.css",
  );
  assert.ok(
    listing.includes("package/dist/cli/workflow.js"),
    "the tarball carries the compiled launcher bin (package.json bin map)",
  );
  assert.ok(
    listing.includes("package/scripts/prepare-tool.mjs"),
    "the tarball carries the postinstall target (package.json's postinstall runs node scripts/prepare-tool.mjs — a files[] without it fails every lifecycle-executing install with ENOENT; the W128 sweep's packaged-seat finding, fixed in this loop)",
  );
  assert.ok(
    !listing.some((entry) => entry.startsWith("package/src/")),
    "no src/ ships (package.json files[] — the W124 fallback's source entry must be absent)",
  );
  assert.ok(
    !listing.some((entry) => entry.startsWith("package/test/")),
    "no test/ ships (package.json files[])",
  );
});

test("W128: the extracted tarball's webapp module serves the prebuilt payload verbatim with zero dependencies", async () => {
  const { tarball } = packOnce();
  // A SECOND tree, under os.tmpdir() and deliberately NOT under repoRoot:
  // module resolution from here can never reach the repo's node_modules, so
  // the only way buildWebappBundle() can succeed is the prebuilt branch —
  // the lazy esbuild import would throw "Cannot find package 'esbuild'" if
  // the W127 laziness regressed to a static import. The module's only
  // imports are node builtins; if THIS import fails, that is a REAL defect
  // (report it, never work around it).
  const extracted = mkdtempSync(join(tmpdir(), "w128-extract-"));
  tempRoots.push(extracted);
  const unpacked = spawnSync("tar", ["-xzf", tarball, "-C", extracted], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(unpacked.status, 0, `tar extraction must succeed (stderr: ${unpacked.stderr})`);
  const webappDir = join(extracted, "package", "dist", "ui", "webapp");
  const bundlePath = join(webappDir, "bundle.js");
  assert.ok(existsSync(bundlePath), "the tarball carries dist/ui/webapp/bundle.js");
  const packaged = (await import(pathToFileURL(bundlePath).href)) as {
    buildWebappBundle(): Promise<{ js: string; css: string }>;
  };
  const built = await packaged.buildWebappBundle();
  // Verbatim equality against the artifacts the tarball itself shipped:
  // reading is per call from beside the module (bundle.ts's prebuilt branch),
  // so equality proves the packaged seat serves the packaged bytes.
  assert.equal(
    built.js,
    readFileSync(join(webappDir, "prebuilt.js"), "utf8"),
    "the packaged seat serves the packaged prebuilt js verbatim",
  );
  assert.equal(
    built.css,
    readFileSync(join(webappDir, "prebuilt.css"), "utf8"),
    "the packaged seat serves the packaged prebuilt css verbatim",
  );
});

test("W128: the full npm install of the tarball yields a working packaged doctor", (context) => {
  const { tarball } = packOnce();
  // The deepest e2e: a real install into a throwaway prefix — deps resolve
  // through npm (warm cache, passed explicitly so the redirected HOME never
  // touches operator state). Bounded generously; npm install is the slowest
  // step in this file. Observed environment truth (npm 12): the package's
  // own postinstall is gated behind npm's `install-scripts` approval, so a
  // green install here proves the shipped TREE works, not the lifecycle
  // hook (see the header's honesty claim (4) for the recorded latent
  // defect).
  const prefix = mkdtempSync(join(tmpdir(), "w128-install-"));
  tempRoots.push(prefix);
  const npmCache = spawnSync("npm", ["config", "get", "cache"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(npmCache.status, 0, `npm config get cache must succeed (stderr: ${npmCache.stderr})`);
  const cacheDir = npmCache.stdout.trim();
  const install = spawnSync(
    "npm",
    ["install", "--prefix", prefix, "--cache", cacheDir, "--no-audit", "--no-fund", tarball],
    { encoding: "utf8", timeout: 240_000 },
  );
  if (install.status !== 0) {
    // Honest skip: the install path is environment-dependent (registry reach,
    // lifecycle scripts). Record the OBSERVED failure as the skip reason and
    // stop — a fabricated pass here would be exactly the lie this file exists
    // to prevent.
    const observed = `${install.error?.message ?? ""} ${install.stderr}`.trim();
    context.skip(`npm install of the tarball failed in this environment (status ${install.status}): ${observed.slice(0, 2000)}`);
    return;
  }
  const bin = join(prefix, "node_modules", "workflow", "dist", "cli", "workflow.js");
  assert.ok(existsSync(bin), "the install landed the compiled launcher bin");
  // A redirected HOME for the doctor's whole run — the packaged bin must be
  // self-sufficient (resolution walks up into the prefix's node_modules) and
  // must not read or write the operator's ~/.workflow state.
  const home = mkdtempSync(join(tmpdir(), "w128-home-"));
  tempRoots.push(home);
  const doctor = spawnSync(process.execPath, [bin, "doctor"], {
    encoding: "utf8",
    timeout: 120_000,
    cwd: prefix,
    env: { ...process.env, HOME: home },
  });
  assert.equal(
    doctor.error,
    undefined,
    `the packaged launcher spawned cleanly (${doctor.error?.message ?? "no spawn error"})`,
  );
  assert.ok(
    doctor.stdout.includes("Workflow doctor"),
    "the packaged launcher dispatched the doctor verb and rendered its report",
  );
  assert.ok(
    doctor.stdout.includes("settings documents"),
    "the rendered report carries the doctor's checks (runDoctor's first push)",
  );
  assert.ok(
    doctor.status === 0 || doctor.status === 1,
    `exit ${doctor.status} (signal ${doctor.signal}) — the doctor's honest exits are 0 (pass/warn) and 1 (fail rows); anything else is a crash of the packaged tree`,
  );
});