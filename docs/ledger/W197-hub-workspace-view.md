# W197 — the hub Workspace view (hub page overhaul, slice 2)

Date: 2026-10-15. Status: implemented. Branch: `feat/hub-augur-workspace`.

## Why

Slice 1 (W195) added the Routes view. The decision record names a second gap
the overhaul must close: **no `augur-workspace` surface**. The shared Azure
Files share `augur-workspace` is mounted at the plane's workspace root
(`/workspace`, `infra/modules/plane.bicep`; csh-dev PR 1174), but the operator
cannot see what the plane and the assistant are working on together. Slice 2
adds a read-only **Workspace** page.

## The three-layer read

Mirrors the W195 Routes read exactly (a hub read crosses three layers).

1. **Hub daemon route** — `src/integrations/hub-http.ts`, `POST /workspace`.
   The hub is POST-only (`handleRequest` rejects non-POST with 401 at the gate),
   so the read is POST-class like `/snapshot` and `/assistant/routes`. Optional
   capability `assistantWorkspace?: (() => AssistantWorkspaceListing) | undefined`
   on both `HubRequestContext` and `HubBridgeCapabilities` (the post-#330
   extension point is a FIELD, never a positional). Absent -> the route 404s
   (capability withheld, fail closed). The wire answer is `{ workspace: <listing> }`.
2. **Web relay** — `src/ui/web.ts`, `hubAssistantWorkspace` calls
   `hubPost("/workspace", {})` and serves `GET /api/workspace` (the browser path
   is GET; the hub path is POST; the relay bridges them). Fail-closed like
   `hubAssistantRoutes`: a non-200 or absent payload returns
   `{ workspace: null, reason }`, never fabricated data.
3. **View** — `src/ui/webapp/workspace-view.tsx`, `WorkspaceView`, wired into
   `shell.tsx` (the `AppView` union, `APP_VIEWS`, `SHELL_VIEW_TITLES`, a rail
   entry in the `Automation` group, an icon) and `app.tsx` (poll + state + the
   view branch). Full state cycle: loading / error / empty / populated, plus the
   truncated notice.

## The bounded listing (`src/cli/hub.ts`)

Opt-in via `WORKFLOW_ASSISTANT_WORKSPACE` (absolute path to the shared root).
Unset -> capability withheld, route 404s. Set:

- a non-absolute path **throws at hub start** (fail closed, the same posture
  `WORKFLOW_PLANE_WORKSPACE` takes at `src/cli/plane-config.ts:53`);
- **bounded** to `WORKSPACE_MAX_ENTRIES = 500`, `truncated: true` when the bound
  is hit;
- **`lstatSync`, never `statSync`** — a symlink is skipped, never followed out
  of the root; a vanished entry (readdir/lstat race) is skipped, not thrown;
- **no recursion** (V1 lists the root only) and **no content read** (V1 is a
  listing; there is deliberately no content-read route);
- entries sorted by name with a plain `<` comparison (locale-independent, so the
  listing is stable and testable).

## Verification (local, all green)

- `tsc -p tsconfig.json --noEmit` — 0.
- `eslint src test` — 0.
- `test/hub-assistant-workspace.test.ts` — 4/4 (GET is 401; composed capability
  answers `{ workspace }` verbatim; absent capability 404s; verifier credential
  refused).
- `test/workspace-view.test.ts` — 7/7 (four states + truncated + the two pure
  formatters).
- `test/ci-suites-manifest.test.ts` — 5/5, both new suites added in sorted order.
- Regression: the hub-routes and web-scoping lanes pass (12/12), and the
  assistant-routes / assistant-isolation / webapp-surface lanes pass (56/56).
- `node scripts/build-webapp-bundle.mjs` — 0 (the webapp still bundles).

## Note on numbering

The first executor pass labelled this work W196, which collides with the merged
ci-manifest ledger entry (`W196-ci-suites-manifest.md`). Renumbered to **W197**
here and in the source comments. W196 remains the CI suite manifest.
