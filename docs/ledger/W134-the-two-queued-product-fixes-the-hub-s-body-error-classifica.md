<!-- Ledger fragment: extracted from TASKS.md at line 4857 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W134 - The two queued product fixes: the hub's body-error classification and the settings verb's dead deep link (Complete - the wave's findings closed; the empty-body 500 is now an honest 400 and the settings verb points at the shell, not a 404) (2026-09-25)

**Source:** the e2e wave's two recorded queued findings — W133's
empty-body 500 (the hub's catch-all classified a client payload error as
a server fault) and W131's dead /settings deep link (the settings verb
printed and opened a 404). The operator's "continue tasks + e2e testing
coverage and fixes" direction.

**What landed:**
- `hub-http.ts`: a typed `HubRequestError` (the request-BODY fault class)
  thrown by `readJson` for oversized or unparseable bodies, with a NAMED
  requirement message ("a JSON request body is required (send {} for read
  routes)") — the catch-all's 400/500 split answers 400 for the client
  class and keeps 500 for genuine server faults. The W133 pin flipped
  (500 → 400 + the message).
- `workflow.ts` (the settings verb): prints and opens the SHELL ROOT —
  where the Settings dialog actually lives — instead of the dead
  `/settings` URL; the parenthetical names the seam ("the Settings
  dialog lives on the operator shell"). The W131 banner pin and its
  parse regex flipped. The deeper option (serving the shell AT /settings
  in src/ui/web.ts) is deferred: that file carries the operator's
  uncommitted W115 work (a coordination note, recorded).

**Acceptance criteria:**
- [x] Red/green: the pre-fix observations (the 500 "Unexpected end of
      JSON input"; the `/settings` 404 the verb advertised) were the
      wave's recorded findings; post-fix the flipped pins run green
      (2/2).
- [x] Regressions 80/80 across the hub unit suites (hub-rsi/hub-review/
      hub-runs), the compiled-bin sweep, the W128 hub e2e, and the web
      tests — the body-classification change did not disturb any other
      hub consumer, and the dispatcher change kept the help pins valid.
- [x] lint + typecheck + build exit 0.

**Residuals (recorded, not fixed):** the /settings route still 404s as
the server truth (the CLI no longer advertises it; serving the shell
there awaits the operator's W115 work clearing src/ui/web.ts); the
unreproduced one-off 400 remains unpinned (W133's residual); a
NON-HubRequestError body-read fault — a client aborting mid-body inside
readJson's for-await — still lands 500 through the catch-all (the
review's P3): the "body faults are client errors" claim covers oversize
+ parse failure only, exactly as stated, and the mid-abort class is
recorded here as an adjacent residual.
  - Dated note (2026-09-25, W134): the empty-body 500 FIXED — hub-http
    classifies a request-BODY fault as a CLIENT error (a HubRequestError
    answered 400 with "a JSON request body is required (send {} for read
    routes)"), and the catch-all's 400/500 split leaves 500 to genuine
    server faults. The W133 pin flipped (500 → 400 + the named
    requirement).
