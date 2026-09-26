<!-- Ledger fragment: extracted from TASKS.md at line 4440 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W128 - The e2e stream: the hub contract, the compiled web service's API, and the real packaged install (Complete - three surfaces, three parallel subagents; the packaged e2e's first run found and fixed a real shipped-nowhere postinstall target) (2026-09-24)

**Source:** the operator's direction ("a set of sub agents start to
write e2e testing to start catching bugs"), landing on the honest gaps
W125-W127 left: the compiled seats proved START + teardown (the sweeps)
but not BEHAVIOR (the source seat's API tests never ran against dist —
LESS-0012's divergence class), and the packaged install had never been
run at all (W127 recorded the residual).

**What landed:** three e2e files written by three parallel subagents
(each owning exactly one file, each under the LESS-0051 safety
contract):
- `test/e2e-hub.test.ts` — the compiled hub's discovery contract and
  HTTP surface: the discovery file's shape per workflow-hub.ts's write,
  the /health probe, the authenticated canonical route, the honest
  refusal of the unauthenticated shape, and the clean teardown's
  discovery/verifier/lock unlink, all under the redirected HOME with the
  vendored guard seat self-healed per W120.
- `test/e2e-web-service.test.ts` — the compiled web service's API flow:
  the shell page, /api/snapshot's observed shape, a kernel transition
  through POST /api/transition reflected in the next snapshot, and
  /app.js + /app.css served BYTE-FOR-BYTE equal to the W127 prebuilt
  artifacts (the composition executed over real HTTP).
- `test/e2e-packaged-seat.test.ts` — the real tarball: `npm pack`, the
  shape pin (the prebuilt artifacts and the launcher bin present; no
  src/ or test/ trees), the extracted tarball's webapp module executing
  with ZERO dependencies (a tree outside the repo, so node_modules can
  never resolve — the W127 laziness executed for real), and the full
  `npm install` of the tarball into a prefix followed by the packaged
  doctor from the installed bin.

**Discovered and fixed — the e2e stream's first shipped-nowhere
defect:** the packaged e2e's runs found that `package.json`'s
`postinstall` runs `node scripts/prepare-tool.mjs` but `files[]` shipped
no `scripts/` entry — every lifecycle-executing tarball install would
fail at postinstall with ENOENT (masked in this environment only by
npm 12's install-scripts gate, which skips lifecycle scripts by
default). Fixed: `files[]` ships `scripts/prepare-tool.mjs`; the shape
pin now enforces the postinstall target's presence. The hook's own
execution remains an npm-12-gated residual (recorded, not faked).

**Discoveries recorded (observed truth, pinned):** the hub's
authenticated snapshot serves an EMPTY tasks projection on a fresh hub
— the seeded "interactive" placeholder is suppressed by run-registry's
hiddenSnapshotTaskIds (the doctor-era seed is not user-facing state);
hub-http refuses every non-POST method with 401 — the health probe is
POST+Bearer, never GET (hub-client.ts's probeHub); the web service's
seed literals read BLOCKED but the live API serves W001 READY (the
kernel's dependency recompute — correct-by-design, a source-reader trap
worth naming).

**Acceptance criteria:**
- [x] 5/5 e2e green (hub, packaged ×3, web service); 18/18 across the
      whole compiled-seat suite (9 sweep bins + 2 W125 + 2 W127 + 5
      W128); lint + typecheck exit 0.
- [x] The postinstall target ships and the shape pin enforces it (the
      defect fixed in the loop that found it).
- [x] Every file under the LESS-0051 safety contract (no agent/PTY
      spawns; redirected HOME; ephemeral ports; controlled SIGTERM with
      pinned teardown exits; spawnSync-timeout only for self-exiting
      processes).
- [x] Hold-outs 29/29 (web + W124).

**Residuals (recorded, not fixed):** the postinstall hook's own
execution is npm-12-gated (the pin proves the shipped tree, not the
lifecycle run); the TUI surfaces' real-driver e2e stays out of bounds
(agent spawns); the fleet-install flow from a packaged tree is now
partially covered (install + doctor) — its remaining flows queue behind
the P6 npm-pack verifier debt (human-gated).
