<!-- Ledger fragment: extracted from TASKS.md at line 243 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W013 - Add second host adapter

**Objective:** Prove SDK portability with a genuinely different host lifecycle/API.

**Depends on:** W009

**Acceptance criteria:**
- [ ] Second host passes the shared conformance suite without kernel changes.
- [ ] Capability differences produce truthful `enforced`/`advisory` behavior rather than host-specific exceptions in core.
- [ ] Switching host configuration does not change task/evidence semantics.

**Verification:** Run the same canonical traces through both adapters and compare kernel outcomes.
