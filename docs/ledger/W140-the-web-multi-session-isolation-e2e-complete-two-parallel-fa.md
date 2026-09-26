<!-- Ledger fragment: extracted from TASKS.md at line 5169 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W140 - The web multi-session isolation e2e (Complete - two parallel fake-runtime sessions behind one server: transcript/config/prompt isolation per session, the guard set per session, and the cross-session answer-consumption FINDING pinned as-found) (2026-09-25)

**Source:** the second wave of the operator's "get sub agents to
continue e2e coverage" direction (report-only agent, LESS-0051 safety
contract, in-process tsx seat — no dist build, no agent/PTY spawns).
The ?session= routing contract was unit-pinned against ONE session
(W114-era); this wave drives the isolation contract with TWO real
parallel sessions.

**What landed:** `test/web-scoping.test.ts` (11 tests, green twice
consecutively at 571-731ms; the mirrored suites still green — web 27/27,
web-sessions 20/20): transcript isolation both directions with the
unscoped route answering the focused session; config options isolated
per driver; the unknown-id 404 shape against TWO real sessions across
six routes (upgrading test/web.test.ts:688's single-session pin);
permission scoping (B's poll null while A parks); cancel scoping (only
A's park resolves PROMPT_CANCELLED, B's park survives and stays
answerable); PROMPT_BUSY per session (A's second park denies while B's
first park is accepted); rename/retry/add guards per session; focus
switch (activating B spawns nothing, disposes nothing in A, denies no
parks); the per-session busy contract (A 409 + B 202 in the same
window; B's completion never unbusy A).

**FINDING (recorded, not fixed):** the permission poll is
session-scoped (`pendingRequest(sessionKey)`, permission-broker.ts:77-80)
but the ANSWER path is not — `PermissionBroker.answer` matches the
parked id alone (:83-106) and the route never checks ownership, so
answering through B's route with A's parked id returns 200, resolves
A's park (OPERATOR_REJECTED), and A's poll afterwards shows null. Pinned
as-found (the FINDING test); the fix shape is a session-scoped refusal
on the answer route, which flips that pin deliberately. Mitigating
posture: the same-origin trusted-mutation guard still applies and the UI
never surfaces another session's id.
  - Dated note (2026-09-25, W141): the finding FIXED — the pin flipped
    deliberately (the test now pins the repaired contract: cross-session
    404, the park survives B's attempt, the owning session still
    answers). See the W141 entry.

**Acceptance criteria:**
- [x] 11/11 green twice consecutively; lint + typecheck exit 0; the
      mirrored suites (web, web-sessions) still green.
- [x] The LESS-0051 safety contract: in-process only (tsx), fake drivers,
      mkdtemp registry paths, port 0, no agent/PTY spawns, no dist build.

**Residuals (recorded, not covered):** full /api/image cross-session
store isolation (only the lookalike 404 is pinned — a cheap follow-up);
the live-cap eviction path and dismiss-with-parked-prompts (need seven
parallel runtimes / dismiss flows; the keyed-cancel wiring is already
manager-pinned at test/web-sessions.test.ts:531); /api/sessions/compact
per-session agent-id mapping (rides the v2 data-lane gateway, outside
the in-process contract); registry-restart isolation over HTTP (covered
at manager level in web-sessions.test.ts, not duplicated).
