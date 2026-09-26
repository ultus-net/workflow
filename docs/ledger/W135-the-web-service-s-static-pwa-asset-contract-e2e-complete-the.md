<!-- Ledger fragment: extracted from TASKS.md at line 4907 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W135 - The web service's static/PWA asset contract e2e (Complete - the shell's CSP verbatim, the service worker's hash-derived cache version computed against the bytes the same service served, the manifest deepEqual, and all six SHELL entries answering 200) (2026-09-25)

**Source:** the third background wave (the webapp-assets agent). The
PWA/service-worker surface — the shell page's static contract, /sw.js
(built in-memory by pwa.ts), /manifest.webmanifest, the generated icons —
had no compiled-seat e2e; the browser the offline shell serves has never
had its routes proven from outside.

**What landed:** `test/e2e-webapp-assets.test.ts` — the compiled web
service's static contract: GET / (200, the html()-helper CSP VERBATIM —
default-src/script-src/style-src/img-src/manifest-src/worker-src — and
the PAGE markers: doctype, lang, charset, viewport, theme-color,
`<title>Workflow Control</title>`, the manifest link, #root, the /app.js
script); a cachebusted GET (/?cachebust=) byte-identical to / (static
routes match on pathname); /app.js + /app.css no-cache (byte-equality
stays W128's pin); **/sw.js's cache name `workflow-shell-<12hex>` where
the version equals sha256(served /app.js ‖ /app.css).slice(0,12)**
computed against the bytes the SAME service just served — a rebuilt
bundle provably retires the old cache; the exact SHELL list
(["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icon-192.png",
"/icon-512.png"]); the verbatim handler pins (install addAll + skipWaiting,
activate retirement + clients.claim, the /api/ + cross-origin bypass,
network-first with the hit ?? Response.error fallback); **all six SHELL
entries answer 200** (the offline shell is only as real as its routes);
/manifest.webmanifest deepEqual against PWA_MANIFEST; the icons' PNG
signature + IHDR (192×192 / 512×512, RGBA — generated in-memory by
renderIconPng, never served from disk, so there is no icons-absent 404
scenario); the JSON 404 shape; GET-only static routes.

**Findings recorded (not fixed):** the manifest route carries NO
cache-control while every sibling static asset is no-cache — a
heuristic-cached manifest can lag a theme/icon change (a polish
candidate); the CSP rides only the document route (the assets and the
JSON 404 carry no nosniff/XFO — same-origin fixed shapes, a residual
stated rather than assumed).

**Acceptance criteria:**
- [x] 1/1 green twice (503-524ms); lint + typecheck exit 0.
- [x] The SW version derivation verified against the observed hash
      (c303105a02fb = the computed sha256 slice).
- [x] The LESS-0051 safety contract: no agent/PTY spawns; redirected
      HOME; ephemeral port; async spawn → banner → SIGTERM → pinned exit.

**Residuals (recorded, not fixed):** the manifest cache-control polish;
the asset/404 header residuals (above).
