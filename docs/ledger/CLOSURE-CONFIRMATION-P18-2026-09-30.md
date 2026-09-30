<!-- Ledger fragment: opened 2026-09-30 as a closure-confirmation record. Write-once — append dated supersession notes, never rewrite. -->

### Closure confirmation - P18 (issue #296) (2026-09-30)

**Source:** the operator's backlog review; the issue's scope is fully landed and the direct close route is blocked for agent sessions by the workflow-guard's live-system policy (only `WORKFLOW_GUARD_ALLOW_LIVE=1`, set before launch, overrides). This is the merge-route vehicle: the PR's `Closes #296` footer closes the issue on merge.

**Evidence — every queued edge landed:**

- **(a) exotic interpreter names:** the busybox nesting asymmetry fixed (word-wise post-applet unwrap in both lanes) and `xsh` joins the sh-family wrapper transparency (batch 1, PR #353).
- **(b) the zsh EQUALS expansion caveat:** pinned an explicit, documented allow (parser-consistent with sh/bash; PR #353).
- **(c) ref-adjacent filesystem routes:** direct `.git/` ref-adjacent writes classify through the W101 protected-target gate (batch 4, PR #364); the env-spelled gitdir route (`GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE`) with wrapper and `sh -c` transparency (PR #369); the boundary refine incl. the in-command symlink hop (PR #377); the `git --git-dir=`/`--git-dir `/`--work-tree` option spellings (PR #381).

**Recorded boundaries (not open promises):** the genuinely un-inspectable routes stay with the outer workspace/protected-path lanes and are recorded in the coverage entry, the P18 row, and residual #21 — a `.git` symlink hop whose spelling carries no `.git` component, a gitfile working directory, a gitdir not named `.git` addressed without a spelling, case-variant `.GIT/` paths (conservatively denied), non-ref `.git` content (objects/index/config/hooks/tags), and the `file_write` lane's lack of command text. SECURITY_ASSURANCE residual #21 carries its dated disposition (the inspectable parts resolved; the boundaries stated).

**Note:** no source, runtime, or test change accompanies this record — it is the closure vehicle only. Docs-only; lint/typecheck not applicable. The P18 ledger fragments (`docs/ledger/P18-guard-residual-edges.md`, `P18c-…`, `P18d-…`, `P18e-…`) are the durable record.