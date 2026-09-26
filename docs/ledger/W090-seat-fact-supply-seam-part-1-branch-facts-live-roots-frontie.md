<!-- Ledger fragment: extracted from TASKS.md at line 2032 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W090 - Seat fact-supply seam part 1: branch facts + live roots (frontier G2) (2026-09-22)

**Objective:** close the frontier assessment's largest finding (§4 "design
ported, seat not fed"): `guardInputFromToolCall`/`guardCheck` supplied only
action/command/path/content/workspace — so protected-branch discipline was
dead in hub-seated sessions, and the W087 live-root fact could not even be
carried by the seat contract. W090 part 1 enriches guarded
shell/git/file_write calls at the single convergence point (the provider's
`guardCheck`) with workspace-derivable facts: `currentBranch` (read-only
`git branch --show-current`, fail-open to omitted on failure/detached HEAD),
`protectedBranches` (hub default `["main","master"]`, mirroring the
vendored plugin's default project config; a configured source is follow-up),
and `liveConfigPaths` (the runtime-config root `~/.config/opencode` when it
exists — only existing-and-absolute roots are declared). Caller-supplied
facts always win; no workspace → no enrichment (fact-less behavior
preserved). `trustedRole` is deliberately deferred (seat-level role
semantics need their own design — frontier G2 part 2).

**Where:** `src/integrations/mcp-toolbox-guard.ts` (contract + resolver +
provider enrichment); the four workspace-carrying seats are unchanged (they
flow through the provider and always set `workspaceRoot`). The containment
seat's workspaceRoot-less calls enrich nothing — enrichment is strictly
input-workspace-driven (the review's P2: an `options.workspace` fallback
would have bound branch facts to the hub root while executing in a per-call
cwd — removed after round 1); its sandbox is the boundary, and passing
workspaceRoot there is queued with care (it would also activate
workspace-boundary denies for legitimate HOME-cache writes).

**Acceptance criteria:**
- [x] Protected-branch discipline engages in hub-seated sessions:
      `file_write` on a protected branch denies `protected-branch-write`;
      the same write on a feature branch allows; caller-supplied
      `currentBranch` wins over discovery.
- [x] The live-root fact engages W087 fact mode through the seat: a write
      under a declared live root denies `guard-tamper` (T0) where the
      fact-less call was baseline-allow; with a runtime-config root present,
      project `.opencode/**` drafts flip to T2 allow (the designed
      semantic — stated, not hidden).
- [x] Fail-open honored: git failure and an absent runtime-config root omit
      the fact (never guess); existing provider/seat tests unchanged (no
      workspace → no enrichment).
- [x] Verifier: W090 pins RED (compile-level — the seam did not exist) then
      GREEN 9/9; held-out seat/interception suites 21/0 (hub-guard-
      interception, guarded-process, hub-guardless-startup,
      acp-workflow-resolver); repo lint/typecheck exit 0. Review round 1
      [REQUEST_CHANGES] (P1 non-discriminating caller-wins pin — fixed to
      the discriminating shape: repo on a feature branch, caller declares
      `main`, deny must come from the caller's fact; P2 options.workspace
      fallback contradicting the scope narrative — fallback removed,
      enrichment strictly input-workspace-driven; P2 T2 under-claiming
      residual recorded; P3s fixed: detached-HEAD assert, dead test dir,
      inert-fact comment, resolver skipped when all facts are caller-
      supplied) → round 2 verification green.
- [x] Residual recorded (review P2): in fact mode, workspace-internal
      guard-config files (`workflow-guard.jsonc`, the vendored guard's own
      source/dist when the hub runs on this repo) flip deny→allow because
      only the runtime-config root is declared — the designed T2 semantic;
      the boundary is promotion (T1 ask-gate), so this residual is bound to
      the G3 queue item and must be re-classified before any runtime
      consumes workspace-level guard config.
- [x] Hazard fixed en route: the vendored guard `dist/` was stale (built
      pre-W089), masking the file_write tamper lane from hub tests —
      rebuilt; `ensureBuilt()` only builds when dist is MISSING, so
      dist-freshness remains a known hazard (LESS-0005 noted it;
      dist hash-check queued).
- [ ] Queued (one change per iteration): G2 part 2 (`trustedRole` supply +
      seat-role semantics), containment-seat `workspaceRoot` question,
      ostree `/var`-home fix, G5 branch-exit pins, G3 ask channel,
      G4 matched-surface field, dist-freshness pin, `npm pack` verifier
      debt (human-gated).
