<!-- Ledger fragment: extracted from TASKS.md at line 130 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W006 - Define MCP capability/evidence boundary

**Objective:** Integrate MCP tools without coupling the Workflow kernel to MCP orchestration semantics.

**Depends on:** W002, W004

**Acceptance criteria:**
- [ ] MCP tools/capabilities can be discovered and invoked through an application-side port.
- [ ] MCP responses are treated as untrusted external input and normalized before becoming evidence candidates.
- [ ] MCP output cannot directly change canonical task state or self-certify verification.

**Verification:** Contract tests use a fake MCP provider to prove evidence normalization and rejection of malformed/untrusted results.
