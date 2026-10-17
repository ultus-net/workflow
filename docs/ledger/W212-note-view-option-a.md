# W212: the hub Note view (decision-brief Option A)

Status: implemented, pending review. Branch `feat/w212-note-view`.

## Problem

The hub had no note data source and no note view: the Workspace view (W197)
is deliberately a listing that "never reads file contents"
(`src/integrations/hub-http.ts`), and the bounded evidence content store
(W158) is a 24-entry preview buffer, not a note store. The decided design is
Option A of `docs/decision-brief-seam-stores.md` (workspace-file convention):
augur-produced notes are markdown files under a `notes/` subtree of the
shared assistant workspace; the hub adds a bounded, path-confined listing +
content read plus an admission sidecar; the web UI renders a Note view.
"Fabricates nothing": every absent/unknown/withheld case is a named absence
or an honest 4xx, never a fake empty success.

## Finalized wire contract

Two operator-token, POST-only routes on the hub's loopback bridge, gated on
the SAME `WORKFLOW_ASSISTANT_WORKSPACE` env that gates `/workspace` (no new
env var). Unset: both routes 404 (capability withheld, fail closed).

- `POST /notes` -> `{ notes: { root, truncated, entries: [{ name, byteSize, modifiedMs, meta }] } }`
  - `root` = `<WORKFLOW_ASSISTANT_WORKSPACE>/notes` (absolute).
  - `.md` files only; entry cap 500 with `truncated: true` when the bound is
    hit; sorted by name with plain code-unit `<` (locale-independent); every
    entry `lstat`-resolved (symlinks skipped, never followed); never recursed.
  - `meta` is the parsed admission sidecar `<slug>.json` beside `<slug>.md`,
    shape `{ title?, source?, producedAt?, runId?, blocked?, findings? }`;
    a missing, malformed, or wrong-typed sidecar is `meta: null` (the view
    shows the filename and marks metadata absent — never fabricated).
- `POST /note-read`, body `{ name }` -> `{ note: { name, byteSize, modifiedMs, meta, body } }`
  - `name` must be a bare `.md` basename: separators (`/` and `\`), `..`,
    absolute paths, empty basenames, and non-`.md` names are 400 with the
    confinement rule named.
  - Unknown note (also: symlink or non-regular) -> 404 `{ error: "not found" }`.
  - Over the per-note byte cap (256 KiB, mirroring the W158 evidence store)
    -> 413 with the real byte count; never a truncated body.
- Method/class invariants: the hub's POST-only gate makes a GET 401; the
  verifier credential is refused (operator-token class only).

The web service bridges the browser's GET onto the hub's POST-only reads:
`GET /api/notes` (fail-closed `{ notes: null, reason }`, like the workspace
relay) and `GET /api/note?name=...` (hub statuses pass through verbatim:
200 / 400 / 404 / 413; 503 with the reason when no hub). The browser never
holds a hub token.

## What shipped

- **Store** `src/integrations/note-store.ts` (new): the bounded, path-confined
  store behind both routes — injectable root, `.md`-only listing, defensive
  sidecar parse, confinement-before-resolution read, honest `unknown` /
  `over-cap` outcomes.
- **Hub routes** `src/integrations/hub-http.ts`: `assistantNotes` /
  `assistantNoteRead` capability fields on `HubRequestContext` and
  `HubBridgeCapabilities` (a field, never a positional, per the post-#330
  extension discipline), and the `/notes` + `/note-read` handlers.
- **Capability composition** `src/cli/hub.ts`: the store is composed beside
  the workspace capability from the same env gate and passed into the bridge.
- **Web relay** `src/ui/web.ts`: `hubNotes` + the `GET /api/notes` /
  `GET /api/note?name=...` routes.
- **View** `src/ui/webapp/note-view.tsx` (new): the full state cycle —
  loading / error (reason verbatim) / empty / populated / truncated, the
  metadata-absent marker, plus the selected note's loading / error / body
  cycle (the hub's honest 413 refusal renders verbatim). Concatenation only,
  no template literals (the src/ui convention).
- **Shell/app wiring**: `src/ui/webapp/shell.tsx` gains the `notes` view
  (union, `APP_VIEWS`, titles, `/notes` command, rail entry in the Assistant
  group with a document glyph); `src/ui/webapp/app.tsx` polls the list beside
  the workspace listing and fetches one note's body per selection (selection
  state is UI-local).
- **augur writer** `src/cli/augur.ts`: `augur note --out <path>.md` also
  writes `<path>.json` with `{ source, producedAt, blocked, findings }` —
  only facts the run produced (an unknown field like `runId` stays absent).
  The default stdout behavior and every flag's semantics are unchanged.

## Acceptance criteria

- [x] A temp-dir temp-`notes/` subtree lists `.md`-only, bounded, name-sorted
  entries with sidecar metadata, through `POST /notes` verbatim.
- [x] `POST /note-read` returns the body verbatim; 400 confines traversal,
  absolute, and separator names; 404 answers unknown; 413 refuses over-cap
  with the count.
- [x] Both routes 404 when the capability is withheld; the verifier
  credential is 401; GET is 401.
- [x] The view renders loading / error / empty / populated / truncated /
  metadata-absent, and the selected note's loading / error / body states.
- [x] `augur note --out note.md` writes the sidecar; stdout mode writes none.
- [x] `test/ci-suites.txt` stays sorted (pinned by the manifest test).

## Evidence

- `node --import tsx --test test/note-store.test.ts` — 9 pass, 0 fail.
- `node --import tsx --test test/hub-assistant-note.test.ts` — 8 pass, 0 fail.
- `node --import tsx --test test/note-view.test.ts` — 9 pass, 0 fail.
- `node --import tsx --test test/webapp-shell.test.ts test/ci-suites-manifest.test.ts` — 23 pass, 0 fail.
- `node --import tsx --test test/hub-assistant-workspace.test.ts test/hub-assistant-routes.test.ts test/hub-assistant-tool-route.test.ts test/workspace-view.test.ts test/web-service.test.ts` — 29 pass, 0 fail.
- `node --import tsx --test test/webapp-surface.test.ts test/webapp-degraded-copy.test.ts test/webapp-shell.test.ts` — 74 pass, 0 fail.
- `npm run typecheck`, `npm run lint`, `npm run build` — clean.

## Notes

- TASKS.md is operator-frozen ("new work items are NOT appended here
  anymore"); like W208–W211 this item's record lives here and in
  `docs/FEATURES.md` only.
- The `runId` sidecar field is wired but not yet produced: `augur note` has
  no run id at write time, so the field stays honestly absent until a run
  wrapper supplies one.
