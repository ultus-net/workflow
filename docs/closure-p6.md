<!-- Closure vehicle: opened 2026-09-30. Write-once — append dated supersession notes, never rewrite. -->

# Closure vehicle — P6 (issue #285) (2026-09-30)

**Source:** the operator's backlog review. Parked issue #285 remains stale-OPEN
although the implementation work landed on `origin/main`; the direct close route
is blocked for agent sessions by the workflow-guard's live-system policy (only
`WORKFLOW_GUARD_ALLOW_LIVE=1`, set before launch, overrides). This is the
merge-route vehicle: the PR's `Closes #285` footer closes the issue on merge.

**No code, runtime, schema, or test change accompanies this record — docs-only.**
`npm run lint` and `npm run typecheck` are not applicable (no `src/`, `test/`,
or build file is touched). The durable evidence lives in the ledger fragments
and the parked-table row cited below; this file is the closure vehicle only.

P6 = "W097 queue" (`docs/PARKED_AND_LIMITATIONS.md:35`, operator-approved
2026-09-24). Verified at closure time (read-only `gh`; worktree base
`origin/main@2235c251`, the merge of PR #422):

```text
$ gh issue view 285 --json number,state,title
{"number":285,"state":"OPEN","title":"Parked P6: W097 queue: the ask channel on the other four seats;"}
```

All carrier merges are reachable from the worktree HEAD (which equals
`origin/main@2235c251`):

```text
$ for c in 6a8ebc4f 43c1fbc7 ec044d91 08dcb8bd 77702361 1605c995 0d7a8ccc 2235c251; do
    git merge-base --is-ancestor "$c" HEAD && echo "$c REACHABLE" || echo "$c NOT reachable";
  done
6a8ebc4f REACHABLE
43c1fbc7 REACHABLE
ec044d91 REACHABLE
08dcb8bd REACHABLE
77702361 REACHABLE
1605c995 REACHABLE
0d7a8ccc REACHABLE
2235c251 REACHABLE
```

---

## What landed — the ask channel, the answer surface, the pins

The queue's four open implementation items plus the two already-resolved items
are all reachable on `origin/main`:

| Item | Verdict | Carrier |
|---|---|---|
| The ask channel on the other seats | **LANDED** | #396 (plugin + fs-server holds), #402 (containment seat), #404 (live-seats composition) |
| The broker-unified pending-ask answer surface | **LANDED** | #401 (broker ask parks + `/api/permission` transport); hub same-process route #410 |
| The daemon-level e2e ask pin | **LANDED** | #412 (offline coverage pin crossing the REAL daemon guard with the authority hold) |
| The G4 matched-surface field | **LANDED** | #417 (first-class `PendingPermissionRequest.matched` on the answer surface); the underlying `GuardDecision.matched` was already W121 |
| G2 part 2 `trustedRole` | **DECIDED — leave unsupplied** | #422 (decision brief; the recommendation was accepted, see below) |
| dist-freshness pin | **RESOLVED** (W120) | not re-implemented |
| `npm pack` verifier debt | **human-gated, tracked separately** | not a P6 code item |

### #396 — plugin + fs-server ask holds on the shared primitive (P6 seats)

`feat(permission): the plugin + fs-server ask holds on the shared primitive (P6
seats)`, merged `2026-09-30T02:55:28Z` (merge `6a8ebc4f`). The delegated-write
guard branch became three-way and parks a guard `ask` on the shared
`createOperatorAskHold` before the write (approve → write; reject/timeout →
refuse), via a new optional `hold?` on `AcpSessionDriver`/`contained`. Record:
`docs/ledger/P6-fs-server-seat.md`, `docs/ledger/P6-plugin-seat.md`.

### #401 — the broker-unified ask-answer surface

`feat(permission): the broker-unified ask-answer surface + harvest 4`, merged
`2026-09-30T03:49:18Z` (merge `43c1fbc7`). This is the operator's chosen
BROKER-UNIFIED path (design brief §4 option A): `PermissionBroker` gained
`parkAsk`/`answerAsk`/`pendingAsks`/`cancelAsks`/`askHold(sessionKey)`, so a held
ask rides the SAME `/api/permission` poll/answer transport as a permission
prompt — one answer surface, no second route. Choices tighten-never-loosen (any
allow → `once`, reject → `reject`); absent → fail closed. The ACP runtime lane
composes the broker-backed hold into the ACP permission resolver and the hub fs
seat. Record: `docs/ledger/ask-answer-surface.md`.

### #402 — the containment seat's ask hold

`feat(permission): the containment seat's ask hold + the P8 live-run recipe`,
merged `2026-09-30T03:49:35Z` (merge `ec044d91`). The containment guard branch
became three-way and parks an `ask` on an injected `hold?: OperatorAskHold`
before `containment.execute`; the brief §2.4 ordering wrinkle was fixed by
moving the guard check after `application.authorize` (one ordering story with
the primary seat). Record: `docs/ledger/P6-containment-seat.md`.

### #404 — live seats + reviewer bind + topology split

`feat(permission): P6 live seats + P4 reviewer bind + topology split brief
(batch 12 carrier)`, merged `2026-09-30T04:02:09Z` (merge `08dcb8bd`).
`shellExecutorFor` gained the `hold?` seam and the new
`test/p6-live-seats.test.ts` composes `PermissionBroker.askHold(<sessionKey>)` at
BOTH that helper and the OpenCode plugin factory. Record:
`docs/ledger/P6-live-seats.md`.

### #410 — the hub same-process answer route (batch 13 carrier)

`feat(p4): topology A1 surface-usage record path + P6 hub answer route (batch 13
carrier)`, merged `2026-09-30T04:20:13Z` (merge `77702361`). The hub process now
composes a `PermissionBroker` and serves its pending/answer transport on the hub
HTTP bridge (`POST /api/permission`), threading `permissionBroker.askHold()` into
every containment seat it composes; `src/integrations/hub-http.ts` mounts the
route behind the optional `permissionBroker` capability (absent → 404, fail
closed). A production composition root `createWorkflowOpenCodePluginRoot` returns
`{ plugin, permissionBroker }`. Record: `docs/ledger/P6-hub-answer.md`.

### #412 — the standalone contained-shell answer route + the daemon e2e ask pin

`feat(permission): standalone contained-shell answer route + hub ask e2e pin`,
merged `2026-09-30T04:32:26Z` (merge `1605c995`). `src/cli/contained-shell.ts`
now composes a same-process `PermissionBroker`, serves its permission-only
loopback route (shared `permissionAnswerRoute`; the hub `/api/permission` branch
calls the same classifier), and threads `broker.askHold()` into its
`WorkflowContainedProcess` — the standalone seat becomes LIVE. The same PR
carries the daemon-level end-to-end ask pin (`test/opencode-server-ask-e2e.test.ts`),
which crosses the REAL daemon guard (`createOpencodeServerGuard`) with the
production authority broker (`mode: "ask-me"`): an approve answers the held ask,
and an unanswered hold fails closed to `reject` on timeout. Record:
`docs/ledger/P6-standalone-answer.md`, `docs/ledger/P6-ask-channel-remaining.md`.

### #417 — the G4 matched-surface field on the answer surface

`feat(permission): expose the rule-matched surface first-class on the ask answer
path (P6 G4)`, merged `2026-09-30T04:56:10Z` (merge `0d7a8ccc`). The repo's G4
(the W121 `GuardDecision.matched`, already forwarded by the seats as
`OperatorAskRequest.matched`) is now a first-class `PendingPermissionRequest.matched`
on the broker's ONE answer surface (per LESS-0046 "a query, not prose");
absent-never-fabricated for an unmatched ask and for a permission prompt.
Record: `docs/ledger/P6-g4-matched-surface.md`.

---

## G2 part 2 — the `trustedRole` decision (#422)

**Status: DECIDED.** `docs: P6 trustedRole (G2 part 2) decision brief`, merged
`2026-09-30T05:03:50Z` (merge `2235c251`). The brief
(`docs/P6_TRUSTEDROLE_BRIEF.md`, ledger `docs/ledger/P6-trustedrole-brief.md`)
recommended **option (i): leave `trustedRole` UNSUPPLIED** — the field is
deny-only (`mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts:141-147`, `:194`),
the seat supplies none (`src/integrations/mcp-toolbox-guard.ts:253-254`), and the
ACP permission resolver carries no trusted role
(`src/adapters/acp-permission.ts:10-28`), so supplying a value today would
fabricate a security fact. The **operator accepted the recommendation**: the
role lane stays fully fail-closed (inert), and no `trustedRole` is supplied
anywhere.

If the guard's read-only lane is later wanted, **option (iii)** — a single
trusted constant plus one designated read-only seat at one composition root — is
the only non-fabricating forward path: the value would be a code literal in
trusted composition, never parsed from agent-influenced wire metadata
(`request.toolCall.title/kind/rawInput/locations` or any agent-set label).
Option (ii) as literally scoped is not implementable without inventing that
trusted source, at which point it is (iii) with more plumbing and a larger
surface to launder. The decision (brief Q5) is recorded and closed.

---

## The two resolved / separately-tracked items

- **dist-freshness pin — RESOLVED (W120).** The P6 row records
  `guardDistIsStale` + the runtime fail-closed throw + the test's self-healing
  rebuild as `landed+verified` (2026-09-24); recorded in
  `docs/ledger/W120-the-dist-freshness-gate-the-vendored-seat-cannot-mount-or-te.md`.
  Not re-implemented and not an open P6 code item.
- **`npm pack` verifier debt — human-gated, tracked separately.** The parked row
  names it "npm-version drift vs the artifact tests, needs operator action". It
  is not a P6 code item and no agent can land it; it stays tracked as the
  separately-gated npm-pack verifier debt.

---

## Record-completeness check

- Ask channel on the seats: `docs/ledger/P6-first-seat-ask-hold.md`,
  `P6-fs-server-seat.md`, `P6-plugin-seat.md`, `P6-containment-seat.md`,
  `P6-live-seats.md` — present.
- Broker-unified answer surface: `docs/ledger/ask-answer-surface.md`,
  `P6-hub-answer.md`, `P6-standalone-answer.md` — present.
- Daemon-level e2e ask pin: `docs/ledger/P6-ask-channel-remaining.md` — present.
- G4 matched-surface field: `docs/ledger/P6-g4-matched-surface.md` — present.
- `trustedRole` decision: `docs/P6_TRUSTEDROLE_BRIEF.md` +
  `docs/ledger/P6-trustedrole-brief.md` — present.
- Parked-table row `docs/PARKED_AND_LIMITATIONS.md:35` (P6) — present, with
  dated landed notes through 2026-09-30.
- Carrier merges `6a8ebc4f` (#396), `43c1fbc7` (#401), `ec044d91` (#402),
  `08dcb8bd` (#404), `77702361` (#410), `1605c995` (#412), `0d7a8ccc` (#417),
  `2235c251` (#422) — all reachable from `HEAD`/`origin/main`.

**Records complete.** The P6 queue is complete, aside from the
separately-tracked human-gated `npm pack` verifier debt. This vehicle is the
merge-route closure only; the issue closes via the PR footer on merge.

**Closure recommendation:** **close** — the ask channel on the seats, the
broker-unified pending-ask answer surface, the daemon-level e2e ask pin, and the
G4 matched-surface field have landed and are reachable on `origin/main`; the G2
part 2 `trustedRole` decision is recorded (leave unsupplied, fully fail-closed);
dist-freshness was resolved in W120; and the `npm pack` verifier debt is
human-gated and tracked separately.
