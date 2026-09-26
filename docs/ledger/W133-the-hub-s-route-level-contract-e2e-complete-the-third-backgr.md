<!-- Ledger fragment: extracted from TASKS.md at line 4797 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W133 - The hub's route-level contract e2e (Complete - the third background wave file: the operator/verifier token-class matrix, the schedule lifecycle, the self-improvement route shapes, and the empty-body 500 recorded) (2026-09-25)

**Source:** the second background wave's third agent (the hub-routes
deep-dive). W128 pinned discovery + snapshot + teardown; the ROUTE-level
contract — the two-credential class split, the composed schedule and
self-improvement route shapes, the refusal classes — had never been
exercised over the compiled multi-process seat.

**What landed:** `test/e2e-hub-routes.test.ts` — the compiled hub's
route contract (W128's spawn/discovery/teardown skeleton reused, not
reinvented): the token-class split BOTH directions (a verifier credential
on an operator route → 401; the operator credential on a verifier-only
route → 401 — authorization precedes body parsing AND dispatch, so those
pins move no hub state), the schedule routes' live lifecycle
(list→save→delete through the W074 registry; both refusal classes — the
route-level 400 and the registry-level 400 surfaced through the route's
client-error catch; a rejected save never partially admits), the
self-improvement routes (composed even with WORKFLOW_RSI_AGENT=0 — the
fail-closed stub arms only the loop RUNNER: zero records, an explicit
null for an unknown id, a false cancel — never a 404), the trailing 404,
and the teardown truth: the persisted schedule table is operator state
that hub.close() deliberately does NOT unlink (only discovery.json,
verifier.json, and the instance lock go).

**Discovered and queued (product finding):** an EMPTY-body request earns
a 500 from the route dispatch's catch-all — hub-http's readJson
JSON.parses a zero-byte body, so every route except /health requires a
JSON body ("{}" suffices) even for reads, and the client payload error is
classified as a server fault. Product polish queued: a 400 naming the
body requirement instead of a 500 "Unexpected end of JSON input".
Recorded honestly in the file's header, not fixed here — and the 500 pin
flips alongside that polish (it characterizes the current contract, not
a blessing of it; the round-4 review's P3).

**Acceptance criteria:**
- [x] Red/green: the agent's debugging found the 500 was ITS helper's
      omitted-body default, not a hub defect (the minimal in-process
      replica ran green; the fix was supplying the JSON body) — LESS-0054
      formalizes the protocol.
- [x] The dangerous verifier routes (/rsi/start, /schedule/run-now) are
      NEVER called with the verifier credential — pinned with the wrong
      token class only, which authorizes nothing; /rsi/start is never
      called at all.
- [x] 1/1 green (356ms first run, ~600ms after the retitle); lint +
      typecheck exit 0 (the whole-project typecheck now green — the WIP
      resolved).
- [x] The LESS-0051 safety contract: no agent/PTY spawns; all hub state
      under the redirected HOME (the schedule lifecycle mutates only the
      probe's own WORKFLOW_HUB_SCHEDULES file); port 0; process-group
      SIGTERM with the pinned exit + unlink truth.
  - Dated note (2026-09-25, W134): the empty-body 500 FIXED — see the note
    in the W133 residuals below; the pin now characterizes the repaired
    contract (the W133 entry's "pin flips alongside that polish" note
    came due).

**Residuals (recorded, not fixed):** the unreproduced one-off 400
"invalid snapshot request" mid-sequence (suspected rare
keep-alive/unconsumed-body interaction — noted by the agent, never
reproduced in ~12 runs, deliberately not pinned).
