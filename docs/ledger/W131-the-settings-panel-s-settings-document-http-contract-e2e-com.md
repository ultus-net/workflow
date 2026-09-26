<!-- Ledger fragment: extracted from TASKS.md at line 4650 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W131 - The settings panel's settings-document HTTP contract e2e (Complete - the second background wave's first file: the merged-document shape, the fail-closed write refusals, the value-never-echoed rule for the management key, and the advertised deep link's honest 404) (2026-09-25)

**Source:** the operator's standing e2e direction (the second background
wave: three parallel agents; this file from the settings agent). The
settings document (MCP servers + agent preferences, merged
global/workspace) had no behavioral coverage over the compiled seat, and
the settings verb's browser-open behavior had never been e2e-driven
headlessly.

**What landed:** `test/e2e-settings.test.ts` — the compiled
`workflow settings` driven end to end (PORT=0; the browser suppressed
through the discovered seam — the verb has NO --no-browser flag, so the
e2e uses WORKFLOW_NO_BROWSER=1 (open-browser's pre-lookup env gate) and
strips DISPLAY/WAYLAND_DISPLAY/DBUS_SESSION_BUS_ADDRESS as
defense-in-depth; the honest "No browser opener available" line is
pinned): the settings-document API's read shapes (/api/settings/mcp —
the merged servers where the workspace overlay wins per server name —
plus the vendored catalog; /api/settings/agents — the merged preferences
with presence-booleans only; /api/settings/mcp/live — the honest
unavailable state), the write refusals (a cross-site origin → 403
cross-origin mutation denied; text/plain → 415; a non-array servers body
→ 400), the valid writes (a malformed server is dropped fail-closed; the
on-disk documents land 0600-in-0700 under the redirected HOME and the
redirected workspace overlay — the real repo untouched), the
management-key value-never-echoed pin (a fake key set in the child env;
the response body greps clean), and the whole-stdout equality pin at
teardown (banner + no-opener line, exit 0).

**Discovered and queued (product finding):** `workflow settings` prints
AND opens `${service.url}/settings`, but the server has NO /settings
page route — it answers 404 JSON; the settings surface is the SPA's
settings dialog behind GET /. A real browser opening the advertised URL
lands on an error. The fix belongs in product (serve the shell at
/settings, or print the bare URL); the test pins the observed 404 until
then.

**Observation (recorded for the threat model):** the settings mutations
authenticate only via the trusted-mutation gate (origin /
Sec-Fetch-Site) — no management key, no session scope; any local
process can read/write the operator's settings document. Consistent
with the loopback-only bind (arguably by-design), stated rather than
assumed.

**Acceptance criteria:**
- [x] 2/2 green (the W130 admin e2e + this file; ~250ms each), plus the
      agent's four stability runs; lint + typecheck exit 0 for this file
      (the whole-project typecheck is transiently red from a concurrent
      agent's untracked WIP file — its gate lands with its integration).
- [x] The browser never opens (the suppression seam proven by the pinned
      stdout equality).
- [x] The settings document writes are confined to the redirected
      HOME/workspace overlay (asserted against the real repo).
- [x] The round-2 review's notes dispositioned: the no-Origin trusted path
      is now EXERCISED (the global MCP write drops its origin header —
      the prose/behavior mismatch closed), and the whole-stdout equality
      pin carries the flush-timing caveat in a comment (node flushes pipe
      stdout before exit; if a flush race ever appears, await stream
      close first).

**Residuals (recorded, not fixed):** the browser-side settings dialog
flows are pinned only at the API contract level; the same-origin PUT
variant is unpinned (node fetch's no-Origin shape is the pinned trusted
path); the dead deep link is queued (above).
  - Dated note (2026-09-25, W134): the dead deep link FIXED — the CLI
    advertises and opens the shell root (the Settings dialog lives there);
    the /settings route still 404s as the server truth (serving the shell
    at /settings is deferred because src/ui/web.ts carries the operator's
    uncommitted W115 work). The banner pin and its parse regex flipped
    with the fix.
