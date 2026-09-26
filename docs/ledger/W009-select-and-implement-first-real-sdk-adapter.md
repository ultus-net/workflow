<!-- Ledger fragment: extracted from TASKS.md at line 179 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W009 - Select and implement first real SDK adapter

**Objective:** Connect one current agent SDK without changing kernel semantics.

**Depends on:** W005, W008

**Acceptance criteria:**
- [ ] SDK-specific schemas remain inside its adapter package/module.
- [ ] Adapter reports capabilities truthfully and maps pre/post tool events into the generic contract.
- [ ] The shared adapter conformance suite passes unchanged.

**Verification:** SDK adapter tests plus a runnable smoke flow where the SDK permits it.
