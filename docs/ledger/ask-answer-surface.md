<!-- Ledger fragment: opened 2026-09-30 as the unified ask-answer surface record (issues #285/#283). Write-once — append dated supersession notes, never rewrite. -->

### Ask-answer surface — a guard `ask` from any in-process seat is answerable through the EXISTING broker / `POST /api/permission` path (Landed — broker-unified, the operator's chosen path; issues #285/#283) (2026-09-30)

**Source:** issues #285 (P6 ask channel) and #283 (P4 W111). The operator chose
the **BROKER-UNIFIED answer path** (brief §4 option A) over a second surface:
one answer surface, the broker's existing `/api/permission` poll/answer, carries
a held ask exactly as it carries a permission prompt. Design input:
`docs/P6_SEATS_ASK_DESIGN_BRIEF.md` §3 (hold semantics) and §4 (option A);
`src/ui/permission-broker.ts`; `src/integrations/operator-ask-hold.ts`.

**Chosen wiring (no second route, no second poll).** The landed seats
(`src/adapters/acp-workflow-resolver.ts`, `src/integrations/acp-session.ts` fs
server, `src/integrations/opencode-plugin.ts`) already accept an
`OperatorAskHold` and park a guard `ask` on it — but no composition supplied
one, so production asks failed closed everywhere. This change makes the broker
itself the hold:

- `PermissionBroker` gains `parkAsk`/`answerAsk`/`pendingAsks`/`cancelAsks` and
  `askHold(sessionKey)`. A held ask is stored as an ask-kind park in the SAME
  `#parked` map that holds permission prompts, projected through the SAME
  `pendingRequest()`/`transportPermissionView` the `/api/permission` GET serves,
  and resolved by the SAME `answer()` the POST drives. Choices map
  tighten-never-loosen (any allow → `once`, reject → `reject`); a reject/timeout
  denies fail closed; an early reply is remembered and consumed by its park.
  The approvability cap and always-* tool patterns stay permission-prompt-only —
  an ask is a policy decision, not a tool pattern.
- `PermissionBroker.askHold(sessionKey)` returns the `OperatorAskHold` the seats
  already consume, so no seat signature changes: `AcpSessionDriver` derives it
  when composed with a `permissionBroker` (explicit `hold` still wins), scoped to
  its `workspaceSessionId` — the exact key the web channel polls and answers
  with. `AcpRuntimeOptions.permissionBroker` now threads into all three driver
  flavors, and the driver forwards the hold to the ACP permission resolver (the
  fs seat already used it).
- No route change: `POST /api/permission` already takes `id`+`decision` and calls
  `active.answerPermission(id, decision)`; the ask rides that. No `trustedRole`
  supplied anywhere (brief §5 stays operator-gated).

**Files changed:** `src/ui/permission-broker.ts` (ask parks + hold adapter),
`src/integrations/acp-session.ts` (broker-derived hold, resolver forwarding),
`src/integrations/acp-runtime.ts` (thread `permissionBroker` to all three
drivers); pins in `test/permission-broker.test.ts`,
`test/acp-workflow-resolver.test.ts`, `test/acp-session.test.ts`.

**Pins (red-first):** a held ask parks on the broker's pending transport and an
allow resolves it; a reject resolves reject (and records no tool pattern); the
ask answer is session-scoped; an unanswered ask times out to reject; cancel
rejects it; an early reply is consumed by its park; the ACP resolver's ask is
answerable through the broker transport; the fs seat's broker-composed driver
rides the broker transport; the existing no-operator posture (no hold → deny)
stays.

**Red capture (verbatim; `src/` stashed against the new tests):**
`node --import tsx --test test/permission-broker.test.ts test/acp-workflow-resolver.test.ts test/acp-session.test.ts`
→ `error: 'broker.askHold is not a function'` (`TypeError`,
`test/permission-broker.test.ts:272:23` … `:282:23`) and the fs-seat
broker pin failing closed; `# tests 69 / # pass 61 / # fail 8`.

**Green:** the same three files `# tests 69 / # pass 69 / # fail 0`; the focused
battery (`permission-broker`, `permission-grants`, `permission-approvability`,
`acp-workflow-resolver`, `acp-session`, `web-sessions`, `web-operator-surfaces`,
`web`) **133/133 pass, 0 fail, 0 skipped**. `npm run lint` exit 0;
`npm run typecheck` exit 0 (both unpiped).

**What remains (stated, not hidden):**

- **The seats' live attachment is partial.** The ACP runtime lane (the web/TUI
  default) now composes the broker-backed hold, covering the ACP permission
  resolver and the hub fs seat. The **in-process OpenCode plugin** seat has no
  production composition site in `src/` (it is constructed only in tests), so
  its `ask` still fails closed until a host composes it with the same
  `askHold()`. The **containment process seat**
  (`src/containment/workflow-process.ts:17`) still collapses `ask` to deny; its
  P6 work item (guard-after-authorize ordering, brief §2.4) is a separate
  iteration.
- **The daemon lane is out of process.** `opencode-server-authority.ts` owns its
  own hold in the daemon process (brief §4 option B); the broker is in-process,
  so the daemon ask is not projected here. The two share the §3 contract but the
  cross-process projection stays its own item.
- **`trustedRole` is not supplied** (brief §5, operator-gated).

**Deviations:** none from the chosen broker-unified path. The broker gained ask
primitives (`parkAsk`/`answerAsk`/`pendingAsks`/`cancelAsks`/`askHold`) rather
than the seats gaining a broker dependency, so the seat contracts are unchanged.
