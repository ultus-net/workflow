<!-- Ledger fragment: opened 2026-09-30 as the P6 standalone-seat answer-route record (issue #285). Write-once — append dated supersession notes, never rewrite. -->

### P6 standalone contained-shell answer route — the seat composes a same-process broker and serves its own loopback answer route (Landed — the standalone seat is now LIVE; issue #285) (2026-09-30)

**Source:** issue #285, continuing the operator's chosen BROKER-UNIFIED answer
path. The prior iteration (`docs/ledger/P6-hub-answer.md`) made the route and
broker same-process with the HUB's containment seat, but recorded
`src/cli/contained-shell.ts:90` (the standalone interactive smoke) still
constructing `WorkflowContainedProcess` directly with no broker and no answer
route in its process — LATENT, because attaching a hold there with no route
would only add the 120s park-then-deny. This iteration makes the standalone
seat LIVE.

**Chosen wiring (the smallest correct seam; no cross-process plumbing).**

- **One shared body classifier.** `permissionAnswerRoute(broker, body,
  sessionKey?)` (`src/ui/permission-broker-route.ts`) is the ONE pending/answer
  classifier — the id-less poll (`available`/`mode`/`pending`/`pendingAsks`/
  `patterns`) and the `id`+`decision` answer — reusing the broker's SAME
  `pendingRequest`/`answer`, the W115 `transportPermissionView`, and the P10
  approvability refusal. The hub's `/api/permission` route
  (`src/integrations/hub-http.ts`) now calls it too, so the two process-local
  surfaces cannot drift (the inline copy was removed).
- **A permission-only loopback server.** `createPermissionAnswerServer(broker)`
  starts an ephemeral-port loopback server serving ONLY `POST /api/permission`,
  gated by its own bearer token; every other path/verb 404s, non-POST/bad-token
  401s, malformed body 400s. It is deliberately NOT the hub bridge: a standalone
  smoke that composes no run controller must not expose the hub's `/bash` and
  run-mutation routes.
- **The standalone seat composes it.** `src/cli/contained-shell.ts` now builds a
  `PermissionBroker`, serves its route at boot (the URL + token are stated in
  the boot banner, like the other boundary lines), threads
  `permissionBroker.askHold()` as the fourth `WorkflowContainedProcess`
  constructor argument, and closes the route in the shell's `finally`. A guard
  `ask` raised by the standalone containment seat now parks on the broker and is
  answerable at the boot-stated route — not the 120s park-then-deny.
- **`trustedRole` stays unsupplied**; no-operator fails closed unchanged.

**Red-first (no fabricated red).** `test/p6-standalone-answer.test.ts` was
captured RED against the unmodified `src` — the shared route module did not
exist. Verbatim:

```
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/ui/permission-broker-route.js' imported from .../test/p6-standalone-answer.test.ts
not ok 1 - test/p6-standalone-answer.test.ts
# tests 1 / # pass 0 / # fail 1
```

**The daemon-level end-to-end ask pin is COVERAGE, not a product red (honest).**
`test/p6-hub-ask-e2e.test.ts` drives a guard `ask` through the REAL hub HTTP
bridge's `/bash` seat, polls it on `POST /api/permission`, answers it there, and
asserts the command runs (allow) or fails closed (reject), plus the broker's own
timeout dialect. Because the hub route and the `/bash` hold landed in
`docs/ledger/P6-hub-answer.md`, that lane was already green BEFORE this change;
the pin was captured 3/3 green on the unmodified `src` and is recorded as
coverage of the landed hub lane, not dressed up as a red. It does prove the
answer path where the hub runs it (the task's "answered through it (not the 120s
park-then-deny)").

**Green:** `test/p6-standalone-answer.test.ts` 4/4;
`test/p6-hub-ask-e2e.test.ts` 3/3. Focused battery
`p6-hub-answer p6-standalone-answer p6-hub-ask-e2e p6-live-seats guarded-process
opencode-plugin permission-broker permission-approvability permission-grants
acp-session acp-workflow-resolver hub-protocol hub-snapshot web
security-assurance` **154/154 pass, 0 fail, 0 skipped** (147 pre-existing + the
4+3 new pins). `npm run lint` exit 0;
`npm run typecheck` exit 0 (both unpiped). Source-level boot smoke of the
standalone CLI could NOT be run in this worktree: the vendored
`workflow-guard-mcp` dist is absent and `createDefaultToolboxGuardProvider`
throws synchronously BEFORE its `.catch` (a pre-existing advisory-fallback
defect at `src/cli/contained-shell.ts:28`/`src/integrations/mcp-toolbox-guard.ts:232`,
not caused by this change) — so the CLI's own route boot is source-verified and
seat-pinned (pin 3 composes the real seat + broker + route), not compiled-smoked
here.

**Honest reachability (the load-bearing honesty):**

- **The standalone seat is now LIVE in its own process.** It composes the
  broker, serves the answer route, and holds on it. An operator (or automating
  surface) answers over loopback with the boot-stated bearer token. No
  cross-process bridge is invented.
- **The compiled-binary e2e is stale (pre-existing, recorded, NOT fixed here).**
  `test/e2e-hub-bash.test.ts:366` still pins the promotion-gate `ask` as an
  immediate `500 "guard denied process execution: promotion-gate: ..."`. Since
  `docs/ledger/P6-hub-answer.md` attached `broker.askHold()` to the hub `/bash`
  seat, that ask now PARKS (up to the 120s broker default) and, unanswered,
  denies with the operator-timeout provenance instead — so that compiled pin is
  now inconsistent with the landed hold. It requires a built toolbox + compiled
  dist (absent in this worktree) to run; updating it belongs to a compiled-e2e
  pass, so it is recorded as a residual rather than guessed at.
- **`trustedRole` remains unsupplied** (Q5 open); no-operator fails closed.

**Files changed:** `src/ui/permission-broker-route.ts` (new: the shared
classifier + the permission-only loopback server),
`src/integrations/hub-http.ts` (the `/api/permission` branch now uses the shared
classifier), `src/cli/contained-shell.ts` (broker + route + hold composition);
pins `test/p6-standalone-answer.test.ts` (4) and `test/p6-hub-ask-e2e.test.ts`
(3).

**Deviations:** the daemon e2e pin is coverage (above). The standalone boot
smoke is blocked by the absent toolbox dist (above). No `trustedRole`.

**Evidence:** `src/ui/permission-broker-route.ts` (the route + server);
`src/cli/contained-shell.ts` (the composition); `src/integrations/hub-http.ts`
(the shared classifier call sites); `test/p6-standalone-answer.test.ts`,
`test/p6-hub-ask-e2e.test.ts`; the P6 row's dated note
(`docs/PARKED_AND_LIMITATIONS.md`). Branch `feat/p6-standalone-answer`, issue #285.
