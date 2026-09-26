<!-- Ledger fragment: extracted from TASKS.md at line 5275 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W142 - The hub /bash + /run/begin lanes e2e (Complete - the contained-shell contract on the live compiled seat, every refusal class, and the run-record lifecycle with exactly one task that never composes) (2026-09-25)

**Source:** the third wave of the operator's e2e-coverage direction
(report-only agent, LESS-0051 safety contract; this wave owned the dist
build). Greps found no /bash coverage anywhere in test/ before it.

**What landed:** `test/e2e-hub-bash.test.ts` (1 test, green 3×
consecutively, subtest 0.6-1.5s): the token-class matrix against
hub-http.ts:92-97 — /bash and /run/begin are OPERATOR routes (verifier
refused 401, both directions pinned) while the run lifecycle's
verifier-gated lane is /run/finish (pinned both directions); the happy
contract EXACTLY `{output: string}` (stdout+stderr concatenated with no
separator and no exit-code field, contained-shell-executor.ts:62) with
echo/pwd/printf pins, pwd === the requested cwd, the structured
{command,args} direct-exec form, and a 200,000-char output returned
verbatim; every refusal class (empty body → 400 with the W134 named
requirement; `{}` → 400; empty command → 500; relative/empty cwd →
canonicalization refusal; cross-workspace cwd → WORKSPACE_PATH_DENIED;
guard non-allow → promotion-gate 500); the /run/begin record lifecycle —
exactly ONE run task created (run:w141-e2e-run-record), the
cannot-canonicalize attempt refused BEFORE composition (the snapshot
stays empty), and the observed removal path `/run/finish
{outcome:"failed"}` hides the task (never deletes; one failed
environment evidence remains); the bwrap confinement signature pinned
(cleared environment, synthesized PATH, no HOME, the runtime probe
before every execute).

**Findings recorded (not fixed, each with its reproducing request):**
(a) a nonzero exit is represented only as a 500 with no exit-code field
on the wire; (b) an empty command string passes the route check and 500s
in the executor; (c) NO timeout anywhere in the /bash chain
(grep-verified across hub-http.ts, contained-shell-executor.ts,
linux-bwrap.ts — the hung-command lane was deliberately NEVER sent, the
finding is the record); (d) no response-side output cap (asymmetric with
the 1 MiB request cap); (e) /run/begin client-shaped faults classify
500; (f) no true deletion path for a run record (finish-failed hides;
evidence remains).
  - Dated note (2026-09-25, W144): finding (c) FIXED — the lane is
    bounded (the W144 entry; the hung-command lane can no longer exist
    to observe).
  - Dated note (2026-09-25, W145): findings (a) and (b) FIXED — a
    nonzero command exit answers 422 {error, exitCode} (the command's
    result is data, never a server fault) and an empty/invalid command
    answers 400 at the route; the pins flipped deliberately (see the
    W145 entry).
  - Dated note (2026-09-25, W146): finding (e) PARTIALLY FIXED — the
    non-canonical-workspace member now answers 400 (the typed
    WorkspaceDeclarationError; three pins flipped deliberately, see the
    W146 entry); empty runId and duplicate runId remain recorded 500s.

**Acceptance criteria:**
- [x] 1/1 green three consecutive runs; lint + typecheck exit 0 with
      the file present.
- [x] The LESS-0051 safety contract: the only spawned processes are the
      compiled hub and innocuous one-liners (echo/pwd/printf) with
      captured output; no agents/PTYs/network; redirected mkdtemp HOMEs;
      port 0; clean teardown re-observed.

**Residuals (recorded, not covered):** the hung-command boundary (no
timeout exists to bound it — finding (c)); /rsi/start, /schedule/run-now,
requiresReview begins, and any ACP/agent composition were never
exercised; the seat's enforcement marker is not surfaced over HTTP
(recorded as a limitation in the header).
