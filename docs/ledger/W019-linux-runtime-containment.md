<!-- Ledger fragment: extracted from TASKS.md at line 339 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W019 - Linux runtime containment

**Objective:** Extend Workflow's policy boundary with a Linux-first runtime containment layer that can prove when process execution is isolated from ambient credentials, unrestricted filesystem access, and unapproved network/production authority.

**Depends on:** W018

**Scope:** Keep containment contracts host-neutral and portable, but make enforcement claims only for the tested Linux backend. Containment availability and effective capabilities are runtime facts, not configuration claims. An unavailable or insufficient backend fails closed instead of executing with ambient host authority.

**Acceptance criteria:**
- [x] A host-neutral containment contract describes requested process/filesystem/network/credential capabilities and returns observable enforcement/evidence state.
- [x] A Linux backend executes an allowed process inside an independently testable containment boundary and rejects execution when the requested boundary cannot be established.
- [x] Ambient credentials are absent by default; filesystem and network/production access require explicit grants rather than inheritance from the parent process.
- [x] Workflow policy authorization remains necessary but is not represented as sufficient for runtime containment; the application/operator surface distinguishes policy permission from containment enforcement.
- [x] Tests exercise successful contained execution plus fail-closed credential, filesystem, network, malformed-input, and unavailable-backend paths without requiring production credentials or mutation authority.
- [x] Documentation states the exact Linux/runtime prerequisites, guarantees, non-guarantees, and portability boundary.

**Verification:** `npm run lint`, `npm test`, `npm run typecheck`, `npm run build`, runtime containment integration tests on Linux, package dry-run, audit, diff check, and independent five-axis review against the final change.

W019 is complete. The v0 W001-W018 baseline remains the trusted host-policy/application foundation; W019 strengthens execution containment without weakening or conflating those existing authorization semantics.
