<!-- Ledger fragment: extracted from TASKS.md at line 651 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W037 - ACP universal session driver

**Objective:** Give the universal TUI a protocol-native path to any ACP-speaking agent (the established cross-editor agent protocol), so the driver registry's `--driver acp` generalizes beyond bespoke Cline/OpenCode drivers.

**Depends on:** W027, W030, universal-TUI plan (docs/superpowers/plans/2026-09-14-universal-tui.md)

**Acceptance criteria:**
- [x] An `AcpSessionDriver` implements `CodingSessionDriver` over a stdio JSON-RPC ACP client: `session/new`, `session/prompt`, `session/cancel`, and `session/update` notifications translate to the host-neutral `CodingSessionEvent` stream; kernel/application contracts unchanged. (`src/integrations/acp-session.ts`, `test/acp-session.test.ts`, 2026-09-14.)
- [x] ACP `session/request_permission` flows through `AcpHostAdapter` + `WorkflowApplication.authorize` (the hardened trust boundary), so Workflow is the permission authority at exactly the protocol seam designed for it. (`AcpSessionDriver` wires per-request resolution through `createWorkflowAcpPermissionResolver`; recognized-title map is fail-closed.)
- [x] ACP filesystem/terminal capability services are routed through `WorkflowContainedProcess`, so an ACP agent's shell runs inside containment by protocol construction rather than by host patch. (Not applicable to Cline 3.0.61: it never delegates `fs/*`/`terminal/*` capability services to the client — W035 evidence — so its shell is contained by whole-agent Bubblewrap launch instead, which is the equal-strength enforcement path for this client shape. Applies when a future ACP agent does delegate.)
- [x] The driver registry gains `acp` (`--driver acp`); unavailable agents fail closed with the exact spawn/connect error — no silent fallback to another driver. (`src/cli/driver-registry.ts`; `test/driver-registry.test.ts` proves explicit ACP selection propagates the composer error unchanged.)
- [x] Adapter conformance covers the ACP driver lifecycle (fake ACP server fixture), including denial, cancellation, and malformed-notification fail-closed paths. (`test/acp-session.test.ts` exercises all three through `AcpSessionDriver` + `WorkflowCodingSession`; transport-level malformed/cancel coverage remains in `test/acp-subprocess.test.ts`.)

**Verification:** ACP conformance fixture tests plus one real ACP-speaking agent smoke session; existing gates unchanged.

W037 is complete. The universal registry explicitly composes ACP through the same contained `AcpSessionDriver` runtime used by the dedicated ACP surface; driver selection has no cross-SDK fallback path.

## Phase 10: Review Control Plane

The W037 universal surface is the acceptance-test baseline for this phase. Run operator acceptance testing before changing review-control-plane behavior so product-surface failures can be attributed to the verified W037 baseline rather than concurrent review infrastructure changes. These items adapt deterministic review-pipeline ideas observed in Alibaba OpenCodeReview; they do not add OpenCodeReview as a runtime dependency.
