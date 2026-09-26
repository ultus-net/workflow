<!-- Ledger fragment: extracted from TASKS.md at line 1583 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W081 - Session stats on the Usage page (data-lane read #2)

**Objective:** Surface the documented `GET /api/experimental/session/stats` (per-session activity,
usage, tool reliability) in the custom web UI's Usage page, read through the enforced gateway when
the server topology runs — same honest-unavailable pattern as the live MCP state.

**Depends on:** W076 (gateway + app-shell class landed).

**Acceptance criteria:**
- [x] `fetchSessionStats` in `src/integrations/opencode-live-state.ts` with the same
      discovery/probe/loopback/fail-closed contract as `fetchLiveMcp`. (**Verified 2026-09-21**
      against the as-built code: the shared `resolveLiveGateway` walk — discovery → loopback-host
      check → gateway probe → the resolved gateway — is the single honest gate both reads share;
      every unavailable outcome is an explicit reason, never a fabricated connection.)
- [x] A read-only endpoint + Usage-page block rendering the server's own stats, attributed;
      honest reasons when unavailable. (**Verified 2026-09-21**: `GET /api/usage/sessions/live`
      in `src/ui/web.ts` is read-only and honest-unavailable; the Usage page block
      (`src/ui/webapp/usage-view.tsx`) fetches it and renders the server's own aggregate —
      sessions/prompts/steps, the token split incl. cache read/write, cost, and tool
      reliability — with the unavailable reasons surfaced as values.)
- [x] Focused tests; typecheck and lint clean. (**Verified 2026-09-21**:
      `test/opencode-live-state.test.ts` (8, incl. the stats live/unavailable shapes) green;
      typecheck and lint clean. The slice had landed with its ledger boxes unticked — this pass
      reconciles the ledger to the shipped, tested implementation.)
