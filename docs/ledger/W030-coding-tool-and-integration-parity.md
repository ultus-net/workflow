<!-- Ledger fragment: extracted from TASKS.md at line 542 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W030 - Coding tool and integration parity

**Objective:** Close the practical tool gaps required for the user's routine OpenCode workload while preserving the established adapter/capability boundaries.

**Depends on:** W028

**Acceptance criteria:**
- [x] Repository file discovery/read/edit/patch, diagnostics/tests, shell/process, and Git inspection used by normal coding sessions are supported through the SDK and correctly classified/authorized by Workflow, including direct `apply_patch` registration through the public `localRuntime.extraTools` surface.
- [x] Required MCP capabilities can participate through the existing MCP boundary without becoming orchestration authority.
- [x] Image or other user-input modalities required by the chosen SDK workflow remain host/application concerns and do not introduce model-provider types into the kernel; image prompt input is supported through the host-neutral application port.
- [x] Parity gaps are tracked from observed real-session failures rather than speculative reimplementation of every OpenCode feature.

**Verification:** representative repository tasks exercise the supported tool matrix and policy-denial cases through the real SDK runtime.

W030 is complete as an observed parity assessment. Built-in mutation/process classification is conservative even when host callback metadata incorrectly reports a known editor, patch, or shell tool as non-mutating; extension tools can carry explicit least-privilege metadata without downgrading built-ins. The real SDK fixture covers repository reads, contained shell/test/Git work, deterministic SDK editor and direct `apply_patch` execution, authoritative denial, and SDK-native MCP participation. Image prompt input remains host-neutral and translates to Cline's public `userImages` field. The direct patch follow-up uses Cline's public tool factory and `localRuntime.extraTools`; Workflow does not own a parallel model/tool implementation.
