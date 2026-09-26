<!-- Ledger fragment: extracted from TASKS.md at line 283 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W016 - Threat-model capability and trust boundaries

**Objective:** Document and test where Workflow enforcement ends, especially shell/process authority, credentials, MCP trust, host interception, and production operations.

**Depends on:** W010, W013

**Acceptance criteria:**
- [ ] Threat model distinguishes application policy from OS/container sandboxing.
- [ ] Credential and high-blast-radius capabilities can be withheld independently of prompts.
- [ ] Advisory hosts and unverifiable evidence cannot be mistaken for enforced guarantees.

**Verification:** Adversarial tests cover malformed adapter/MCP inputs and attempted safety-boundary bypasses.
