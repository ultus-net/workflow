<!-- Ledger fragment: extracted from TASKS.md at line 1741 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W084 - Upstream plugin parity port (opencode-workflow-guard, post-vendoring drift)

**Objective:** Port the policy-relevant fixes the original
`opencode-workflow-guard` plugin landed since the vendoring base (upstream
`ec097d4`, 2026-09-09) into the vendored portable core
(`mcp-toolbox/apps/workflow-guard-mcp`). Upstream drifted through 2026-09-20:
quoted-data tamper false positives, collaboration-command exemptions, the
`.opencode/plans/` protected-path exemption, tag-publish git false positives,
and the V2 todo-gate deadlock. The port adapts semantics into the vendored
rewrite; plugin-runtime-only changes (V2 plugin entrypoint, continuation,
verify timeout, TUI slot rendering) are deliberately NOT ported — they are
host-side plugin responsibilities, and Workflow ships no plugins.

**Depends on:** the vendored guard core; no kernel change; the no-plugins
constraint is unchanged (the guard MCP is Workflow-owned, not an OpenCode
plugin).

**Acceptance criteria:**
- [x] Redirect/tamper matching runs on the quote-stripped residue
      (`prepareRedirectResidue` ported): quoted data spans no longer produce
      phantom redirect targets; quoted redirect targets still count; verb
      patterns still run on quote-flattened text (quoted command words stay
      blocked); fd-duplication (`2>&1`) and numeric comparison operands
      (`WHERE count > 5`) are not file mutations, while a real redirect
      alongside them still is.
- [x] Collaboration invocations (`gh|glab issue|pr`, `az repos pr`) are exempt
      from quoted-arg mutation scanning — their quoted arguments are command
      data — while their unquoted redirects still get full validation
      (guarded-path destination, outside-workspace).
- [x] Project plan files under `.opencode/plans/` are exempt from the
      guard-tamper config-path rule (documents, not configuration); the plans
      directory itself, `plansx/` prefixes, `plans/../` escapes, and
      user-level `~/.config/opencode/plans/` stay blocked; the exemption is
      per-candidate so a plans symlink resolving into a config-shaped realpath
      is still denied. The port also closed a realpath gap the vendored
      guard-tamper check had relative to upstream: `isGuardConfigurationPath`
      now checks the realpath candidate behind a lexical path, matching
      upstream's symlink-aware `isProtectedPath` constraint.
- [x] `git tag` publish flows are exempt from protected-branch write rules
      (release, not branch mutation) while tag deletion (`-d`/`--delete`)
      stays flagged; tag-shaped explicit refspecs (`refs/tags/...`) are exempt
      from the protected-branch-push rule while deletion refspecs
      (`:refs/tags/...`) are not. The port is deterministic — no `git
      show-ref` execution (the portable core evaluates host-supplied facts);
      upstream's short-name tag probe (`git show-ref`) is consciously not
      ported — short names stay under the ordinary rule, which only collides
      when a tag is named like a protected branch (that rule's intended
      target). Upstream's merged-branch push rules (which their tag exemption
      also relaxes) do not exist in the vendored core, so no additional
      relaxation is needed.
- [x] The V2 todo-gate deadlock fix is evaluated and consciously **not
      ported as a gate** — the vendored core has no todo predicates
      (policy-coverage lists them as remaining candidates) and the Workflow
      guard dropped the todo requirement in W072. But the evaluation surfaced
      the same deadlock in advisory form: the vendored `guard_status`
      precondition text claimed "an active task in todowrite" — a
      precondition the policy never enforced and OpenCode v2 hosts cannot
      satisfy (native todowrite removed). The text is now host-aware
      (keep an active task/step where the host has a tracking surface;
      otherwise the host's ledger), so the advisory no longer steers a model
      toward an impossible precondition.
- [x] Adversarial regression pins for every ported behavior in the vendored
      test suite (quoted residue, verb flattening, numeric comparisons,
      collaboration exemptions incl. the quoted-target survival, plans
      exemptions incl. the symlinked-realpath case, tag publish/delete, tag
      refspec push incl. the tag-source-to-protected-branch shapes);
      `npm run toolbox:verify` green across the monorepo (guard product
      typecheck+build+tests 0 fail); repo typecheck and lint clean.
      **Five-axis review: first verdict [REQUEST_CHANGES] (independent
      adversarial reviewer, live probes) — P0 tag-source refspec bypass
      (`refs/tags/v1:main` exempted as tag-publish; resolves to
      `refs/heads/main`) and P1 collaboration quoted-redirect-target
      regression — both fixed in `4e65cb2` with regression pins; re-review
      [APPROVE] (2026-09-20, probed 9 deny / 13 allow tag shapes, 44/44 probe
      cases, no over-tightening, no new P0–P2). Known divergences are stated
      in `docs/policy-coverage.md` (numeric-target mutation-signal tradeoff,
      push `--delete`/`-d` flag gate omission, `/dev/null`-family filter
      divergence, quoted-target first-space truncation).**