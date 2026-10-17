# W217: two test-coverage debts (the W212 note relays; the composed-guard reap)

Status: implemented. Branch `feat/w217-durable-tech-debt`.

## Problem

Two durable test-coverage debts, both P2:

1. **The W212 web note relays had no web-layer test.** `src/ui/web.ts` bridges
   the browser's GETs onto the hub's POST-only note reads:
   - `GET /api/notes` -> `hubNotes()` -> hub `POST /notes` (listing), fail-closed
     `{ notes: null, reason }` (`src/ui/web.ts:210-215`).
   - `GET /api/note?name=...` -> hub `POST /note-read`, status + payload passed
     through verbatim; a missing `name` is a 400 `{ error: "invalid note
     request" }` (`src/ui/web.ts:350-355`).

   The comment at `src/ui/web.ts:341-342` claimed the care relay was "pinned
   like its neighbors", but the NOTE relays had NO web-layer test:
   `grep -rn "api/notes\|api/note" test/*.test.ts` returned nothing. The hub-side
   route was pinned (`test/hub-assistant-note.test.ts`), and the view was pinned
   (`test/note-view.test.ts`), but the RELAY between them was never exercised.

2. **The composed-guard reap-on-throw path had no direct test (issue #536).**
   `src/cli/opencode-server.ts` composes the guard fail-closed, then every
   failure path after composition must reap it explicitly (`await guard.close()`
   before rethrow — the W094 contract, comments at `:266-287`). Only a generic
   source-regex asserted the pattern (`test/opencode-server-launcher.test.ts`);
   nothing DROVE the real throw and observed the reap. Issue #536 flagged the
   constraint that spawning the whole server to drive the throw is
   environment-heavy, so a seam at the reap point may be required.

## What landed

### Item 1: `test/web-note-relay.test.ts` (the production-path pin)

A new suite composing a REAL hub + REAL web server over one discovery dir and
fetching the relay (the W213 care-relay pattern,
`test/hub-assistant-care.test.ts:164-186`). Seven pins:

- `/api/notes` relays the hub's real listing verbatim (root, entry count,
  entry name, sidecar metadata) — a real hub + a real `createNoteStore` root.
- `/api/notes` with NO hub (an empty discovery dir) is the named absence
  `{ notes: null, reason: "hub unavailable" }` — never a fabricated table.
- `/api/notes` with the capability absent relays the hub's honest 404 as the
  named absence (`reason: "not found"`).
- `/api/note?name=<seeded>` is a 200 with the real note body and sidecar
  verbatim.
- `/api/note` WITHOUT `name` is a 400 `{ error: "invalid note request" }` at the
  relay (no hub round-trip).
- `/api/note?name=<unknown>` relays the hub's 404 verbatim (never rewritten).
- `/api/note?name=<confined-out>` (`../outside-secret.md`) relays the hub's 400
  verbatim, with the confinement-rule message intact.

Registered in `test/ci-suites.txt` in sorted position (between
`test/web-dispatch-relay.test.ts` and `test/web-scoping.test.ts`), pinned by
`test/ci-suites-manifest.test.ts`.

### Item 2: `test/opencode-server-guard-reap.test.ts` + a minimal additive seam

The real in-process guard's `close()` is a no-op
(`src/integrations/mcp-toolbox-guard.ts:123`), so the reap is unobservable
without a seam at the composition point. Rather than spawn the whole server
(environment-heavy, issue #536's stated constraint), `main` gained ONE optional
defaulted injection:

```ts
export interface OpencodeServerDeps {
  readonly createGuard?: (workspace: string) => Promise<WorkflowGuardProvider>;
}
export async function main(argv = process.argv.slice(2), deps: OpencodeServerDeps = {}): Promise<void>
```

At the composition point:
`const guard = await (deps.createGuard ?? createOpencodeServerGuard)(workspace);`

Additive and type-safe: the default is the exact real vendor composition, so an
unparameterized caller (the production `invokedDirectly` path, every other
caller) is byte-identical. No behavior change; only a seam.

The test drives the exact post-composition throw at
`src/cli/opencode-server.ts:281-284` (the upstream-key resolution) by setting
`WORKFLOW_UPSTREAM_KEY_FROM=azure-kv` with no vault name/URI, so
`resolveSecretStore` throws inside the `try`. It injects a recording guard
double and asserts: the throw propagates (never swallowed — a swallowed error
would run guardless) with the real fail-closed cause, and the guard's `close()`
ran exactly once.

The launcher's source-regex anti-drift pin was updated to the new composition
line so it still pins that `main` composes the guard.

## Gates (real output)

- `npm run lint` — exit 0.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- `node --import tsx --test test/web-note-relay.test.ts` — 7/7 pass, exit 0.
- `node --import tsx --test test/opencode-server-guard-reap.test.ts` — 1/1
  pass, exit 0.
- `node --import tsx --test test/opencode-server-guard-reap.test.ts
  test/opencode-server-launcher.test.ts` — 17/17 pass, exit 0.
- `node --import tsx --test test/ci-suites-manifest.test.ts
  test/assistant-isolation.test.ts` — 6/6 pass, exit 0.
- `node --import tsx --test test/hub-assistant-note.test.ts
  test/hub-assistant-care.test.ts test/note-view.test.ts` — 23/23 pass, exit 0.
- `git status --short` — tracked-clean before commit (only the four intended
  files tracked-dirty; untracked debris `.idea/`, the runbook plan,
  `image-digest.txt` left unstaged).

## FEATURES.md

Intentionally untouched: this slice adds tests and one internal test seam only.
No user-visible capability changed, so no FEATURES row is warranted
(no status moved, no new surface). Stating it here rather than editing the
file.

## Residuals

None for this slice. Both debts are closed. Item 2 landed as a direct test
(not a documented residual) because a clean, minimal, additive seam existed at
the composition point and the real fail-closed throw is drivable by env alone
(`WORKFLOW_UPSTREAM_KEY_FROM=azure-kv` with no vault). No production surgery
was needed.
