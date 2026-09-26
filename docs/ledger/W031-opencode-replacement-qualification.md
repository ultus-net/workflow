<!-- Ledger fragment: extracted from TASKS.md at line 558 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W031 - OpenCode replacement qualification

**Objective:** Decide from evidence whether Workflow is ready to become the default coding harness for the user's normal work.

**Depends on:** W029, W030

**Acceptance criteria:**
- [x] A representative suite of real coding prompts succeeds end to end across clean and dirty repositories, including edit/test/debug and multi-step tasks.
- [x] Recovery, cancellation, denial, malformed host input, containment failure, and verification failure cases remain fail-closed and understandable to the operator.
- [x] Remaining feature gaps versus the user's actual OpenCode usage are documented with explicit severity/workarounds; no critical daily-driver gap is hidden by the qualification result.
- [x] Full verification and independent review find no unresolved P0/P1 safety, state-integrity, or data-loss defects.

**Verification:** dogfood matrix over representative coding prompts, full automated/runtime gates, restart/recovery scenarios, and independent five-axis review before switching the default workflow.

W031's current matrix has no observed P2 daily-driver parity gap: real Cline coding, clean-to-dirty continuation, restart recovery, containment, policy denial, Git verification, editor/direct-patch mutation, image prompt input, and MCP participation are covered. OpenCode interoperability now has a separate authoritative `tool.execute.before` adapter/plugin and a host-neutral SDK session driver; SDK lifecycle events remain non-authoritative telemetry. A real OpenCode runtime E2E is not claimed by that contract coverage. Fresh full verification and independent review remain required before changing the default harness.

## Phase 8: Hub-Side ACP Spike

The ACP direction is evidence-first: prove a hub-side ACP client and per-agent interception/containment conformance before choosing the long-term operator surface. ACP is transport/interoperability, not authority. The patched Cline Ink terminal remains an operational fallback, not the presumed long-term base.
