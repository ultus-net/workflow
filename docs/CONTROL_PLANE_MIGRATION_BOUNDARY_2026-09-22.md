# Control-plane migration boundary — what migrates from the legacy plugin, what stays

> Date: 2026-09-22. Bases, stated precisely: Workflow `origin/main@a80dead`
> (PRs #76/#78/#79 merged). **PR #80 (W090, the seat fact-supply seam) is
> OPEN and unmerged at writing time** — every W090 claim in this doc is a
> branch-state fact on `feat/w090-guard-fact-supply`, not a merged-base
> fact. Plugin reference: `opencode-workflow-guard` upstream **v1.15.0**
> (tag = `03fbdcf`), the version actually deployed and running as the live
> enforcement seat. Produced by base-loop iteration 10 from the operator's
> question: *"is having all plugins and tools as MCPs the right move, or do
> some belong as integrations directly into the control plane?"* — with the
> migration targets for **project memory** and **task enforcement** called
> out explicitly. External verification: frontier critique (**Kimi K3**,
> fresh context, read-only, adversarial) — round 1 verdict **REVISE** with
> 2×P0/6×P1/6×P2; every finding was re-verified against the code before
> incorporation (§8), and the revised draft was submitted for round-2
> re-verification, whose outcome is recorded in §8 as it occurred. Related,
> not superseded: `mcp-toolbox/docs/architecture/accountability-continuity-
> boundary.md` (the extraction test, §1), `docs/AGENTS_RESEARCH_PORT_
> ASSESSMENT_2026-09-22.md` (seat findings G1–G5), `docs/TASK_TODO_LEDGER_
> PARITY.md` (task-enforcement parity), `docs/DURABLE_STATE_INVENTORY.md`
> (durable-state writer authorities), `src/integrations/toolbox-catalog.ts`
> (the toolbox products that already exist).

## 1. The decision rule — four homes, not two

There are four legitimate homes for a capability; the three questions below
decide which. (Round-1 correction: a binary "in-process vs MCP" rule cannot
decide rows like the policy corpus or project memory, whose real answer is
*artifact in the toolbox, consumed in-process by a seat, MCP product for
foreign hosts* — the **corpus/seat split**.)

1. **HOME-A — kernel/application authority** (in-process, canonical): the
   output **gates a run, a mutation, or state advance**, or needs a live
   channel (T1 `ask`, prompts), or is a function of in-process context
   (branch, role, workspace, live roots) that must not be serialized across
   a boundary. Evidence this session: the W087 fact mode stayed dormant
   until W090 built the facts seam; the ask collapse (all five seats reduce
   non-`allow` to deny) is a boundary-shape problem no MCP change delivers.
2. **HOME-B — toolbox corpus, consumed in-process by a seat**: the artifact
   is a pure, testable, host-neutral module whose *decisions the control
   plane acts on*. It lives in the toolbox (one testable corpus,
   `npm run toolbox:verify`) and the seat imports/calls it synchronously.
   The vendored policy modules are the example — plain TS, zero SDK deps
   outside `server.ts`.
3. **HOME-C — toolbox MCP product** (portable surface): the same or sibling
   capability exposed for **foreign hosts** that must be able to consume it
   without being trusted — advisory by nature ("adding more MCP tools does
   not turn an advisory MCP connection into a native-tool interceptor",
   policy-coverage.md). Agent-facing *writes* into durable repo/store
   surfaces belong here too.
4. **HOME-D — host lifecycle** (stays with the host adapter): authority
   derived from controlling the host itself — lifecycle hooks, interception,
   session/idle/compaction behavior, UI feedback. Per the boundary doc's
   extraction test: if the capability cannot produce its result without a
   host lifecycle primitive, it never migrates.

Corollary (honest-claims boundary): **an MCP tool can never be the
enforcement seat.** The seat is the host-side integration that intercepts,
supplies facts, and acts on decisions — in-process by definition, whoever
owns the policy it evaluates. And a dual-surface arrangement (HOME-B+C)
must keep both surfaces under one parity discipline: if the hub imports the
corpus in-process while foreign hosts consume the built MCP dist, any
divergence between src and dist becomes a *behavioral* divergence between
seats — the parity suite must exercise both, or the stale-dist skew returns
as a logic divergence instead of an artifact gap.

## 2. Inventory first: the toolbox already ships much of the accountability layer

Round-1 correction (the doc originally wrote rows 6–8 as extractions):
`src/integrations/toolbox-catalog.ts` already mounts, among others:
`project-context-mcp` (bounded read-only repository task/planning context
discovery), `project-memory-mcp` (durable project memory),
`verification-accountability-mcp` (durable verification observations +
freshness synthesis), `review-accountability-mcp` (subject-bound review
attestations **and durable follow-up debt**), `continuity-checkpoint-mcp`
(read-only continuity recovery), `egress-audit-mcp` (append-only
egress-reach ledger), `learning-mcp` (learner profile, Socratic
checkpoints). So for the plugin's accountability capabilities the migration
question is usually **reconciliation and retirement** (which store, which
contract, which surface wins), not greenfield extraction.

## 3. The plugin inventory → migration verdicts

Every capability the deployed plugin (v1.15.0) exercises, and where it
lands. Plugin paths are `src/…` in the upstream tree at `03fbdcf` (cited
file-level; several verified through the in-repo mirrors rather than the
unreadable upstream checkout — the mirrors are the ported semantics).
Workflow paths are relative to this repo; unless marked **(branch W090)**,
they describe `origin/main@a80dead`.

| # | Plugin capability (source) | Verdict | Target + precondition |
|---|---|---|---|
| 1 | Deterministic policy evaluation — destructive, shell-safety, git, interpreter, mcp, secrets, tamper, boundary (`src/policies/*`, `src/lib/guard-dispatcher.ts`) | **HOME-B+C (migrated)** | `mcp-toolbox/apps/workflow-guard-mcp/src/*` (W084–W089 parity; W090 adds the seat facts — branch state). **NOT yet ported** (remaining portable candidates per policy-coverage.md): manifest/lockfile and documentation preflight decisions. **Refinement queued with a parity precondition:** the hub seat may import these pure modules in-process (they have zero SDK deps) — but only under a parity discipline that exercises both the in-process surface and the built MCP dist for foreign hosts, else the stale-dist skew observed this session returns as behavioral divergence. |
| 2 | Policy simulation (`guard_why`) | **HOME-B+C** | Pure; falls out of #1's in-process import for the hub, or a `guard_why` tool on the vendored server for foreign hosts. |
| 3 | Machine-readable status (`guard_status`: posture, preconditions, gitHygiene snapshot, projectConfig) | **Split** | Static posture → vendored core (exists). Runtime facts (git-hygiene snapshot — executes git) → **HOME-A** gate-observability, fed as host-supplied facts (queued). Git execution does not migrate into MCP. |
| 4 | Durable audit trail (`src/lib/audit.ts`, `guard_audit`) | **HOME-A (reconcile)** | The **W041 review-provenance journal** is the durable workflow journal that exists; the run registry is in-memory and bounded (eviction at 64 — round-1 correction). Plugin audit consolidates into the durable journal; egress-audit-mcp covers the egress-reach ledger slice. |
| 5 | Review attestations (`record_review`, `src/lib/review.ts`) + rubric with real diff (`guard_review_rubric`) + 5-axis gate | **HOME-A (largely done)** | `src/review/*` + `hub-reviewer` + run-registry gating (W039–W041). Remaining: hub rubric-sourcing divergence (hub reviews `git diff HEAD`; upstream rubric reviews the branch range) and making the hub's `/review/rubric` the single rubric surface. |
| 6 | Review follow-up debt (`guard_review_followups`, `_resolve`) | **HOME-C (reconcile with the shipped product)** | **Already a toolbox product**: `review-accountability-mcp` ("subject-bound review attestations and durable follow-up debt"). The workflow-side consumer is advisory-only today (`src/integrations/review-followups.ts` degrades to an empty list). **Design proposal, not present fact** (round-1 P0-1): if open debt should one day gate completion, that gating must be built in HOME-A *reading the same store* — recorded in §6, not asserted here. |
| 7 | **Project memory** (`src/lib/project-memory.ts`; `project_memory_{record,search,export,import}`) | **HOME-C store + HOME-A consumption (reconcile two stores)** | **Two stores exist and must be reconciled, not merged blindly**: (a) the plugin's working-memory index with the repo-local `.opencode/memory/project-memory.jsonl` as a *promotion* surface (`project_memory_import/export`); (b) the Workflow product `project-memory-mcp` storing at `${PROJECT_MEMORY_DATA_DIR:-~/.local/share/project-memory-mcp}/<sha256(realpath)>` mode 0600 under the **W054 provenance-stamp + startup-attestation contract** (unstamped writes fail loudly; unstamped stores fail closed; writer authority **agent** — injection-bearing). Migration = lift the plugin's kinds/supersession/search semantics INTO the toolbox product **preserving the W054 controls**; the plugin becomes one consumer. **HOME-A consumption precondition:** memory facts that *gate* mutations must pass the kernel evidence model, not raw store reads (§6). The shared store-contract extraction is the HOME-B-shaped artifact both surfaces import. |
| 8 | Learning loop (`src/lib/learning.ts`; `learning_*`) | **HOME-C (reconcile)** | `learning-mcp` already ships (learner profile, stage progression, Socratic checkpoints). No gating role; lowest priority; reconcile contracts, retire the plugin tools with it. |
| 9 | Verification (run verify commands, worktree fingerprints; `src/lib/verify.ts`) | **HOME-A execution + HOME-D fingerprint cache** | The hub runs tests via the run-controller (done); kernel mutation-epoch freshness owns gate semantics. The plugin's per-worktree **verify-fingerprint cache** (incl. #156's fail-open-per-entry semantics, host-side per the W088 log) is host-execution state — it retires with the plugin; the hub's run gates do not need a second cache. |
| 10 | Recovery checkpoints (`src/lib/checkpoint.ts`, `guard_recovery_restore`) | **HOME-D, deferred** | Boundary doc: deferred candidate (local mutation/git-overlap/ownership). A read-only continuity product already exists (`continuity-checkpoint-mcp`); a mutation-capable successor is a HOME-A/HOME-D decision for later, not MCP. |
| 11 | Managed worktrees (`src/lib/worktree.ts`, `guard_worktree_{create,cleanup}`) | **HOME-D, deferred (unified with row 10)** | Same deferral class as row 10 (boundary doc groups both). When the mutation-capable successor is built it is a **HOME-A** hub lifecycle operation (like the self-improvement registry), never MCP. Round-1 correction: the two rows previously carried different verdicts without a stated reason. |
| 12 | Durable planning/task context discovery (`guard_next_tasks`) | **HOME-C discovery (exists) + HOME-A sequencing (exists)** | Discovery = `project-context-mcp` (shipped). Choosing/sequencing/gating work = kernel/application (already there). The plugin tool retires when both halves are the consumed surfaces. |
| 13 | **Task enforcement** — todo gates, sequential focus, completion gates (`src/policies/{todo,completion}.ts`, native-`todowrite` bridge) | **HOME-A canonical (in progress) + HOME-D interception (until retirement)** | The W072 split restated: **canonical tasks → steps/evidence gates into the kernel + application gate** — `docs/TASK_TODO_LEDGER_PARITY.md` I-1…I-**10** (round-1 correction; I-6 immutable ledger + append-only execution log is the design that hosts rows 4 and 14's durable targets). Landed at the pinned base: kernel `WorkflowStep` child nodes with evidence-required completion, the Stage-1 native bridge (reviewed 2026-09-20), the W083 step-ledger surface; **not yet landed**: the `NO_ACTIVE_STEP` mutation gate (I-1) and I-6…I-10. What stays host-side is the *interception hook itself* (boundary doc's host-specific list). On stock OpenCode v2 the native todo surface is **gone and the plugin deliberately ships no replacement** (the todo requirement was removed; a v2 `ctx.tool.transform` todo tool was considered and rejected — `TASKS.md` Phase 14), so the practical seat is the control-plane gate plus the W083 ledger surface. Retirement: per the three distinct gates, restated precisely in §5 step 6. |
| 14 | Session-scoped concurrency — file claims, stale-write, mutation journaling, **circuit-breaker escalation counters** (`src/lib/tool-lifecycle.ts`, `tool-outcomes.ts`, `src/policies/{file-claims,stale-write}.ts`) | **HOME-D now; HOME-A later** | High-frequency session state tied to live tool lifecycle — stays with the seat owning the session. Circuit-breaker counters are a documented corpus hole (`GUARD_CORPUS_MAP.md`) and a named Checkpoint D honest-delta item — they move only when the hub becomes the universal seat. Never MCP (state + interaction). |
| 15 | **Split (round-1 correction)**: (a) documentation preflight + manifest/lockfile checks (`src/policies/docs.ts`, changelog/lockfile) | **HOME-B+C (queued port)** | policy-coverage.md classes documentation preflight and manifest/lockfile decisions as *portable candidates when the host supplies changed-path facts* — a port into the vendored corpus (same shape as row 1: in-process seat consumption + MCP for foreign hosts), not an ask-channel item. |
| 16 | (b) post-edit validation execution (`src/policies/post-edit-validation.ts`) | **HOME-D** | policy-coverage.md: "executing configured verification or post-edit validation commands" is a **host adapter responsibility** (executes commands). The hub runs commands via run-controller when a run requires it. |
| 17 | (c) promotion / ask gates (T1 tier) | **HOME-A** | The only part of the old row 15 that genuinely needs the T1 `ask` channel (G3): a seat that passes `ask` through, plus guard-visible `workflow install` recognition. In-process by the interaction test. |
| 18 | Plugin config reading (`src/lib/project-config.ts`) | **HOME-A (own config) + HOME-D (its own)** | The hub reads its own settings in-process; the vendored core takes facts; the plugin keeps reading its config for its remaining lifetime. |
| 19 | Host lifecycle machinery — continuation/Ralph, compaction, session-idle, TUI slots/badges, notifications, tool-description rewriting, environment hooks, V2 adapter (`src/workflow-guard.ts`, `workflow-guard-ui.ts`, `src/adapters/`) — **plus the already-ported hub-side analogs**: completion-claims journal (run-registry), `system.transform` advisory guidance (`buildAdvisoryGuidance`), native `permission.ask` journaling | **HOME-D (plugin side) / HOME-A (hub analogs, done)** | The host lifecycle machinery never migrates (boundary doc's explicit list). The hub-side analogs for the three named channels are already ported (run-registry / FEATURES.md / Phase G decomposition); the plugin's versions retire with it. Session move/rename surfaces visible in the deployed tool catalog belong to the OpenCode harness, not the guard plugin (attribution per the deployed surface; upstream unreadable from the sandbox). |
| 20 | Plugin-local storage (`src/lib/sqlite.ts`) | **Not migrated** | No second database: control-plane durable state + repo/toolbox-local accountability stores, per `DURABLE_STATE_INVENTORY.md`. |

## 4. The two operator-named cases, concretely

**Project memory (row 7).** Today there are **two stores and one plugin in
the middle**: the plugin's working-memory index (with `.opencode/memory/
project-memory.jsonl` as its `project_memory_import/export` promotion
surface) and the Workflow product `project-memory-mcp` (HOME-C, W054
stamp/attestation contract, `~/.local/share` sharded store, writer
authority **agent** — injection-bearing). The migration is a
**reconciliation**: lift the plugin's semantic strengths (kinds,
supersession, bounded search, promotion flow) into the shipped toolbox
product *without dropping the W054 controls*, keep the MCP surface for
agent-facing writes across hosts, and give the control plane a synchronous
in-process read of the same store for orienting/gating work. Two
preconditions: (1) the store contract extracted behind one interface both
surfaces import (the policy-corpus shape); (2) any memory fact promoted
into *deterministic gating* passes the kernel evidence model — context and
authority must not blur (§6).

**Task enforcement (row 13).** Landed at the pinned base: kernel `WorkflowStep`
child nodes with evidence-required completion, the Stage-1 native bridge,
the W083 step-ledger surface. Open: the `NO_ACTIVE_STEP` mutation gate (I-1)
and I-6…I-10 (immutable ledger + append-only execution log, deterministic
validation, durable identity). The migration unit is "the ledger": state
(kernel, I-6), enforcement (application/guard, I-1–I-4), review audit (I-5),
UX interception (host, temporary). The boundary doc's host-specific list
keeps the interception hook host-side; on stock OpenCode v2 the native todo
surface is gone, so the practical seat is the control-plane gate plus the
W083 ledger surface.

## 5. Migration order (target order; landed state noted where it diverges)

1. **Landed:** policy corpus vendored + parity (W084–W089, merged);
   review authority in-process (W039–W041, merged); kernel step nodes +
   native bridge + W083 surface (W072 Stage 1, merged); hub seat facts part
   1 — **branch state, PR #80 open (W090, unmerged)**.
2. **Now:** seat completeness — G2 part 2 (`trustedRole`), G3 ask channel +
   `workflow install` recognition, G4 matched-surface field, G5 branch-exit
   pins; the in-process policy import under the §1 dual-surface parity
   precondition.
3. **Next:** accountability reconciliation — project-memory store contract
   (row 7, preserving W054); review follow-up debt consolidation (row 6);
   audit consolidation (row 4); learning (row 8). Mostly reconciliation:
   the products exist.
4. **Then:** task-enforcement parity — I-1 and I-6…I-10, the G6 adversarial
   corpus on the pinned agent version, ledger-auditing review. Checkpoint D
   spine.
5. **Last:** mutation-capable lifecycle ops (worktrees row 11, recovery row
   10) — HOME-A decisions, not MCP.
6. **Retirement** — three distinct gates, restated without conflation
   (round-1 P1-5): (i) `docs/superpowers/plans/2026-09-15-hub-owned-
   enforcement.md` maintenance item 6 criteria **(a)/(b)/(c)**; (ii)
   `TASK_TODO_LEDGER_PARITY.md` Stage 4's four numbered criteria — corpus
   execution, gated live probes, no-hidden-deltas, and **Checkpoint D
   operator sign-off** (which (a)/(b)/(c) do not contain); (iii) TASKS.md's
   W050 Checkpoint D daily-driver gate is a separate, earlier gate. All are
   per-pinned-version, never date-gated, and the frontier precondition
   ("the hub enforces less than the plugin today") must be false first:
   W090 part 1 closes branch facts + live roots **once merged**; the ask
   channel and role facts remain.

## 6. Residuals / open risks (recorded, not buried)

- **Follow-up debt gating is a design proposal, not a fact**: nothing gates
  on follow-ups today (the consumer degrades to an empty list). If open P2/
  P3 debt should block completion, build that gate in HOME-A reading the
  review-accountability store — do not move the store to justify a gate.
- The stale-dist skew (observed) exists until row 1's in-process import
  lands under its parity precondition; a dist hash/mtime check is a cheap
  interim pin (queued).
- In W087 fact mode, workspace-internal guard-config files flip deny→allow
  (the T2 residual recorded in W089/W090) — re-classify before any runtime
  consumes workspace-level guard config.
- The ask collapse (five seats) is a seat-level fix; no MCP change delivers
  it (G3).
- Memory-promotion into deterministic gating crosses from context to
  authority — kernel evidence model required (row 7 precondition).
- **Attestation wire (row 7 implication)**: giving the control plane a
  synchronous in-process memory read makes it the successor boundary where
  the W054 `attestProjectMemory` runtime wire must be re-attached (the wire
  is parked since the W050 runtime retirement — `DURABLE_STATE_INVENTORY.md`
  coverage gaps). Unstamped durable state must not re-enter through the new
  seat.
- The parity-suite dual-surface precondition (§1 corollary) applies to every
  future HOME-B adoption.

## 7. Verification (frontier, Kimi K3)

Fresh-context frontier critique (Kimi K3 via subagent, read-only,
adversarial instructions: falsify the table row-by-row, enumerate missed
capabilities from the in-repo mirrors, attack the order and the rule).
Round 1 verdict: **REVISE** — findings and dispositions in §8; the revised
draft went back to the same frontier session for round-2 re-verification
(outcome recorded in §8 as it occurred); further rounds are appended the
same way. The durable verdict binding is `record_review` (§9).

## 8. Frontier round — findings and dispositions (Kimi K3)

**Round 1 — REVISE** (2×P0, 6×P1, 6×P2, 4×P3, 7 missed-capability notes,
3 judgment disagreements). Every finding re-verified against the code
before incorporation; all accepted except where noted.

- **P0-1 (row 6) — ACCEPTED.** Follow-up debt is already a shipped toolbox
  product (`review-accountability-mcp`, `toolbox-catalog.ts`), the boundary
  doc classes it a portable candidate, and nothing gates on it (the
  workflow consumer degrades to an empty list). Row 6 rewritten to
  HOME-C-reconcile; the gating idea moved to §6 as a design proposal. The
  reviewer's framing ("the doc invented the dual surface for memory and
  withheld it from the capability whose gating story is weakest") is the
  corrected shape.
- **P0-2 (base pin) — ACCEPTED.** `origin/main@a80dead` = PR #79; PR #80 is
  open; `W090` does not exist in `origin/main:TASKS.md`. Header corrected;
  all W090 claims re-worded as branch-state facts; §5 step 1 marks W090 as
  unmerged. (Found by the critic before any human noticed — the exact
  drift class the honest-records culture exists to kill.)
- **P1-1 (row 1) — ACCEPTED.** changelog/lockfile is not in the vendored
  core (it is a *remaining portable candidate*); row 1's list corrected and
  row 15a added.
- **P1-2 (row 7/§3) — ACCEPTED.** The store description conflated the
  plugin's working index + promotion JSONL with the shipped
  `project-memory-mcp` store; corrected to a two-store reconciliation,
  with the **W054 provenance-stamp/attestation contract** named as a
  must-preserve control.
- **P1-3 (shipped products ignored) — ACCEPTED.** §2 added (the seven
  mounted accountability products); rows 4/6/7/8/10/12 rewritten as
  reconciliation targets.
- **P1-4 (row 15) — ACCEPTED.** Split into rows 15a/b/c with per-item
  justifications matched to policy-coverage.md's own classification.
- **P1-5 (retirement criteria conflation) — ACCEPTED.** §5 step 6 restates
  the three distinct gates and their sources.
- **P1-6 (stale §3 "Today") — ACCEPTED.** Landed W072 Stage 1 pieces moved
  into the record; `NO_ACTIVE_STEP` named as the open mutation gate.
- **P2-1..P2-6 — ACCEPTED.** Rows 10/11 unified (deferred, boundary-doc
  grouping); I-1…I-10 corrected; "dependency-sequenced" softened to target
  order with landed-state notes; run-registry memory-boundedness stated
  (the durable journal is the W041 provenance journal); the rule restated
  as four homes; the header no longer pre-records verification (this §8 is
  the record of it).
- **P3s — ACCEPTED.** Row-index mixup fixed; kernel epoch-freshness vs the
  plugin's verify-fingerprint cache disentangled (row 9); the boundary
  doc's contract-first sequencing precondition — the old false claim
  removed and the substantive form now lives in §5 step 3's
  reconciliation items (the W054/store contract extraction, not the
  boundary doc's evidence-contract-first phrasing);
  `project-context-mcp` credited as the existing discovery half.
- **Missed capabilities — ACCEPTED as rows/notes:** completion-claims
  journal (ported, run-registry), `system.transform` advisory guidance
  (ported), native `permission.ask` journaling (ported), circuit-breaker
  counters (corpus hole; Checkpoint D honest delta; row 14), verify
  fingerprint cache (row 9), session move/rename (attributed to the
  OpenCode harness, row 19 note), browser tools (separate product; scope
  note).
- **Judgment disagreements — ADOPTED (3 of 3):** the four-home restatement
  (replaces the binary rule); the dual-surface parity precondition on the
  in-process import; and disagreement #1 (follow-up debt gets the row-7
  reconciliation pattern, not a control-plane takeover), which was folded
  into the P0-1 row-6 rewrite above.

**Round 2 — re-verification of the revised draft (same frontier session):
REVISE, near the line.** Both P0s and all six P1s verified fixed against
the tree; two remaining/finding-level items: **(P2, new error)** row 13's
clause "the plugin's V2 adapter already bridges its own gate" was a **false
mechanism** — the v2 todo tool was deliberately *not* built (the todo
requirement was removed; a `ctx.tool.transform` todo tool was considered
and rejected, `TASKS.md` Phase 14); the row was corrected to the §4
sentence (no v2 todo bridge; the practical seat is the control-plane gate
plus the W083 surface). **(P2, recurrence of round-1 P2-6)** the round-2
verdict had been pre-recorded in three places (header, §7, §8) — the
offense moved rather than removed; fixed by recording round 2 as occurred
fact (this paragraph) and stating further rounds' outcomes are appended
only as they occur (header). **Four P3s fixed:** the §8 P3 disposition's
phantom "§4 step 3" cite corrected; row 7's label corrected to HOME-C
store + HOME-A consumption (the HOME-B-shaped artifact is the shared
store-contract extraction); row 15's label aligned to HOME-B+C; §6 gains
the attestation-wire residual (the in-process memory read is the successor
W054 boundary). The §8 tally also corrected: three judgment disagreements
were adopted, one folded into P0-1.

**Round 3 — confirmation of the mechanical fixes: REVISE** — one deletion
away: six of seven round-2 fixes verified correct, but the ORIGINAL
round-2 paragraph survived duplicated at §8's tail (asserting a
`record_review` verdict that had not occurred, while the corrected round-2
record sat three paragraphs above), plus one stale "§4 step 6" cite. Both
fixed exactly as specified.

**Round 4 — final confirmation: ACCEPT** — "fit to record as the repo's
durable position." The stale paragraph is gone (a full-file pre-recording
sweep is clean; the only pre-record strings remaining are the historical
records of the defect itself); the §8 cite is fixed; the base pin
re-verified (origin/main = a80dead; PR #80 confirmed open via
`refs/pull/80/head`). Closing attestation quoted: the doc pins its base
honestly, inventories the seven shipped accountability products before
assigning homes, decides rows by a self-consistent four-home rule, restates
the three retirement gates without conflation, records the W054
stamp/attestation contract and its re-attachment boundary as
preconditions, and keeps its residuals stated rather than buried. §8 is an
accurate, append-only record of the critique rounds, including the rounds
where the doc itself was wrong.

## 9. Review record

_(filled by `record_review` at commit time — the durable fingerprint
binding lives in the guard's audit trail.)_
