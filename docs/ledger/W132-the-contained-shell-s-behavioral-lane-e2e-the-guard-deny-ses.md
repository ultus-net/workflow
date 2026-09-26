<!-- Ledger fragment: extracted from TASKS.md at line 4720 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W132 - The contained-shell's behavioral lane e2e + the guard-deny session-death repair (Complete - the containment contract driven over stdin pipes: ALLOW→ENFORCED→VERIFIED, the nonzero lane's persistence, and the guard-deny lane repaired to W022's contract) (2026-09-25)

**Source:** the second background wave's contained-shell agent; the
contained shell is the containment contract's user-facing surface, and
its behavioral lanes (ALLOW → ENFORCED → VERIFIED; the nonzero lane;
the guard-deny lane) had never been driven over the COMPILED seat —
LESS-0012's divergence class on the surface that executes operator
commands inside bubblewrap.

**What landed:** `test/e2e-contained-shell.test.ts` (three lanes over
stdin pipes, no PTY, every execution inside the product's own bubblewrap
boundary, HOME redirected): (1) the benign allow — blank line executes
nothing, Policy: ALLOW → Containment: ENFORCED (bwrap 0.11.0 — the
observed truth) → the command's output → Task: VERIFIED, strict order,
clean exit 0; (2) the nonzero lane — `false` → Task: FAILED (exit 1) and
the session SURVIVES (the next command verifies — W022's persistence
contract); (3) the guard-deny lane — Workflow's own lane prints Policy:
ALLOW first, then the vendored guard denies INSIDE
WorkflowContainedProcess.execute.

**Discovered and fixed — the wave's second live product defect:** the
guard-deny lane's denial THREW out of the unguarded per-command loop and
TERMINATED the persistent session (exit 1, no Containment/Task lines
ever printed) — violating W022's recorded contract ("a denied command
does not terminate the persistent session"; the nonzero lane held, the
guard lane did not). Fail-closed (the denial fires BEFORE any spawn:
nothing executed, nothing mutated) but honest death instead of
per-command reporting. Fixed: contained-shell.ts catches the failure
per-command, reports `Task: FAILED (execution refused: …)` — the label
deliberately SEAT-NEUTRAL per the round-3 review's P2 (execute's throw
classes are the guard seat, the second authorization seat, and
containment failures; a bwrap-less operator must not read a false seat
attribution) — transitions the task FAILED, and keeps the loop alive;
the pin now asserts the repaired contract (the FAILED report carries the
denial's message, no containment verdict prints, and the NEXT command
still verifies, exit 0). W022's ledger line carries the dated
contradiction note.

**Discoveries recorded (observed, pinned):** the shell's own Policy:
DENY branch is DEAD CODE from its only input surface — every stdin line
flows the same hardcoded proposal (subjects fixed [], workspaceRoot
never set, the capability set includes process, a fresh
WorkflowApplication + fresh MutationBudget(100) per command) — so the
only reachable deny is the guard seat's, which the fix now surfaces
honestly. The environment truth: bwrap 0.11.0 present → ENFORCED is the
live lane; the bwrap-less and non-Linux degradations are recorded from
source, never faked.

**Acceptance criteria:**
- [x] Red/green: the lane-3 red was the live session death (the agent's
      observed run: exit 1, no Task line); post-fix 3/3 green with the
      repaired pin (the FAILED report + the surviving session's next
      VERIFIED).
- [x] The LESS-0051 safety contract: no agent/PTY spawns; the payloads
      execute INSIDE the product's own bubblewrap boundary (echo/false
      only; the guard-deny probe assembled from fragments so the file's
      own authoring guard never matches the literal); HOME redirected;
      the guard MCP server dies with the child's process group; SIGTERM
      only as the stuck-exit backstop.
- [x] Hold-outs: the W126 sweep's contained-shell boot/EOF pin holds
      alongside; lint + this file's typecheck clean (the whole-project
      typecheck is transiently red from the concurrent hub-routes agent's
      untracked WIP — its gate lands with its integration).

**Residuals (recorded, not fixed):** the shell's own DENY branch remains
unreachable from stdin (a coverage gap in the surface's design, not the
test — recorded for the surface's next design pass); the bwrap-less
Linux and non-Linux degradations are recorded from source and must be
pinned by their own environments; the guard-deny probe's fragment
assembly is environment-coupled to the vendored policy corpus's
destructive-operation rule; a POST-SPAWN containment failure (the
command possibly executed) would skip recordMutation where the nonzero
lane records it — the mutation-accounting question for the catch lane
is queued (the round-3 review's P2 follow-up); the ShellSession exit
await has no SIGKILL escalation deadline (note-level: a plain node child
never ignores SIGTERM — the round-3 review's P3).
