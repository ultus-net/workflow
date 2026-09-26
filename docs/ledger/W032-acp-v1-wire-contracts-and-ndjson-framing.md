<!-- Ledger fragment: extracted from TASKS.md at line 578 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W032 - ACP v1 wire contracts and NDJSON framing

**Objective:** Introduce a minimal, protocol-faithful ACP v1 wire boundary without changing `AcpHostAdapter`'s existing internal correlated contract.

**Depends on:** W031

**Acceptance criteria:**
- [x] Type contracts cover the minimal v1 messages needed for the spike: `initialize`, `authenticate`, `session/new`, `session/prompt`, `session/cancel`, `session/update`, and `session/request_permission`.
- [x] NDJSON stdio framing encodes one JSON-RPC message per line, handles multi-byte UTF-8, splits across arbitrary chunk boundaries, and rejects malformed lines fail-closed.
- [x] Existing `AcpHostAdapter` behavior remains unchanged and is not presented as an ACP v1 wire adapter.

**Verification:** focused unit tests for wire validation and framing plus existing adapter tests.
