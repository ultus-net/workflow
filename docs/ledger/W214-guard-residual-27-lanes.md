# W214: port the three absent SECURITY lanes from residual #27 (issues #539/#540/#541)

Status: implemented, pending review. Branch `feat/w214-guard-residual-27`.

## Problem

Security-assurance residual #27 (`docs/SECURITY_ASSURANCE.md`, C2 corpus↔port
provenance audit): three upstream enforcement lanes from the vendored corpus
(`mcp-toolbox/vendor/opencode-workflow-guard/`, the PROVENANCE tree, not
statically linked) were absent from the operative guard (the app port
`mcp-toolbox/apps/workflow-guard-mcp/src/` + its byte-identical in-process copy
`src/integrations/guard-policy/`, pinned by `test/guard-policy-drift.test.ts`).
All three were defense-in-depth, pre-existing on `main`. This slice ports them
with behavioral parity to upstream, fail-closed on unresolvable/variable paths.

## The three lanes, upstream → port

**#539 — secret-file READ denial (upstream `policies/secrets.ts`).**
- `secretFileReadIn(segment, workspaceRoot?)` ported into
  `path-policy.ts`: the `SECRET_READ_COMMAND_RE` / `SIMPLE_FILE_READ_COMMAND_RE`
  class regexes (copied verbatim, modulo the `\/`→`/` character-class
  desugaring the repo's `no-useless-escape` lint requires — semantically
  identical), the operand scan for cat/head/tail/…, and the `dd if=` form.
  Upstream resolves operands against an ambient workspace root; the port has
  no ambient state, so the root is a parameter and name/realpath matching
  rides the port's `checkSecretPath` (the upstream `isSecretPath` equivalent —
  same SAFE_ENV_FIXTURE exemption, same realpath awareness).
  `unwrapShellCommand` from upstream's lib maps to the port's
  `unwrapShellWords` (same wrapper-transparency purpose).
- The shell lane check runs in `policy.ts` `evaluatePolicy` between the
  tamper/boundary classification and the interpreter payload checks
  (upstream's dispatcher order): per segment of
  `splitShellSegments(decodeShellEscapes(command))`, deny `secret-read` with
  the secret path as `matched` (W121).
- The `read`/`read_file` tool seat: `GuardAction` gained `"read"`; the read
  lane denies `checkSecretPath` targets (`policy: "secret-read"`) and, for
  `.env` files, appends the masked variable schema hint
  (`generateMaskedEnvSchema`, best-effort read of the workspace file —
  an unreadable target carries no mask, never fails open). `isEnvFilePath`
  also ports into `path-policy.ts`. The app MCP schema enum grew `"read"`
  (`server.ts`); the generated Server Card was regenerated
  (`.well-known/server-card.json`, one line) via `pnpm run cards:generate`.
- The in-process seat maps `read` / `read_file` / `fs/read_text_file`
  (`src/integrations/mcp-toolbox-guard.ts` READ_TOOLS); the previously pinned
  "delegated reads are not guard-gated" assertion flipped to the new mapping
  in `test/mcp-toolbox-guard.test.ts`.

**#540 — destructive-content-on-WRITE scan (upstream `policies/destructive.ts`).**
- `liveMutationIn(command)` ported into `shell-policy.ts` — it unifies the
  port's OWN destructive detection surface (the same `destructivePatterns` and
  the same three normalization variants `checkShellPolicy` runs), so a written
  script body is classified by exactly the shapes the shell lane would deny.
- `extractEditContent(input)` ported into `shell-policy.ts` (upstream shape:
  `content`/`newString`/`patchText`/`patch`/`diff` + `changes[].content`).
- The `file_write` lane in `policy.ts` runs the scan after the secret-content
  check and before the protected-branch gate (upstream's lane order): per
  content, per line, skipping `#` / `//` / `/*` / `*` comment lines (upstream's
  comment skip), deny `live-mutation-payload` with the upstream reason text.
- `WORKFLOW_GUARD_ALLOW_LIVE` gates the scan EXACTLY as upstream: only `"1"`
  opens it (`"true"` does not — pinned by test).

**#541 — inline-interpreter workspace-escape / secret-read (upstream `policies/interpreter.ts`).**
- `outsideWritePathInPayload(payload, root)` ported into
  `interpreter-policy.ts`: destination-class `isPathOutsideWorkspace` over
  every write-target candidate. The port's boundary classifier already fails
  closed on unresolvable `$VAR` targets (treated as outside), matching
  upstream's hasUnresolvableVariable posture.
- `secretPathInPayload(payload, workspaceRoot?)` ported into
  `interpreter-policy.ts`: the file-access-verb gate + token scan against
  `checkSecretPath`.
- `writeTargetPatterns` completed to the full upstream ten (Ruby File/IO
  writes and opens, two-argument rename/copy forms for node and Python,
  pathlib write/replace forms joined the previously ported four).
- `checkInterpreterPolicy` per-payload order follows upstream's dispatcher:
  escape first, then the secret-path lane, then the wider protected-token scan
  and the write-target loops. Existing `interpreter-secret-path` /
  `interpreter-guard-tamper` attributions are unchanged (they carry no
  workspace root, so the root-gated escape check cannot precede them).

## Copy regeneration (the hard constraint)

Every app-port module edit was followed by `cp` into
`src/integrations/guard-policy/` (the four changed modules:
`path-policy.ts`, `policy.ts`, `shell-policy.ts`, `interpreter-policy.ts`,
plus `redirect.ts` for the three new deny-redirect entries). Evidence the
drift test is green:

```
$ node --import tsx --test test/guard-policy-corpus-coverage.test.ts test/guard-policy-drift.test.ts
# tests 14
# pass 14
# fail 0
```

## COVERAGE.json / VENDOR.md / coverage-test flips

- `COVERAGE.json`: `secrets.ts`, `destructive.ts`, `interpreter.ts`
  dispositions `partial` → `ported` with dated W214 notes (modules widen to
  include `policy.ts` where the lane seats).
- `VENDOR.md`: the "Honest gap" bullet becomes the "Residual #27 lanes
  PORTED" record; the drift-control bullet describes the present-pinning.
- `test/guard-policy-corpus-coverage.test.ts`: the `ABSENT_SECURITY_LANES`
  record inverted — `PORTED_SECURITY_LANES` pins each operator PRESENT in the
  app port (a silent unport fails here too), and the `partial` disposition of
  the carrying file must not name a ported operator as missing. Test title
  renamed; the `docs/SECURITY_ASSURANCE.md` S10 citation updated to match
  (checker test #4 green).
- `docs/SECURITY_ASSURANCE.md` #27: dated RESOLVED disposition appended (the
  entry keeps its number; the count stays 27); the S10 claim row's record of
  the absent lanes updated.
- `docs/FEATURES.md`: the Hub-guard-interception row gains the dated W214
  addendum naming the modules + tests; the assurance-case row's residual list
  now names #27 as dispositioned.
- `src/integrations/mcp-toolbox-guard.ts` header comment no longer records
  the three lanes as absent.
- The W187 as-found-allow pin in the app test flipped under its own queued
  disposition: `cat ~/.aws/credentials` and `cat /home/node/.ssh/id_rsa`
  deny at `secret-read`; `cat /etc/passwd`, `head /etc/shadow`,
  `grep -r PRIVATE …` stay baseline allow (reads of NON-secret paths stay
  the pod boundary's concern, not the guard's).

## Acceptance commands + real results

Red-first evidence (after writing the five W214 tests, before any src change):

```
$ node --test --import tsx test/policy.test.ts   (mcp-toolbox/apps/workflow-guard-mcp)
not ok 21 - W214: the shell lane denies secret-file reads (ported secretFileReadIn)
not ok 22 - W214: the read tool seat denies secret paths and offers a masked .env schema
not ok 23 - W214: file_write content cannot smuggle live destructive commands past the shell lane
not ok 24 - W214: WORKFLOW_GUARD_ALLOW_LIVE gates the destructive-content scan (upstream override)
not ok 25 - W214: inline interpreter payloads cannot escape the workspace or read secrets
# tests 132
# pass 127
# fail 5
```

Green after the port:

```
$ node --test --import tsx test/policy.test.ts   (same dir)
# tests 132
# pass 132
# fail 0

$ npm run toolbox:verify        # pnpm typecheck + build + test, all 18 workspace projects
exit=0 (no failing package; workflow-guard-mcp app suite 132 policy + 12 other tests green)

$ node --import tsx --test test/guard-policy-corpus-coverage.test.ts test/guard-policy-drift.test.ts test/mcp-toolbox-guard.test.ts
# tests 28
# pass 28
# fail 0

$ node --import tsx --test test/hub-guard-interception.test.ts test/assistant-tool-executor.test.ts test/hub-assistant-tool-route.test.ts
# tests 25
# pass 25
# fail 0

$ npm run lint        # clean (0 errors)
$ npm run typecheck   # clean
$ npm run build       # clean
```

Environment note (the toolbox arrived unbuilt in this checkout — no `dist/`
anywhere): `npm run toolbox:build` ran first, once; subsequent
`toolbox:verify` runs are green from the same build.

## Deviations / partial-port notes (stated, not hidden)

1. **Force-push is not part of the blind content scan.** Upstream's
   `liveMutationIn` tests the force-push shapes blindly; the port's shell lane
   deliberately replaced those shapes with the W108 destination-aware
   classification (context facts decide allow/deny). The ported
   `liveMutationIn` unifies only the port's blind destructive surface: a
   feature-branch force-push is an allowed shell operation, so written content
   may describe it; a protected or unresolvable force-push target denies at
   the shell lane at execution. Recorded in COVERAGE.json's destructive.ts
   note and in `docs/SECURITY_ASSURANCE.md` #27's disposition.
2. **`\/` → `/` desugaring in `SECRET_READ_COMMAND_RE`.** The port's eslint
   `no-useless-escape` rejects `\/` inside character classes; the escape is
   semantically null there. Note left in `path-policy.ts`.
3. **No `read`-class routing change in the ACP permission broker.** The seat
   maps read tools to `action: "read"`, but whether an ACP host routes
   non-mutating read calls to the guard at all is the broker's read-kind
   exemption (`src/adapters/acp.ts` KNOWN_READ_TOOLS) — unchanged and outside
   this slice's scope. The lane closes the guard-side gap; host routing of
   read calls stays as found.
4. **Pre-existing environmental failure, not from this change:**
   `test/security-assurance.test.ts` subtest "the FEATURES.md toolbox server
   count matches the vendored app corpus" fails in this working tree because
   three RETIRED apps (`egress-audit-mcp`, `review-accountability-mcp`,
   `verification-accountability-mcp`) leave `dist/`+`node_modules/` debris
   directories under `mcp-toolbox/apps` (on-disk 18 vs tracked-at-HEAD 15,
   both advertised as 15). The debris predates this branch (Sep/Oct mtimes,
   `git ls-tree` confirms); its test inputs are untouched by this diff. All
   eight claim-bearing subtests pass, including the residual-count pin at 27
   and the renamed coverage-test citation. The debris dirs were left in place
   (not mine to delete without direction).
5. **`test/ci-suites.txt` untouched** — no new root `test/` files (the new
   behavioral tests live in the app-port suite).
