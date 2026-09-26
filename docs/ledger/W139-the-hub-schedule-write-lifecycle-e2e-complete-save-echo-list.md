<!-- Ledger fragment: extracted from TASKS.md at line 5112 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W139 - The hub schedule WRITE lifecycle e2e (Complete - save echo → list deep-equal → delete, both refusal classes, the W134 body contract, a verifier-gated run-now that refuses before any agent work, and the table's persistence across a hub restart) (2026-09-25)

**Source:** the first wave of the operator's "get sub agents to
continue e2e coverage" direction (report-only agent, LESS-0051 safety
contract). W133 pinned the route-LEVEL contract on a fresh hub; this
wave drove the write lifecycle and its persistence against the live
multi-process seat.

**What landed:** `test/e2e-hub-schedule.test.ts` (2 tests, 101
assertions; green 3× consecutive, 1.24-1.26s warm): save echo → list
deep-equal with the `{version:1, schedules:[…]}` table file asserted
after every write; the token-class matrix per hub-http.ts:92-97
(verifier refused 401 on save/list/delete; operator refused 401 on
run-now BEFORE body parse); six registry-level plus two route-level 400
refusals (bad cron minute/day-of-month, whitespace title, empty id,
non-string workspace, bad taskClass) leaving the list unchanged; the
W134 body contract on a WRITE route (empty/malformed → 400 with the
named requirement; >1 MiB → 400); run-now on an absent id → 200
`{fired:false}`, on a present id fired with the verifier token → 200
`{fired:true}` with the fire landing on a workspace that cannot
canonicalize so `fireOnce` refuses at controller.begin (the hub log
line observed; /snapshot pins ZERO run tasks — no ACP runtime ever
composes; cron Feb-31 + enabled:false belt-and-braces); the default
seat `<HOME>/.workflow/scheduler.json` surviving clean teardown AND a
hub restart with freshly re-issued credentials; delete lands the empty
table.

**Findings recorded (not fixed):**
- **(a) Unknown definition fields persist verbatim** — POST /schedule/
  save with an extra `unknownField` answers 200 and writes it to the
  table (hub-scheduler.ts:246-286 validates known keys only); a
  schema-rejection gap.
- **(b) A begin-failing run-now is indistinguishable from a successful
  fire at the route** — 200 `{fired:true}` either way; the only signal
  is the hub's stdout log; an observability gap.
- **(c) Delete of an unknown id is a silent 200 no-op**
  (schedule-registry.ts:62-65) — idempotent, but never surfaces an id
  typo.
- Asymmetry (pinned, not filed): the save route's shape check admits an
  empty id (hub-http.ts:202) that sibling delete/run-now refuse (:216,
  :223); the registry catches it.

**Acceptance criteria:**
- [x] 2/2 green three consecutive runs; lint + typecheck exit 0 with
      the file present.
- [x] The LESS-0051 safety contract: no agent/PTY spawns; the fireable
      path was made to refuse at controller.begin BEFORE any runtime
      composition; redirected mkdtemp HOMEs; port 0; clean teardown
      pinned.

**Residuals (recorded, not fixed):** run-now on a fireable schedule and
the clock-fired tick path are out of LESS-0051's bounds (either would
compose a real ACP agent run); the paused-schedule-is-still-fireable
rule is documented from hub-scheduler.ts:294-297,424, not live-driven;
off-peak deferral and run budgets are scheduler-internal, unreachable
through the write-lifecycle routes without a live turn.
