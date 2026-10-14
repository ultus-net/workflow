# W195 — the hub Routes view (hub page overhaul, slice 1)

Date: 2026-10-15. Status: implemented. Branch: `feat/hub-augur-overhaul`.

## Why

The hub (`hub.ultus.net`, `src/ui/webapp/**`) is the control-plane management
UI. The augur build adds an assistant dimension the hub did not carry: three
skills/routes (`coding | tutor | care`), the identity → route binding
(`x-workflow-user`), and the care route's withheld capability set. Slice 1 makes
that dimension visible: a read-only **Routes** page.

## The three-layer read

A hub read crosses three layers; the Routes read adds one endpoint at each,
mirroring `/snapshot` and `/board/tasks` exactly.

1. **Hub daemon route** — `src/integrations/hub-http.ts`,
   `POST /assistant/routes`. The hub is **POST-only**: `handleRequest` rejects
   every non-POST method with `401` before dispatch (pinned by W128/W133/W135),
   so the read is POST-class like every other read. Optional capability
   `assistantRoutes?: (() => AssistantRouteSummary) | undefined` on both
   `HubRequestContext` and `HubBridgeCapabilities` (the post-#330 extension
   point is a field, never a positional). Absent → `404 { error: "not found" }`
   (capability withheld, fail closed).
2. **Web relay** — `src/ui/web.ts`, `hubAssistantRoutes` calls
   `hubPost("/assistant/routes", {})` and serves `GET /api/assistant/routes`
   (the browser path is GET; the hub path is POST; the relay bridges them).
   Fail-closed like `hubBoard`: a non-200 or absent payload returns
   `{ routes: null, reason }`, never fabricated data.
3. **Webapp view** — `src/ui/webapp/routes-view.tsx` (new), polled through
   `useOperatorSurfaces` (`app.tsx`) on the schedules lane, reachable from the
   shell rail (`shell.tsx`: `AppView`, `APP_VIEWS`, `SHELL_VIEW_TITLES`,
   `commandView`, `RoutesIcon`, the `Automation` group).

## What the view surfaces (and what it refuses to)

- One card per route: the route name, the identities bound to it, and its
  withheld set.
- The withheld set comes from **config** (`WORKFLOW_CARE_WITHHELD`,
  comma-separated, read only for the `care` route), never invented. An empty
  set renders the honest "nothing withheld"; `coding`/`tutor` are always empty.
- The full state cycle renders: loading (`routes === undefined`, no reason),
  error (`reason`), empty (a hub reporting no routes), populated.
- Composition is fail-closed at hub start: a malformed config named by
  `WORKFLOW_ASSISTANT_ROUTES` throws (the same behavior the M1 gateway has);
  an unset env withholds the capability and the route 404s.

## Design discipline

Dashboard context, not a landing page. One accent (`--accent`), existing tokens
only (`--surface`, `--border`, `--text-muted`), one shape scale, no emoji, no
new font/radius, dense and low-motion. New CSS is confined to `.routes-*`
classes in `styles.css` layered over the existing `session-card` / `sessions-*`
primitives.

## Verification

- `npx tsc -p tsconfig.json --noEmit` → 0
- `node --import tsx --test test/hub-assistant-routes.test.ts` → 4/4 (200 +
  verbatim summary; 404 when absent; verifier credential refused; GET → 401)
- `node --import tsx --test test/e2e-hub-routes.test.ts test/webapp-surface.test.ts
  test/p6-hub-answer.test.ts test/webapp-shell.test.ts` → green
- `npx eslint src test` → 0

New test appended to the curated `test:ci` list. Ledger numbering: W192/W193/
W194 are taken; W195 is next free.
