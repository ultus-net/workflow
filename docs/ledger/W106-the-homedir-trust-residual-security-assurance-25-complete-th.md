<!-- Ledger fragment: extracted from TASKS.md at line 3059 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W106 - The homedir-trust residual: SECURITY_ASSURANCE #25 (Complete - the W097-era queued record closed; docs-only) (2026-09-23)

**Source:** the pain-point queue's item 6 — W097's queued record: the
ostree fix (LESS-0015) deliberately left the homedir trust anchor
unclamped and queued the residual for SECURITY_ASSURANCE; LESS-0015
carried it only, and the doc had no entry (verified by grep on current
main before landing).

**What landed (docs-only):** residual #25 in
docs/SECURITY_ASSURANCE.md — the unclamped `os.homedir()` anchor in
`checkProtectedPath` (a poisoned `HOME=/var` — or the extreme `HOME=/`
— would classify system paths as user space and neuter the
corresponding system-space prefix rules), bounded honestly: the `.ssh`
and secret-name rules are env-independent and still fire, the
workspace-boundary lanes never consult the home anchor, and the edge
is HOST-SIDE ONLY (the guard process's environment belongs to the
operator's host; agent seats cannot set it — the W097 review verified
agents cannot reach it). The deliberate non-patch is recorded with its
reason and a mitigation shape (passwd-entry anchor, or intersect with
the workspace root). AGENTS.md's residual-count line updated 24 → 25
with the dated attribution.

**Evidence:** absence verified by grep on current main before landing
(the queue's "confirmed still missing" claim re-verified); the
entry's code cites read from path-policy.ts (the W097 classification
block); security-assurance checker 7/0 after (its pins are
count-agnostic — section presence + headline residuals + no-TODO);
repo lint/typecheck exit 0 (docs-only diff code-inertness).

**Acceptance criteria:**
- [x] The residual is stated in the doc with its honest boundary (what
      the poisoned HOME neutering covers and what still fires), the
      host-side-only reachability claim, and the W097 provenance.
- [x] The deliberate non-patch and its reason recorded, not hidden.
- [x] AGENTS.md's honesty-count line reflects the new count with a
      dated attribution.
- [x] No code changes; the checker's pins unaffected.
