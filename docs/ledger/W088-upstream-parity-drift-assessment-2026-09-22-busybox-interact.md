<!-- Ledger fragment: extracted from TASKS.md at line 1943 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W088 - Upstream parity drift assessment 2026-09-22 + busybox interactive port (PRs #153–#176)

**Objective:** keep the parity program current ahead of `opencode-workflow-guard`
retirement (Checkpoint D): classify every upstream change since the W084
assessment (`ed09c84..03fbdcf`, 2026-09-20 → 2026-09-22, upstream v1.15.0) into
converged / host-side-only / queued, and fold in the one verified policy delta.
Finding: #159 is upstream's landing of the W087 design (converged, nothing to
fold); #165's monitor fix is nearly converged by the vendored rewrite — except
busybox applet forms (`busybox top`, `busybox vi` were ALLOWED), case variants
(`TOP`), and the batch-mode exemption being scoppable by a wrapper flag.
Full classification recorded in
`mcp-toolbox/apps/workflow-guard-mcp/docs/policy-coverage.md` (2026-09-22
parity-log entry).

**Where:** `mcp-toolbox/apps/workflow-guard-mcp/src/shell-policy.ts`
(`interactiveReason`), adversarial pins in `test/policy.test.ts`.

**Acceptance criteria:**
- [x] Busybox applet forms of interactive commands are detected:
      `busybox top`/`busybox htop`/`busybox vi`/`busybox nano`/`BusyBox less`
      ask; benign busybox usage (`busybox top -b -n 1`, `busybox echo top`,
      `busybox grep -c top f`, `busybox ls top-level-dir`) stays allow.
- [x] Monitor matching is case-insensitive in executable position only:
      `TOP` asks; `echo Top`, `az keyvault ... --name top` stay allow.
- [x] The batch-mode exemption is the monitor's own flag, not a wrapper's:
      the real exemplars `env -b top`/`timeout -b top` flip allow→ask (red via
      stash choreography); `sudo -b top` stays ask (via the sudo rule, which
      returns before the monitor check — not an exemplar of the scoping);
      `top --batch` stays allow; wrappers and indirection stay detected
      (`timeout 5 top`, `cat file | top`, `sh -c top`, `eval htop`).
- [x] Verifier: new W088 pins ran RED against the unmodified tree (3 tests:
      busybox detection, case variants, and — after the review fix — the
      scoping exemplars) then GREEN after the port (43/43); guard-app suites
      52/0 across mcp+redirect+policy (22 W088 asserts), guard typecheck OK,
      repo `npm run lint` + `npm run typecheck` exit 0.
- [x] Held-out check recorded: `test/package.test.ts` (npm-pack artifact test)
      fails in workflow-guard-mcp AND browser-verification-mcp on a PRISTINE
      main worktree (`npm pack --json` output shape, environment/npm drift) —
      pre-existing on main, unrelated to this diff, verifier untouched.
- [ ] Queued candidates (one change per iteration): the #158 payload-mode
      tamper scan semantic diff (vendored file_write content path scans
      secrets only), boundary deny-reason cause attribution (#172/#173),
      opt-in `requireSubagentReview` strict recorder mode (#167,
      Workflow-side review-gate analog), and the stated divergence that the
      hub reviewer sources `git diff HEAD` (uncommitted) where upstream's
      rubric reviews the committed branch range.
