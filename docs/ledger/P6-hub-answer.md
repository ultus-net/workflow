<!-- Ledger fragment: opened 2026-09-30 as the P6 hub same-process answer-route record (issue #285). Write-once — append dated supersession notes, never rewrite. -->

### P6 hub same-process answer route — the containment seat composes the broker hold IN the hub process, served on the hub's HTTP bridge (Landed — the two remaining seats now attach; issue #285) (2026-09-30)

**Source:** issue #285, continuing the operator's chosen BROKER-UNIFIED answer
path. The prior iteration (`docs/ledger/P6-live-seats.md`) composed the seam at
`shellExecutorFor` and the OpenCode plugin factory but recorded both seats still
LATENT in production: the only `PermissionBroker` + `/api/permission` lived in
the separate web-service process (`src/cli/web-service.ts:66`), and the
containment seat runs in the hub / standalone processes with no broker and no
answer route. This iteration makes the answer route and the broker SAME-PROCESS
with the hub's containment seat.

**Chosen wiring (no cross-process plumbing invented).**

- **The hub bridge mounts the broker's one pending/answer transport.** A new
  optional `permissionBroker` capability (`src/integrations/hub-http.ts`) mounts
  `POST /api/permission`: an id-less body is the poll (`available` / `mode` /
  `pending` / `pendingAsks` / `patterns`), an `id` + `decision` body is the
  answer — the same two shapes the web `/api/permission` route serves, riding
  the broker's SAME `pendingRequest`/`answer`. The route reuses the W115
  `transportPermissionView` (moved to `src/ui/permission-broker.ts` so the web
  and hub routes share ONE classification); the P10 approvability refusal
  (structured 409) is preserved. Absent a broker the route 404s — capability
  withheld, fail closed. The hub bridge is POST-only by contract, so the poll
  rides POST (the id-less shape) rather than a new verb.
- **The hub composes a broker into its lane.** `src/cli/hub.ts` constructs one
  `PermissionBroker`, passes it to `createWorkflowHub` (forwarded into the
  bridge capabilities, `src/integrations/workflow-hub.ts`) and threads
  `permissionBroker.askHold()` into every containment seat it composes: the
  `containedShell` helper (the reviewer git/diff shell, the test runner, the RSI
  git runner, the scheduler lane) and the `/bash` route in `hub-http.ts`. A
  guard `ask` from any of those seats now parks on the hub's broker and is
  answerable at `POST /api/permission` — not the 120s park-then-deny.
- **A production composition root for the plugin factory.**
  `createWorkflowOpenCodePluginRoot(application, adapter, guard?, options?)`
  (`src/integrations/opencode-plugin-root.ts`, re-exported from `src/index.ts`)
  composes the plugin factory against a broker-derived hold
  (`broker.askHold(sessionKey)`) and returns `{ plugin, permissionBroker }` — the
  same-process answer surface the host owns. The plugin runs in the AGENT-HOST
  process, so its broker must be that process's own; the root composes only
  in-process objects.
- **`trustedRole` stays unsupplied** (brief §5, operator-gated). No-operator
  fails closed unchanged.

**Red-first (no fabricated red).** `test/p6-hub-answer.test.ts` was captured RED
against the unmodified `src` (no `/api/permission` route; the plugin root did
not exist). Verbatim:

```
not ok 1 - P6 hub answer route: a hub-held ask is answerable via the mounted route
  error: |-
    Expected values to be strictly equal:
    404 !== 200
not ok 2 - P6 hub answer route: a reject denies fail closed and an unanswered ask times out to reject
  error: |-
    Expected values to be strictly equal:
    404 !== 200
not ok 3 - P6 hub answer route: the plugin composition root attaches a broker-derived hold
  error: "Cannot find module '.../src/integrations/opencode-plugin-root.js' imported from .../test/p6-hub-answer.test.ts"
# tests 4
# pass 1
# fail 3
```

The 4th pin (no broker → route 404s) was green before and after — the no-operator
fence, not a product red. `src/` was NOT modified to manufacture a red.

**Green:** `node --import tsx --test test/p6-hub-answer.test.ts`
`# tests 4 / # pass 4 / # fail 0`. Focused battery
`p6-hub-answer p6-live-seats guarded-process opencode-plugin permission-broker
permission-approvability permission-grants acp-session acp-workflow-resolver
hub-protocol hub-snapshot web security-assurance` **147/147 pass, 0 fail,
0 skipped**. `npm run lint` exit 0; `npm run typecheck` exit 0; `npm run build`
exit 0 (all unpiped).

**Honest reachability (the load-bearing honesty):**

- **The containment seat is now LIVE where it runs in the hub process.** The hub
  bridge serves `/api/permission` and the hub's composed shells hold on the
  same-process broker. `src/cli/contained-shell.ts:90` (the standalone
  interactive smoke) still constructs `WorkflowContainedProcess` directly with
  no broker/answer route in its process — there is nothing to thread without
  inventing a surface, so it stays LATENT and recorded (an `ask` there still
  fails closed immediately).
- **The plugin seat attaches at the composition root.** The factory now
  composes `broker.askHold()` in `createWorkflowOpenCodePluginRoot` in
  production (not only tests), and the root returns the same-process broker as
  the answer surface. The plugin's process is the external agent host: whether
  its operator UI serves the broker's pending/answer path is the host's
  composition. The root makes the seat's hold real and its answer surface
  reachable; no cross-process bridge to the hub is invented.
- **The hub route is operator-token class** (the same read/answer class as the
  other hub routes) and remains on loopback; the accepted uncredentialed-loopback
  trust boundary (SECURITY_ASSURANCE residual #9) is unchanged.
- **The daemon lane stays out of process** (option B), as recorded in
  `docs/ledger/ask-answer-surface.md`.

**Files changed:** `src/integrations/hub-http.ts` (capability + route + `/bash`
hold), `src/integrations/workflow-hub.ts` (option forwarding),
`src/cli/hub.ts` (broker composition + `containedShell` hold),
`src/integrations/opencode-plugin-root.ts` (new), `src/index.ts` (re-export),
`src/ui/permission-broker.ts` (`transportPermissionView` co-located),
`src/ui/web.ts` (consumes the shared view); pin `test/p6-hub-answer.test.ts`.

**Deviations:** none from the task's no-cross-process allowance. The hub route
uses POST (the hub bridge's sole verb) for both poll and answer shapes. The
mirror-only [environmental]: `test/workflow-hub.test.ts`'s CLI-spawn pin is
RED in this worktree because `mcp-toolbox`'s `workflow-guard-mcp` dist is
absent/stale (the CLI refuses to start before any changed code runs) — not
caused by this change; the same battery excluding it is 147/147. No
`trustedRole`.

**Evidence:** `src/integrations/hub-http.ts` (the mounted route);
`src/cli/hub.ts` (the hub composition); `src/integrations/opencode-plugin-root.ts`
(the production root); `test/p6-hub-answer.test.ts` (4 pins); the P6 row's dated
note (`docs/PARKED_AND_LIMITATIONS.md`). Branch `feat/p6-hub-answer`, issue #285.

**2026-09-30 (dated supersession — the standalone seat is now LIVE):** the
honest-reachability line above ("`src/cli/contained-shell.ts` … still constructs
`WorkflowContainedProcess` directly with no broker/answer route … it stays
LATENT") is superseded. Branch `feat/p6-standalone-answer` composes a
same-process broker into the standalone shell, serves the shared
`permissionAnswerRoute` on a permission-only loopback server, and threads
`broker.askHold()` into its containment seat — so the standalone seat's guard
`ask` is now answerable in-process, not the 120s park-then-deny. The hub route's
inline classifier moved to the shared `src/ui/permission-broker-route.ts` (the
hub route now calls the same function). Full record:
`docs/ledger/P6-standalone-answer.md`.
