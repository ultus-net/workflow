<!-- Ledger fragment: extracted from TASKS.md at line 296 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W017 - Extension and operator documentation

**Objective:** Make adding another SDK, MCP provider, or UI straightforward without learning internal implementation details.

**Depends on:** W013, W014, W016

**Acceptance criteria:**
- [ ] Host adapter guide documents capabilities, conformance tests, and advisory/enforced semantics.
- [ ] MCP integration guide documents evidence trust boundaries.
- [ ] UI guide documents the application API and state ownership rule.
- [ ] Operator guide explains what Workflow does and does not guarantee.

**Verification:** Documentation examples match exported contracts and runnable commands.
