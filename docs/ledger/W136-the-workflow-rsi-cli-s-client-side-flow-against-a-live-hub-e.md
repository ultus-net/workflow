<!-- Ledger fragment: extracted from TASKS.md at line 4953 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W136 - The `workflow-rsi` CLI's client-side flow against a live hub e2e (Complete - the multi-process CLI contract: the operator-token reads, the verifier gate refusing client-side before any request, and the refusal shapes through the CLI's stdout/exit contract) (2026-09-25)

**Source:** the third background wave (the rsi-CLI agent). W133 pinned
the hub's route bodies; the CLI's discovery → authentication → request
flow — and its refusal shapes — against a live compiled hub had never
been driven.

**What landed:** `test/e2e-rsi-cli.test.ts` — the compiled CLI against a
spawned compiled hub (the operator token from discovery.json, the
verifier token from verifier.json, all state under redirected HOMEs):
`status` (the operator token) answers EXACTLY `{ loops: [] }`
pretty-printed with an empty stderr and exit 0; `status --id <missing>`
answers `{ loop: null }`; `cancel --id/--workspace <absent>` answers
`{ cancelled: false }` — safe refusals leaving the registry untouched;
`start` with verifier.json ABSENT refuses CLIENT-side before any request
("no Workflow hub verifier discovery at … (is the hub running?)") with a
follow-up status proving NOTHING ARMED — /rsi/start is never called;
`status` against a crafted verifier-token seat answers the 401 through
the CLI's call-error shape ("hub /rsi/status failed: unauthorized") —
proving status/cancel authenticate with exactly the discovery token; the
refusal shapes (missing and MALFORMED discovery are indistinguishable —
readHubDiscovery returns undefined either way; a dead endpoint surfaces
as bare "fetch failed"; the parse refusals fire before hub resolution);
the seam precedence (--discovery-dir > WORKFLOW_HUB_DIR > ~/.workflow,
each named verbatim in the failure); the teardown re-observes W128's
unlink contract.

**Findings recorded (not fixed):** malformed discovery is
INDISTINGUISHABLE from missing (hub-client.ts swallows the parse error —
an operator with a corrupt seat sees the no-daemon message; fail-closed
but ambiguous — a polish candidate); the dead endpoint surfaces as bare
"fetch failed" (the CLI prints only error.message, dropping the
ECONNREFUSED cause chain — note-level; the preserve-caught-error rule
would suggest printing the cause).

**Acceptance criteria:**
- [x] 2/2 green three consecutive runs (1.2-1.3s); lint + typecheck
      exit 0.
- [x] The verifier gate pinned CLIENT-side with a follow-up status
      proving nothing armed; /rsi/start never sent.
- [x] The LESS-0051 safety contract: no agent/PTY spawns; three
      ephemeral mkdtemp HOMEs; port 0; the hub never spawnSync-killed
      (async spawn → banners → CLI spawnSyncs → group SIGTERM → pinned
      exit 0 + unlink truth).

**Residuals (recorded, not fixed):** the two findings above; W133's
route-level contract remains the deeper seat (this file re-projects it
through the CLI's stdout/exit contract rather than re-pinning it).
