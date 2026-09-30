<!-- Ledger fragment: opened 2026-09-30 as the P6 "live seats" record — composing the broker-unified ask-answer hold at the two remaining seats (TASKS.md is frozen; live tracking is the GitHub Project, issue #285). Write-once record — append dated supersession notes, never rewrite. -->

### P6 live seats — composing the broker-backed hold at the two remaining seats (part-live/part-latent) (2026-09-30)

**Source:** issue #285, continuing the operator's chosen BROKER-UNIFIED answer
path (brief §4 option A): `docs/ledger/ask-answer-surface.md` landed
`PermissionBroker.askHold(sessionKey)` and composed it into the ACP permission
resolver + hub fs seat, and `docs/ledger/P6-containment-seat.md` /
`docs/ledger/P6-plugin-seat.md` landed the two remaining seats' `hold?` seams.
This iteration composes a broker-backed hold at those two seats' composition
points. Branch `feat/p6-live-seats`, based on `origin/main` (the doc says no
node_modules symlink is needed — the repo root ancestor resolves it).

**What the tree actually offers (recon, `file:line` evidence):**

| Seat | Hold seam | Production composition point | In-process broker? |
|---|---|---|---|
| containment process | 4th ctor arg on `WorkflowContainedProcess` (`src/containment/workflow-process.ts:22`) | `shellExecutorFor` (`src/integrations/run-controller.ts:111`) + the direct construction in `src/cli/contained-shell.ts:90` | **NO** — the only `PermissionBroker` construction is `src/cli/web-service.ts:66` (a different process); the hub (`src/cli/hub.ts`) and the standalone shell hold none, and there is no `/api/permission` route in either |
| in-process OpenCode plugin | 4th arg on `createWorkflowOpenCodePlugin` (`src/integrations/opencode-plugin.ts:20`) | **none** — grep finds only the definition, the `src/index.ts` re-export, and `test/opencode-plugin.test.ts` | **NO** — the plugin runs in an agent-host process, not the broker's |

**What landed (additive; one change per iteration, W097):**

- **The smallest correct seam at the containment seat's production helper** —
  `shellExecutorFor(application, fixedTaskId?, writableWorkspace = true, guard?,
  timeoutMs?, hold?)` gained the optional sixth `hold?: OperatorAskHold`
  parameter, forwarded as `WorkflowContainedProcess`'s 4th ctor arg. A caller
  that owns an in-process broker composes `broker.askHold(<sessionKey>)` there;
  absent (the hub/standalone callers today), an `ask` fails closed exactly as
  before. This is the only production helper a same-process caller would use.
- **Composition pins at BOTH seats** — the new `test/p6-live-seats.test.ts`
  composes `PermissionBroker.askHold(<sessionKey>)` at (a) `shellExecutorFor`
  and (b) `createWorkflowOpenCodePlugin(...)`'s 4th arg, and asserts a guard
  `ask` parks on the broker's ONE transport (`broker.pendingRequest(key)` carries
  the permission-card shape) and is answered there (`broker.answer(id, …)`);
  the containment pin answers `reject_once` and asserts the byte-identical
  fail-closed throw, and the plugin pin answers `allow_once` and asserts the
  tool proceeds.
- **No-operator posture unchanged** (brief Q3) — a regression fence asserts both
  seats still throw the byte-identical guard-deny messages with no hold.
- **`trustedRole` NOT supplied** (brief §5, operator-gated).

**Red-first (no fabricated red):** the containment-seat composition pin was
captured RED against the unmodified `src` (a 6th argument to the 5-parameter
`shellExecutorFor` is silently dropped at runtime, so the seat never parks).
Verbatim:

```
not ok 1 - P6 live seats: the containment seat's production helper composes the broker-backed hold
  error: "the seat never parked on the broker's unified transport"
  stack: |-
    waitForPending (test/p6-live-seats.test.ts:69:9)
    async TestContext.<anonymous> (test/p6-live-seats.test.ts:80:18)
# tests 3
# pass 2
# fail 1
```

The OpenCode-plugin composition pin was **green before and after** — its 4th-arg
seam already landed (`P6-plugin-seat`), so this pin is a composition pin, not a
product red. The no-operator fence was likewise green before and after.
`src/` was NOT modified to manufacture a red.

**Green:** `node --import tsx --test test/p6-live-seats.test.ts`
`# tests 3 / # pass 3 / # fail 0`. Focused battery
`test/p6-live-seats.test.ts test/guarded-process.test.ts test/opencode-plugin.test.ts
test/permission-broker.test.ts test/acp-session.test.ts test/acp-workflow-resolver.test.ts`
**88/88 pass, 0 fail, 0 skipped**. `npm run lint` exit 0; `npm run typecheck`
exit 0 (both unpiped).

**Honest reachability (this is the load-bearing honesty):**

- **Both remaining seats are still LATENT in production.** The broker-unified
  answer path lives in the web-service process (broker + `/api/permission` +
  the ACP runtime). Neither target seat executes in that process: the
  containment seat runs in the hub/standalone processes (no broker, no answer
  route), and the plugin runs in an external agent-host process. Attaching a
  broker-derived hold at those sites would produce an unanswerable park (a
  120s park-then-deny) — strictly worse than the current immediate fail-closed
  deny, and the task forbids inventing the cross-process plumbing that would
  carry an answer to them. The seams are therefore wired and pinned so a
  same-process caller can attach, recorded, not faked.
- **`contained-shell.ts` unchanged** — it constructs the seat directly and has
  no broker source in its process; there is nothing to thread without inventing
  a surface.
- The ACP permission resolver + hub fs seat remain the two LIVE seats on the
  broker-unified path (the web-service composes `permissionBroker` into the ACP
  runtime lane). The daemon lane stays out of process (option B).

**Deviations:** none from the task's explicit allowance — where a site
genuinely has no broker in scope, the smallest correct seam was wired and the
reason recorded rather than inventing cross-process plumbing. No `trustedRole`.

**Evidence:** `src/integrations/run-controller.ts` (the `hold?` seam);
`test/p6-live-seats.test.ts` (3 pins); the P6 row's dated note
(`docs/PARKED_AND_LIMITATIONS.md`). Branch `feat/p6-live-seats`, issue #285.
