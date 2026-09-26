<!-- Ledger fragment: extracted from TASKS.md at line 116 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W005 - Define capability-based host adapter contract

**Objective:** Define the SDK-independent boundary used by Pi, OpenCode, Cline, Crush/future hosts, or test fixtures.

**Depends on:** W002

**Acceptance criteria:**
- [ ] Contract represents session identity, proposed tool action, pre-action interception, post-action observation, cancellation, approvals, and host capabilities without importing a concrete SDK.
- [ ] Adapter declares whether pre-mutation enforcement is authoritative.
- [ ] Hosts lacking authoritative interception are classified `advisory` and cannot be reported as `enforced`.
- [ ] Malformed/unknown safety-relevant adapter input fails closed when enforcement is claimed.

**Verification:** Adapter conformance tests run identical event traces against an in-memory reference adapter.
