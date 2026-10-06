<!-- Ledger fragment: opened 2026-10-06 as a post-freeze W-item backfill (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### W164 - The project container (the hub-owned project record) (Complete) (2026-09-27)

**Source:** GitHub issue #316 (closed 2026-09-28); spec `docs/superpowers/specs/2026-09-26-paperclip-dashboard-borrowings.md:255` (W164 section); landed in PR #324 (merge 2026-09-27T22:05:32Z, commit `6a60ed39`, 2026-09-27).

**What landed:**

- `src/integrations/project-registry.ts` (204 lines): `ProjectRecord` binds a provider-stable, credential-free repo identity (`ProjectRepoIdentity`: provider + `fullName` + `repoId`), a `ProjectStatus` (`active`/`paused`/`archived`), a budget envelope riding the existing W045/W118 `RunBudget`, and workspace binding(s). Persistence is a `{version:1}` table (`loadProjectsTable`/`saveProjectsTable`; atomic 0o600 writes; ENOENT -> empty; corrupt -> refusal).
- `projectScopedBoard(project, board)` gives an honest per-project board scope (only the bound repo; a foreign repo is refused, never an inferred scope).
- Hub route `POST /hub/saveProject` (`src/integrations/hub-http.ts`; schema validation via `parseProjectRecord`) and the dashboard `projects-view.tsx` (`src/ui/webapp/apps`) listing/scoping projects.

**Evidence:** `test/project-registry.test.ts` 6/6 (credential-free identity pinned by value; per-project scoping; foreign-repo refusal; single-authority surface; persistence table contract); `test/hub-project-routes.test.ts`; `test/web-projects.test.ts`; `test/webapp-surface.test.ts`. Landed on the W162 delegate carrier — the W164 registry composes with W162's `delegateBoardTask` (the `bda3d4c2` merge aligned the bridge signature).

**Cut (as spec'd):** no org charts, no goals layer, no multi-user membership.
