# Agents-research port assessment — is the Workflow control plane heading the right way?

> Date: 2026-09-22 · Base: `main@d8ab5a4` at write time; PR #76 (W088,
> `decc993`+`4a6abee`) merged to `origin/main@671625c` before the critique
> step (local `main` ref left stale at `d8ab5a4` by the parallel agent's
> flow — the canonical trunk is origin), so every cited path (guard src,
> parity log, W087/W088 ledger entries, `lessons.md`) is verified against
> the merged tree **at `671625c`**. All
> guard-src citations below describe `671625c` byte state; a W089 change set
> (file_write-lane T0 classification) is in flight, uncommitted in the main
> checkout (`mcp-toolbox/apps/workflow-guard-mcp/src/{boundary-policy,
> interpreter-policy,policy}.ts` + `test/policy.test.ts`) at assessment time —
> noted where relevant, not cited as landed. Produced by base-loop iteration 8
> (RSI protocol: propose → predict → implement → evaluate → select → remember)
> from the research corpus at `~/dotfiles/docs/agents/`. Every claim is checked
> against the cited file and line; the frontier-model critique in §7 is the
> external verifier (fresh context, independent code reads), and each of its
> findings was re-verified by the author before incorporation.
>
> Research sources assessed:
> - `rsi-loop-playbook.md` — persistent self-improvement loop design; seven
>   enforced mechanisms; failure-mode table.
> - `policy-review.md` — audit of guard policy decisions against the RSI
>   literature; findings F1–F6; the T0–T3 tier model; the 6-item port
>   requirements checklist; Appendix B (the silently-unloadable guard).
> - `reading-list.md` — the RSI literature base (AHE 2604.25850, STOP,
>   DGM, ACE, Huang et al., Weng's harness/reward-hacking posts).
> - `prompt-design.md` / `task-decomposition.md` — grounding and
>   strong-to-weak routing rules used by this repo's RSI loop itself.

## 1. Verdict (short form)

**The architecture direction is right, and the repo is executing the
research's recommendations in the research's own priority order — for the
deterministic core. The weak point is the enforcement seat, and it is the
opposite of done: the hub feeds the vendored core almost no facts and
collapses `ask` to deny, so today the hub seat enforces fewer of the
research's keep-list rules than the legacy plugin it is meant to retire.**
Concretely at `671625c`: the hub's guard connector supplies no
`currentBranch`, `protectedBranches`, `trustedRole`, or `liveConfigPaths`
(`src/integrations/mcp-toolbox-guard.ts:174-225` — verified), so
protected-branch discipline — which `policy-review.md` lists under "aligned —
keep" — is dead in hub-seated sessions; and all five guard-seat call sites
treat any non-`allow` decision as deny (`src/adapters/
acp-workflow-resolver.ts:72-73`, `src/integrations/
opencode-server-authority.ts:248`, `src/integrations/acp-session.ts:649`,
`src/integrations/opencode-plugin.ts:35`, `src/containment/
workflow-process.ts:17`), so a core-level T1 `ask` cannot exist until a seat
passes it through. The tier model is still the operative design (W087), the
file_write-lane T0 hole is being closed in-flight (W089), and the plugin's
retirement stays correctly parity-gated — but the retirement precondition
list is now nameable: **branch facts, file_write T0, an ask channel, and a
guard-visible promotion command** (§6). `policy-review.md` Appendix B — the
observed case of the guard silently unloading when the config stopped
referencing it — is the strongest research argument that T0 must live above
the config layer, i.e. in the hub seat; it is also exactly why that seat must
reach parity *before* the plugin goes.

## 2. F1–F6 findings → current vendored-guard state

Evidence paths relative to `mcp-toolbox/apps/workflow-guard-mcp/` (byte state
`671625c`).

| Finding | Research port rule | State in vendored core | Evidence | Status |
|---|---|---|---|---|
| F1 branch-creation blocked on protected main, no sanctioned exit; identical intents matched inconsistently | allowlist branch creation; gate commits/edits/pushes, not the exit | Partially fixed, with the inconsistency surviving in a new spelling split: `git checkout -b` is exempt from the protected-branch write-deny (`gitWriteRe` lookahead), but `git checkout <branch>` is denied while its identical-intent sibling `git switch <branch>` is allowed, and `checkout -B` is denied too (case-sensitive `-b` lookahead). The exit is named on every deny by the redirect, and on the file_write lane by the reason text itself. | `src/git-policy.ts:7` (lookahead excludes only lowercase `-b`; `switch` absent from `gitWriteRe`), `src/git-policy.ts:104-107` (the `gitWriteRe`-gated deny), `src/policy.ts:131-132` (file_write lane's reason "Create a feature branch first"), `src/redirect.ts:21` (redirect: "create **or switch to** a feature branch (git checkout -b)" — naming an exit the matcher partly blocks) | **Partially fixed, unpinned** — no vendored test pins any branch-creation behavior (grep 2026-09-22); the `checkout <branch>`/`switch <branch>` asymmetry is F1's own disease in residual form; see §6 G5 |
| F2 draft workspaces conflated with live control plane | T0 deny on live roots, T2 allow for versioned drafts; the safety boundary is promotion, not drafting | W087 step 1 implemented exactly this: host-supplied `liveConfigPaths` make guard-tamper classify by runtime-consumption facts (symlink-aware); drafts elsewhere are allowed | `src/boundary-policy.ts:207-232` (two modes, fail-closed fallback), `:243-247` (fact mode: live roots deny, drafts pass), `TASKS.md` W087 (checked criteria 1–4) | **Design applied; wiring pending** — the hub supplies no facts at all (§4), so practice still runs legacy segment matching (W087 criterion 6 unchecked) |
| F3 path-segment matching in scratch dirs; blocks without a way forward | match on consumption, not filename segments; every block emits a sanctioned alternative | Legacy segment matching remains the default (fail-closed, intended until the fact is wired); fact mode replaces segments with consumption facts. The redirect map is applied to every deny, but for F3's own false-positive class (scratch/draft paths) the `guard-tamper` redirect ("use guard_status (read)") is *not* a way forward — a sanctioned alternative in the research's sense (write on the draft surface) only exists once fact mode is wired and drafts are classifiable | `src/boundary-policy.ts:248-253` (legacy mode), `src/redirect.ts:19` (guard-tamper redirect), `src/policy.ts:66-74` (redirect appended to every deny) | **Partially applied** — same single root cause as F2 (the empty fact-supply seam, §4); the mechanical redirect half is applied but is not a sanctioned alternative for this class |
| F4 content matching censors documentation of the policy | scope rules to file identity and runtime-consumed paths; never match prose | The prose/config-path content matcher never existed in the vendored core (it was a plugin-era defect): the `file_write` content screen is and always was secrets-only (credential patterns), and path rules match file identity (protected system paths, secret filenames). Live corroboration is seat-limited: this document names config paths in prose and passed the guarded edit path, but that seat was the legacy plugin — it speaks to upstream v1.15.0's post-port state, not the vendored core | `src/policy.ts:125-128` (`secretIn` is the only content check), `src/path-policy.ts:56-66` (credential patterns only), `src/path-policy.ts:36-47` (identity-based protected paths) | **Fixed (by never having the defect)** — the defect class is closed in the core the hub will seat |
| F5 agent role files treated as settings (category error) | payload (agent/command markdown) → allow; root config → ask; runtime/auth/policy source → deny | The file_write lane has NO config-path classification at all: payload writes pass (matches payload→allow; the fleet payload ships via the manifest-verified installer instead), but live/project config writes via a direct file_write tool are ALSO unclassified. Plain (non-patch) out-of-workspace writes rely on the application's confinement, not the guard; and an in-workspace project-level `.opencode/` (plugins, config) passes both confinement and the vendored file_write lane — a T0 hole reachable inside the workspace. Upstream closed this in #158 (payload-mode tamper scan); the vendored port is in flight as W089 (uncommitted src+red-pin test changes in the main checkout, 2026-09-22) | `src/policy.ts:109-134` (file_write lane: protected-path, boundary, branch, role — no guard-tamper), `src/policy.ts:120` (workspace-boundary applies only with `patchText`), `src/boundary-policy.ts:256-284` (guard-tamper evaluates shell/git command mutation targets only), W089 in-flight diff (2026-09-22) | **Partial / under-covered at `671625c`; closure in flight (W089)** — see §6 G1 |
| F6 observability returned nothing | every decision = structured record: rule ID, matched surface, decision, reason, alternative | Decisions carry `{decision, policy, reason}` (policy = rule ID) as structuredContent plus leveled MCP log verdicts; denials carry the redirect via the map | `src/policy.ts:36-40` (decision type), `src/server.ts:52-56` (outputSchema), `:63-81` (structuredContent + log verdict), `src/policy.ts:66-74` (redirect on every deny) | **Substantially applied** — residual: the matched surface (path/command) is embedded in `reason` text (e.g. `src/policy.ts:121`), not a separate queryable field; adjacent upstream candidate #167 (strict recorder mode) queued |

## 3. Tier model status (policy-review §Recommended tier model)

| Tier | Research rule | Workflow state (2026-09-22, `671625c`) |
|---|---|---|
| T0 live runtime config/auth/policy source | Deny from agents; non-overridable; logged | Applied on the **shell/git lane** in both modes (legacy segment + fact-based): `src/boundary-policy.ts:261,281`. **Not classified on the file_write lane** (§2 F5) — the live T0 hole, closure in flight as W089. Denials logged with rule ID (§2 F6). **Seat caveat:** in hub-seated sessions none of this sees branch facts, and `ask`-class outcomes would collapse to deny (§4). |
| T1 promotion into T0 (copy/symlink/reload) | Ask; never persistable as "allow always" | **Open for agent-initiated promotion** — `TASKS.md` W087 unchecked criterion 5. Two prerequisites the assessment initially underweighted: (a) no hub seat passes an `ask` through (all five collapse to deny, §4), so a core T1-ask would be a deny in practice; (b) the promotion command is guard-invisible: no guard rule recognizes `workflow install` (grep of `src/shell-policy.ts`, 2026-09-22 — only package-manager `install` forms), so an agent shell-running `workflow install fleet --force` gets baseline allow while the equivalent `cp` is guard-tamper-denied. The "explicit command IS the ask-gate" property holds only when a human types it. |
| T2 versioned drafts | Allow — PR + hooks carry the review | Applied in fact mode (`src/boundary-policy.ts:243-247`): config-shaped paths outside declared live roots are not tamper. Default mode still segments (fail-closed) until wiring. The vendored opencode fleet payload itself is versioned + sha256-manifested in-repo (W086). |
| T3 everything else | Existing defaults | Baseline allow with protected-path/secret/branch/role screens (`src/policy.ts:111-134`). Seat caveat as for T0: the screens that need host facts (branch, role) are inert in hub-seated sessions today (§4). |

## 4. The one-paragraph risk: design ported, seat not fed

The host-supplied fact seam is empty, and it is wider than one parameter.
`guardInputFromToolCall` (`src/integrations/mcp-toolbox-guard.ts:174-225` —
verified against the tree) constructs `GuardCheckInput` with only
`action/command/path/content/patchText/workspaceRoot`; `currentBranch`,
`protectedBranches`, `trustedRole`, and `liveConfigPaths` exist in `src/`
only as type members (`src/policy.ts:26-31` of the guard's contract), with no
hub code that determines them (greps 2026-09-22). Until a seat supplies
these, protected-branch discipline and role confinement are dead letters in
hub-seated sessions, and the W087 fact mode never engages (legacy
fail-closed segment matching everywhere). Independently, every guard seat
collapses non-`allow` to deny (five call sites, §1), so the research's T1
"ask" tier has no channel to reach an operator through even after the core
implements it. `policy-review.md` Appendix B observed the failure mode that
makes this the decisive seat question: when the deployed config stopped
referencing the guard plugin, enforcement silently stopped — gating that
lives inside userland config can be unloaded by the governed process. That
is the research's own argument for T0 living *above* the config layer, i.e.
in the hub seat — and it is why the plugin→hub retirement (Checkpoint D)
must wait until the seat matches the core: retiring early would trade a
loaded-but-imperfect seat for an unloaded-but-emptier one.

## 5. The playbook's seven mechanisms ↔ repo invariants

| # | Playbook mechanism (`rsi-loop-playbook.md` §Seven mechanisms) | Repo counterpart | State |
|---|---|---|---|
| 1 | Predict-then-implement; every edit is a falsifiable claim | The RSI base loop's registered predictions (per-iteration, e.g. LESS-0005/0006) checked by fresh-eyes review against "exactly the registered prediction"; the kernel's evidence-before-advance invariant | Applied at loop level; kernel invariant covers the deterministic core |
| 2 | External verification only; self-critique is not evidence | `VERIFIED` state requires fresh external evidence; `guard_status` verification gate; `record_review` provenance fingerprinting; "self-review is not evidence" is the loop's stated rule — exercised in this very iteration (§7) | Applied |
| 3 | Bounded editable surface; verifier/baselines read-only | Kernel purity rule (no LLM/IO/UI/SDK imports, `AGENTS.md`); tests-never-edited-to-pass hard rule; executable policy corpus (`npm run toolbox:verify`) | Applied |
| 4 | Append-mostly itemized memory with ids | `docs/agents/lessons.md` append-only LESS-ids; `TASKS.md` W-items; append-only archives (`docs/TASKS_COMPLETED.md`). Minor auditability wart: the id sequence has a hole (LESS-0001, 0002, 0004–0007; no LESS-0003 ever existed — `git log -S` empty), worth one deliberate renumber-or-note decision | Applied, with one wart |
| 5 | Archive rejected attempts + failure evidence | LESS-0001 (REJECTED) retained in full with its failure evidence; rejected iterations logged, never deleted | Applied |
| 6 | Meta-loop capability-gated before it edits the improver | Host-surface claims are probe-gated per version (`docs/HOST_ADAPTERS.md`); the RSI meta loop is not running (W073 wiring exists; capability gate honored by not climbing) | Partially applied — correctly dormant |
| 7 | Budget caps, rollback, interruptibility, human gates | Guard project config (verify command, review requirement); hub review control plane; "never commit or push without the operator's direction"; one-change-per-iteration budget | Applied |

The correspondence is close enough to say the repo was built from the same
literature's first principles independently — the mechanism table in the
playbook reads as a description of what the guard/kernel/loop already do.

## 6. Gap list — research-priority order (T0 first), all already ledgered or in flight; none re-filed by this assessment

- **G1 — file_write-lane T0 classification** (§2 F5; upstream #158 port).
  The live T0 hole reachable inside the workspace (project-level
  `.opencode/`); W089 is closing it right now (uncommitted guard src +
  red-pin test changes in the main checkout, 2026-09-22). By the research's
  own "T0 deny, non-overridable" rule this outranks T1 work.
- **G2 — the hub fact-supply seam, broadened** (§4; W087 criterion 6's
  unchecked wiring item, now understood as more than `liveConfigPaths`):
  branch facts (`currentBranch`/`protectedBranches`), `trustedRole`, and
  live roots all need a supplier in the seat, or the keep-list rules they
  gate stay dead in hub-seated sessions.
- **G3 — T1 ask-gate with its ask channel** (W087 criterion 5 + the
  seat-level prerequisite): the core cannot deliver "ask" while all five
  seats collapse non-`allow` to deny; and the promotion command must become
  guard-visible (`workflow install fleet` recognition) so the ask-gate holds
  from the agent seat, not only the operator's keyboard.
- **G4 — decision-record matched-surface field** (§2 F6 residual): the
  structured record carries rule ID + reason but not the matched
  path/command as a separate field; adjacent to upstream #167 (strict
  recorder mode), queued.
- **G5 — branch-exit consistency + missing pins** (§2 F1): pin the allowed
  exits (`git checkout -b`, `git switch -c/-B`-equivalents) and the
  identical-intent siblings (`checkout <branch>` vs `switch <branch>`), so
  the F1 disease does not resurrect in a new spelling. One-line-class pin
  test, cheap; fold into the next guard test touch.

Deliberate non-action: this assessment filed **no new TASKS.md work item**,
because every gap above is already ledgered, queued in a dated record, or
in-flight (W089), and a parallel agent was landing W088 and then starting
W089 while this iteration ran — duplicating ledger entries in-flight is how
the drift this repo keeps killing gets born.

## 7. Frontier-model critique (external verifier — round 1)

Reviewer: frontier model, fresh context, read-only; instructions were
adversarial (falsify the claims, name what was missed). Verdict returned:
**REVISE** — with a direction-paragraph verdict of ALIGN ("the repo is
heading the right way…") conditional on the corrections below. Nine
findings + four missed items were returned; **all were re-verified by the
author against the code and all were accepted** — none rejected. What
changed as a result:

1. **F1 was overclaimed as "fixed by construction"** → corrected to
   "partially fixed, unpinned": `checkout <branch>` denied while `switch
   <branch>` allowed, `checkout -B` denied (case-sensitive lookahead) — the
   research's own inconsistent-matcher disease in residual form (P2).
2. **F1 citations were wrong in two places** → `git-policy.ts:104-107` is
   the deny (not `policy.ts:104-107`, which is the read-only-role block),
   and the "Create a feature branch first" reason text is file_write-lane
   only (`policy.ts:131-132`) (P3).
3. **The wiring gap was framed as one parameter** → corrected to the whole
   fact-supply seam: the hub supplies no branch/role/live-root facts at all
   (`mcp-toolbox-guard.ts:174-225`), so protected-branch discipline is dead
   in hub-seated sessions (P2) — the assessment's single largest correction.
4. **The file_write-lane gap was framed as a queued nicety** → corrected to
   a live T0 hole (patchText-only boundary at `policy.ts:120`; in-workspace
   project `.opencode/` passes everything), with W089 in flight noted (P2).
5. **T1's ask-gate was presented as implementable in the core alone** →
   corrected: all seats collapse `ask` to deny (verified at five sites,
   including one the critic missed: `containment/workflow-process.ts:17`),
   so G3 gained its channel prerequisite (P2).
6. **`workflow install fleet` was credited as partial T1 embodiment** →
   corrected: guard-invisible from the agent seat (no shell-policy rule
   recognizes it; verified by grep), so it is an unguarded promotion path
   there; the ask-gate property is human-at-the-keyboard only (P2).
7. **F3's "redirect half fully applied" overclaim** → corrected: the
   mechanical redirect exists but is not a sanctioned alternative for the
   scratch/draft class (P2).
8. **F4's live corroboration claimed the wrong seat, and "Fixed" implied a
   repair** → corrected to "never present in the vendored core" with the
   seat limitation stated (P3).
9. **The lessons id-sequence hole (no LESS-0003) was unknown to the
   assessment** → recorded in §5 mechanism 4 as an auditability wart (P3).
10. **Missed, all four incorporated:** (a) the hub seat presently enforces
    fewer research-aligned rules than the plugin it is meant to retire —
    the fact-supply seam is empty (branch facts, file_write T0, ask
    collapse), which reshaped §1 and §4 from "one parameter unwired" to
    the seam-level statement; (b) `workflow install fleet [--force]` is a
    guard-invisible promotion path from the agent seat (no shell-policy
    rule recognizes it), folded into §3 T1 and §6 G3; (c) the T1 tier has
    an unmissable prerequisite — a seat that passes `ask` through instead
    of collapsing it, folded into §6 G3; (d) `policy-review.md` Appendix
    B (the silently-unloadable guard) as the decisive argument for the
    hub seat, quoted into §1 and §4; the retirement-precondition list
    (branch facts, file_write T0, ask channel, guard-visible promotion
    command) aggregates (a)–(d) and is now explicit.

The critique's own direction paragraph, verbatim-condensed: the core
embodies the research's keep-list and the tier model is being ported
deliberately; but the seat feeds that core almost no facts and collapses
ask to deny, so "design ported, wiring pending" understates it — the honest
statement is that the hub currently enforces less of the keep-list than the
plugin it is meant to retire. The assessment's §1 verdict was rewritten to
say exactly that.

## 8. Method note

Claims were grounded by reading the actual files cited (2026-09-22), not
inferred from docs or memory; the assessment was written strong-only
(synthesis/verdict work has no executable acceptance check, per
`task-decomposition.md`), with mechanical artifacts (this file's write, the
worktree, the verifier runs) done through the guard's sanctioned paths. The
iteration ran in an isolated worktree (`.worktrees/`, excluded via
`.git/info/exclude`) off `main` because a parallel agent was landing W088
in the main checkout at assessment time (and had started W089 by the
critique round). The frontier critique's findings were themselves
re-verified against the code before incorporation — external verification
is not deferred to; it is checked. All guard-src citations describe
`671625c`; the W089 in-flight diff is dated and never cited as landed.

## 9. Status addendum (2026-09-22, after W089 landed — appended by the W089
session; §1–§8 above remain pinned to `671625c` byte state)

- **G1 (file_write-lane T0) is CLOSED** by W089: commit `84df813`
  (`feat/w089-file-write-classification`, PR #77; the pre-rebase form of the
  same change was the in-flight diff §1–§8 refer to as `95421ea` on
  `feat/w089-file-write-tamper`, which was superseded after PR #78 merged
  because a force-push of the rebased branch is guard-blocked). The
  file_write lane and the interpreter-payload write-target loop now
  classify targets with `isGuardConfigurationPath` — the same
  guard-config vocabulary, plans-file exemption, realpath awareness, and
  live-root fact-mode the shell lane already carried — ordered
  tamper-before-system/secret per upstream precedence (which also removes
  an ostree-specific policy-label masking: `/home` realpaths under `/var`
  on this host, so the pre-existing `/var` rule fired first). Pins red→green
  (43/3 → 55/0), fresh-eyes five-axis review [APPROVE] recorded. Of the
  retirement-precondition list in §1, **file_write T0 is done core-side;
  branch facts (G2), the ask channel (G3), and guard-visible promotion
  recognition (G3) remain open**.
- **Correction to §2 F5's upstream claim**: "Upstream closed this in #158"
  is imprecise — #158 (`c377cb9`, policy-port-rules) is **not merged into
  `origin/main`** (side branch `origin/fix/worktree-fingerprint` only;
  verified via `merge-base --is-ancestor` and v1.15.0 npm source content).
  Mainline closed the write-lane hole long before #158 via its own
  `isProtectedPath` edit/write classification (which is exactly what the
  vendored W089 port mirrors); #158's payload-mode tamper scan and
  markdown-only exemption remain unmerged upstream side-branch material.
  The dated, append-only record of this correction lives in the vendored
  guard's parity log (`mcp-toolbox/apps/workflow-guard-mcp/docs/
  policy-coverage.md`, W088 + W089 entries).
- G2–G5 remain open exactly as listed in §6; G5 (branch-exit consistency
  pins) was consciously not folded into W089's guard test touch — one
  change per iteration.

## 10. Status addendum 2 (2026-09-22, after W090 landed — appended by the
W089/W090 session; §1–§9 above keep their byte-state pins)

- **G2 part 1 is CLOSED** by W090 (`feat/w090-guard-fact-supply`): the
  provider's `guardCheck` enriches every guarded shell/git/file_write call
  carrying a workspace with `currentBranch` (read-only git discovery,
  fail-open to omitted), `protectedBranches` (hub default `["main",
  "master"]` mirroring the vendored plugin's default project config), and
  `liveConfigPaths` (the runtime-config root when it exists). Caller-
  supplied facts win; no workspace → no enrichment. Effect: protected-
  branch discipline engages in hub-seated sessions (on-main writes deny
  `protected-branch-write`), and the W087 fact mode engages for the first
  time in hub-seated sessions (T0 on declared roots; the designed T2 flip
  for project drafts is pinned as such). The seat contract now carries
  `liveConfigPaths` at all.
- **G2 part 2 remains open**: `trustedRole` is deliberately not supplied —
  seat-level role semantics need their own design. The containment seat's
  workspaceRoot-less calls enrich nothing — enrichment is strictly
  input-workspace-driven (the review's round-1 P2: an `options.workspace`
  fallback would have bound branch facts to the hub root while executing in
  a per-call cwd — removed); its sandbox is the boundary, and passing
  workspaceRoot there is queued with care (it would additionally activate
  workspace-boundary denies for legitimate HOME-cache writes).
- **Residual recorded (review P2)**: in fact mode, workspace-internal
  guard-config files (`workflow-guard.jsonc`, the vendored guard's own
  source/dist when the hub runs on this repo) flip deny→allow because only
  the runtime-config root is declared — the designed T2 semantic; the
  boundary is promotion (T1 ask-gate, G3), and this residual must be
  re-classified before any runtime consumes workspace-level guard config.
- En-route finding: the vendored guard `dist/` was stale (built pre-W089),
  so hub-side tests ran an old core — the file_write tamper lane was
  absent from the artifact. Rebuilt for W090; dist-freshness pinning is
  queued.

## 11. Status addendum 3 (2026-09-23, after W091/W092/W097/W098 — appended by
## the W099 session; §1–§10 above keep their byte-state pins)

- **G3 is CLOSED** by W091 + W092 (PRs #83/#84): `workflow install fleet
  [--force]` is recognized as the T1 promotion ask (deny-class policies
  ordered before the ask so compound commands keep reason attribution), and
  the guard ask joins the operator hold in ask-me mode on the authority path
  (held-allow mapping; auto-resolve fails closed to deny). §6's ask-channel
  prerequisite and §10's "guard-visible promotion recognition" half are both
  satisfied. Honest scope note from LESS-0014 still stands: the stock daemon
  constructor passed no guard provider at W092 time; the production wiring
  landed separately as W094 (e767638 + 3668229).
- **G5 is CLOSED** by W099 (feat/w099-g5-branch-exit-pins): the branch-exit
  classification set is pinned AS FOUND (vendored policy.test.ts + 
  redirect.test.ts; characterization pins, green on first run). The pins
  document the F1 asymmetry residual verbatim — `git checkout <branch>` and
  `git checkout -B` denied on a protected branch while the intent-identical
  `git switch`/`switch -C` forms are allowed (the case-sensitive `(?!-b\b)`
  lookahead at `src/git-policy.ts:7`) — so any change now requires a
  decision, not drift. Unifying the spellings is queued as its own iteration;
  the `checkout --` working-tree-discard deny and the W090 no-facts fail-open
  are pinned as load-bearing as-found behavior.
- **G2 part 2 (`trustedRole`)** and **G4 (decision-record matched-surface
  field)** remain open as listed in §6.
