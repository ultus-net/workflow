import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { distArtifact, ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

// W135 — the COMPILED web service's STATIC/PWA asset contract, end to end.
// W128 pinned the compiled service's API flow and the /app.js//app.css
// byte-equality; W131 pinned the settings-document API. The PWA surface —
// the shell page's static contract, /sw.js (built in-memory by
// src/ui/webapp/pwa.ts), /manifest.webmanifest, the icons — had no
// compiled-seat e2e. The SRC seat covers a slice of it (test/web.test.ts:
// manifest name/display + icon sizes, SW parses as JavaScript, icon PNG
// magic + IHDR); this file drives the COMPILED service's real routes
// (dist/cli/web-launch.js → src/cli/web-service.ts's startWorkflowWeb →
// src/ui/web.ts's static route table) and pins the OBSERVED truth, cited
// per route to its source:
//   - GET /           200 text/html — src/ui/web.ts's PAGE literal markers
//     (doctype, lang, charset, viewport, theme-color #101216, the
//     "Workflow Control" title, the /manifest.webmanifest link, the /app.css
//     stylesheet, #root, the /app.js script) plus the html() helper's
//     content-security-policy (default-src 'self'; script-src 'self';
//     style-src 'self' 'unsafe-inline'; img-src 'self' data:;
//     manifest-src 'self'; worker-src 'self') and NO cache-control header;
//   - GET /app.js, /app.css  200 + the asset() helper's "no-cache" (the
//     served bytes are W128's byte-equality pins — not repeated here);
//   - GET /sw.js      200 text/javascript + no-cache; the served script is
//     serviceWorkerSource(version) (src/ui/webapp/pwa.ts): the
//     "workflow-shell-<12hex>" cache name whose version is sha256 of the
//     SERVED bundle bytes (web.ts's createHash("sha256").update(webapp.js)
//     .update(webapp.css).slice(0, 12) — pinned against the /app.js//app.css
//     responses this same service handed out, so a rebuilt bundle provably
//     retires the previous shell cache), the exact SHELL precache list,
//     install's addAll(SHELL)+skipWaiting, activate's stale-cache retirement
//     + clients.claim(), the fetch handler's verbatim /api/ bypass and
//     network-first-then-cache fallback; every SHELL entry answers 200 (the
//     precache list is actually fetchable, not just declared);
//   - GET /manifest.webmanifest  200 application/json — PWA_MANIFEST's full
//     field set (src/ui/webapp/pwa.ts) — and NO cache-control (the json()
//     helper sets none; recorded honestly, not blessed);
//   - GET /icon-192.png, /icon-512.png  200 image/png + no-cache — icons are
//     NEVER served from disk: renderIconPng generates them in-memory
//     (src/ui/webapp/pwa.ts), so the honest pin is the generated PNG's
//     signature + IHDR dimensions/bit-depth/color-type, per size;
//   - unknown route / wrong method  the observed 404 shape —
//     {"error":"not found"} as application/json (web.ts's trailing
//     json(response, 404, ...)): static routes are GET-only and never HTML;
//   - GET /?cachebust=…  200 with the byte-identical shell — static routes
//     match on pathname (web.ts's route-table comment: cache-busting and
//     iframe params never turn the app shell into a 404).
//
// Recorded observations, NOT fixed here (current-contract characterization,
// not blessing): the manifest route carries no cache-control while every
// sibling static asset is no-cache (a heuristic-cached manifest can lag a
// theme/icon change), and the CSP rides only the document route (assets and
// the JSON 404 carry no nosniff/XFO — same-origin fixed-shape responses, a
// residual rather than a hole).
//
// SAFETY CONTRACT (LESS-0051, non-negotiable): no agent or PTY spawns ever —
// this flow issues only static GETs, so no session channel is ever created
// and WebSessionManager's runtime factory never runs; all state lands under
// a redirected HOME (fresh mkdtemp, the hub discovery dir included); the
// server binds port 0 (ephemeral, loopback only); the browser opener is
// suppressed (--no-browser) and the stock-tab discovery is suppressed
// (WORKFLOW_OPENCODE_STOCK_TAB=0, src/cli/web-launch.ts). Teardown follows
// the W128 daemon pattern — async spawn → banner → process-group SIGTERM →
// the surface's OWN exit pinned (web-launch's shutdown handler:
// service.close().then(() => process.exit(0)) → exit 0, no signal kill) —
// never spawnSync's timeout kill, which cannot see a clean teardown
// (LESS-0051: the ETIMEDOUT trap). Process-group kill per
// src/cli/opencode-attach.ts's terminateProcessGroup, so no grandchild
// outlives the probe.

interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** PWA_MANIFEST's field set (src/ui/webapp/pwa.ts) as the route serves it. */
interface PwaManifest {
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly background_color: string;
  readonly theme_color: string;
  readonly icons: readonly { readonly src: string; readonly sizes: string; readonly type: string; readonly purpose: string }[];
}

/** The html() helper's CSP (src/ui/web.ts) — pinned verbatim as served. */
const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "worker-src 'self'",
].join("; ");

test("W135: the compiled web service's static/PWA contract — the CSP'd shell page, the bundle-derived service-worker cache, the webmanifest, and the generated icons over HTTP", async (context) => {
  ensureFresh(distArtifact("cli", "web-launch.js"));

  const home = mkdtempSync(join(tmpdir(), "w135-web-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));

  let output = "";
  let exit: ChildExit | undefined;
  const child: ChildProcess = spawn(process.execPath, [distArtifact("cli", "web-launch.js"), "--no-browser", "--port", "0"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      WORKFLOW_HUB_DIR: home,
      WORKFLOW_OPENCODE_SERVER_HOME: join(home, "opencode-server"),
      WORKFLOW_OPENCODE_STOCK_TAB: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  // The child leads its own process group (detached), so the kill reaches
  // every grandchild it spawned (src/cli/opencode-attach.ts's
  // terminateProcessGroup pattern).
  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* already exited */
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.once("exit", (code, signal) => { exit = { code, signal }; });
  context.after(() => {
    if (exit === undefined) killTree("SIGKILL");
  });

  // Wait for the startup banner (src/cli/web-launch.ts's launch log), which
  // carries the ephemeral port parsed out of it.
  const deadline = Date.now() + 20_000;
  while (exit === undefined && !output.includes("Workflow browser UI:") && Date.now() < deadline) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  }
  const banner = output.match(/Workflow browser UI: http:\/\/127\.0\.0\.1:(\d+)/);
  assert.ok(
    banner !== null,
    `the compiled web service never printed its startup banner within 20s — output: ${output.slice(0, 600)}`,
  );
  assert.ok(banner[1] !== undefined && banner[1] !== "0", `the banner must carry the real ephemeral port — output: ${output.slice(0, 600)}`);
  const port = Number(banner[1]);
  const base = `http://127.0.0.1:${port}`;
  // --no-browser took the suppressed-opener path (src/cli/web-launch.ts); no
  // browser may ever open under this contract.
  assert.ok(output.includes("Browser open suppressed"), `the suppressed-opener banner must appear — output: ${output.slice(0, 600)}`);

  // ── The operator shell: src/ui/web.ts's html() helper + PAGE literal ────
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8", "the shell rides the html() helper's exact content type");
  assert.equal(page.headers.get("content-security-policy"), SHELL_CSP, "the shell carries the html() helper's CSP verbatim — the browser-side contract the static surface is served under");
  assert.equal(page.headers.get("cache-control"), null, "the document route sets no cache-control (the html() helper's observed shape)");
  const pageBody = await page.text();
  // The PAGE literal's markers (src/ui/web.ts): the installable shell wires
  // the manifest, the stylesheet, and the bundle script.
  assert.match(pageBody, /^<!doctype html><html lang="en">/);
  assert.match(pageBody, /<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(pageBody, /<meta name="theme-color" content="#101216">/);
  assert.match(pageBody, /<title>Workflow Control<\/title>/);
  assert.match(pageBody, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(pageBody, /<link rel="stylesheet" href="\/app\.css">/);
  assert.match(pageBody, /<div id="root"><\/div><script src="\/app\.js"><\/script><\/body><\/html>$/);

  // Static routes match on pathname (src/ui/web.ts's route-table comment):
  // a cache-busting query string must still answer the byte-identical shell.
  const cacheBusted = await fetch(`${base}/?cachebust=135`);
  assert.equal(cacheBusted.status, 200);
  assert.equal(await cacheBusted.text(), pageBody, "a query string must not turn the app shell into a 404 — the same PAGE bytes answer");

  // ── The bundle routes: asset()'s no-cache header contract ───────────────
  // The bytes themselves are W128's byte-equality pins (served == on-disk
  // prebuilt artifact); this seat pins the header/status contract and keeps
  // the bytes only as the service worker's cache-version inputs below.
  const appJs = await fetch(`${base}/app.js`);
  assert.equal(appJs.status, 200);
  assert.equal(appJs.headers.get("content-type"), "text/javascript; charset=utf-8", "the asset() helper's exact content type");
  assert.equal(appJs.headers.get("cache-control"), "no-cache", "the asset() helper's cache-control on every static asset");
  const jsBytes = Buffer.from(await appJs.arrayBuffer());
  assert.ok(jsBytes.length > 0, "/app.js must be non-empty");

  const appCss = await fetch(`${base}/app.css`);
  assert.equal(appCss.status, 200);
  assert.equal(appCss.headers.get("content-type"), "text/css; charset=utf-8", "the asset() helper's exact content type");
  assert.equal(appCss.headers.get("cache-control"), "no-cache", "the asset() helper's cache-control on every static asset");
  const cssBytes = Buffer.from(await appCss.arrayBuffer());
  assert.ok(cssBytes.length > 0, "/app.css must be non-empty");

  // ── The service worker: pwa.ts's script with the bundle-derived version ─
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get("content-type"), "text/javascript; charset=utf-8", "the asset() helper's exact content type");
  assert.equal(sw.headers.get("cache-control"), "no-cache", "the SW itself must revalidate every load");
  const swBody = await sw.text();
  // The cache name carries the cache-busting version: web.ts hashes the
  // served webapp.js || webapp.css (the bytes this same service just handed
  // out), serviceWorkerSource injects it into pwa.ts's template, and its
  // sanitizer ([^a-z0-9-]) is a no-op on hex — so the observed name must
  // equal the 12-hex digest of the SERVED bundle, and a rebuilt bundle
  // provably retires the previous shell cache on activation.
  const cacheVersion = /^const CACHE = "workflow-shell-([0-9a-z-]+)";$/m.exec(swBody)?.[1];
  assert.ok(cacheVersion !== undefined, `the service worker must open with its cache name — body head: ${swBody.slice(0, 200)}`);
  assert.match(cacheVersion, /^[0-9a-f]{12}$/, `the cache version must be the unsanitized 12-hex bundle digest — got: ${cacheVersion}`);
  const expectedVersion = createHash("sha256").update(jsBytes).update(cssBytes).digest("hex").slice(0, 12);
  assert.equal(
    cacheVersion,
    expectedVersion,
    `the shell-cache version must be sha256(served /app.js || served /app.css).slice(0, 12) — got ${cacheVersion}, expected ${expectedVersion}`,
  );
  // The precache list, verbatim (src/ui/webapp/pwa.ts's SHELL): the shell,
  // both bundle halves, the manifest, and both icons.
  const shellLine = /^const SHELL = (\[[^\n]*\]);$/m.exec(swBody)?.[1];
  assert.ok(shellLine !== undefined, `the service worker must declare its SHELL precache list — body head: ${swBody.slice(0, 200)}`);
  assert.deepEqual(
    JSON.parse(shellLine) as string[],
    ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"],
    "the SHELL precache list is pwa.ts's exact literal",
  );
  // The handlers, pinned as served (pwa.ts's PWA_SERVICE_WORKER array):
  // install populates the cache and skips waiting; activate retires every
  // stale cache and claims clients; fetch bypasses /api/ and cross-origin
  // traffic verbatim, then goes network-first with the cache as the offline
  // fallback only.
  assert.match(swBody, /^self\.addEventListener\("install", \(event\) => \{$/m);
  assert.ok(swBody.includes("cache.addAll(SHELL)"), "install must populate the cache from SHELL");
  assert.ok(swBody.includes("self.skipWaiting()"), "install must skipWaiting");
  assert.ok(swBody.includes('keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))'), "activate must retire every non-current cache");
  assert.ok(swBody.includes("self.clients.claim()"), "activate must claim clients");
  assert.match(swBody, /^self\.addEventListener\("fetch", \(event\) => \{$/m);
  assert.ok(
    swBody.includes('if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;'),
    "the fetch handler's verbatim bypass: operator data (/api/) and cross-origin traffic must always be live, never cache-masked",
  );
  assert.ok(swBody.includes("fetch(event.request)"), "the shell is network-first — a fresh fetch wins");
  assert.ok(
    swBody.includes("caches.match(event.request).then((hit) => hit ?? Response.error())"),
    "the cache is only the offline fallback; a miss errors rather than fabricating",
  );
  // The precache list is actually fetchable: every SHELL entry answers 200
  // from this same service (a renamed route would strand the offline shell).
  for (const entry of ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"]) {
    const precache = await fetch(`${base}${entry}`);
    assert.equal(precache.status, 200, `the SHELL precache entry ${entry} must answer 200 — the offline shell is only as real as its routes`);
    await precache.arrayBuffer();
  }

  // ── The manifest: PWA_MANIFEST served verbatim as JSON ──────────────────
  const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  assert.equal(manifestResponse.headers.get("content-type"), "application/json; charset=utf-8", "the json() helper's exact content type");
  assert.equal(manifestResponse.headers.get("cache-control"), null, "the json() helper sets no cache-control (recorded observation, not blessed)");
  const manifest = await manifestResponse.json() as PwaManifest;
  assert.deepEqual(manifest, {
    name: "Workflow Control",
    short_name: "Workflow",
    description: "Operator surface for Workflow-authorized coding agents",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#101216",
    theme_color: "#101216",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  }, "the manifest is PWA_MANIFEST verbatim (src/ui/webapp/pwa.ts) — the shell's installability contract");
  // Cross-consistency: the manifest's icons are the routes this service
  // actually serves and the SW actually precaches.
  for (const icon of manifest.icons) {
    assert.ok(
      ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"].includes(icon.src),
      `the manifest's icon ${icon.src} must be both a served route and a SHELL precache entry`,
    );
  }

  // ── The icons: renderIconPng's in-memory PNGs, per size ─────────────────
  // No disk assets exist for these — pwa.ts renders the RGBA PNGs
  // dependency-free — so the honest per-size pin is the generated image's
  // signature and IHDR (width/height/bit-depth/color-type).
  for (const size of [192, 512]) {
    const icon = await fetch(`${base}/icon-${size}.png`);
    assert.equal(icon.status, 200, `/icon-${size}.png must be served`);
    assert.equal(icon.headers.get("content-type"), "image/png", "the asset() helper's image content type");
    assert.equal(icon.headers.get("cache-control"), "no-cache", "the asset() helper's cache-control on every static asset");
    const bytes = Buffer.from(await icon.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
    assert.equal(bytes.readUInt32BE(16), size, `IHDR width must be ${size}`);
    assert.equal(bytes.readUInt32BE(20), size, `IHDR height must be ${size}`);
    assert.equal(bytes[24], 8, "IHDR bit depth 8");
    assert.equal(bytes[25], 6, "IHDR color type 6 (RGBA, pwa.ts's encodePng)");
  }

  // ── The unknown-route contract: the trailing JSON 404, never HTML ───────
  const unknown = await fetch(`${base}/definitely-not-a-route`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("content-type"), "application/json; charset=utf-8", "the 404 is JSON, not an HTML error page");
  assert.equal(await unknown.text(), '{"error":"not found"}', "the trailing 404's exact body (src/ui/web.ts)");
  // Static routes are GET-only: a wrong method falls through to the same 404.
  const postShell = await fetch(`${base}/`, { method: "POST" });
  assert.equal(postShell.status, 404);
  assert.equal(postShell.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(await postShell.text(), '{"error":"not found"}');

  // Teardown: SIGTERM the process group and pin the surface's OWN teardown —
  // web-launch's shutdown handler is service.close().then(() => process.exit(0)),
  // so the honest exit is 0 with no signal kill (LESS-0051: the async
  // spawn → banner → SIGTERM → pinned-exit pattern).
  killTree("SIGTERM");
  const result = await new Promise<ChildExit>((resolveExit) => {
    const hardKill = setTimeout(() => {
      killTree("SIGKILL");
    }, 15_000);
    child.once("exit", (code, signal) => {
      clearTimeout(hardKill);
      resolveExit({ code, signal });
    });
  });
  assert.equal(
    result.signal,
    null,
    `the compiled web service died by ${result.signal} instead of its own SIGTERM teardown — output: ${output.slice(0, 600)}`,
  );
  assert.equal(
    result.code,
    0,
    `after SIGTERM the shutdown handler must exit 0 (service.close().then(() => process.exit(0))) — output: ${output.slice(0, 600)}`,
  );
});