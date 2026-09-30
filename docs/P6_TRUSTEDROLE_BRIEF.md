# P6 — The G2 part 2 `trustedRole` supply decision (DECISION brief)

Status: **design-open** — a decision input, not a decision. No code changes.
Issue: #285 (the last open P6 item; G2 part 2 `trustedRole`).
Author: P6 trustedRole-brief subtask, 2026-09-30 wave.
Date: 2026-09-30.
Predecessor: `docs/P6_SEATS_ASK_DESIGN_BRIEF.md` §5 / Q5 (2026-09-30), which
framed the question and deliberately did not decide it.

Truth lives in the cited files; where this brief and the tree disagree, the
tree wins. This brief decides nothing — the choice is the operator's (Q5).

## 1. What `trustedRole` actually is (and is not)

`trustedRole?: string` exists on the guard input contract on both sides of the
MCP boundary:

| Side | Declaration | Consumer |
|---|---|---|
| Workflow connector | `GuardCheckInput.trustedRole?` — `src/integrations/mcp-toolbox-guard.ts:38` | passed as MCP tool `guard_check` arguments |
| Vendored guard | `GuardCheckInput.trustedRole?` — `mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts:33` | `isReadOnlyRole` |
| MCP schema | `trustedRole: z.string().optional()` — `mcp-toolbox/apps/workflow-guard-mcp/src/server.ts:48` | accepted verbatim |

**What it does.** `isReadOnlyRole` (`policy.ts:52-58`) lower-cases and trims
the value and matches it against a **closed set** — `reviewer, planner,
advisor, critic, explorer, scout, evaluator` — by **substring**
(`normalized.includes(candidate)`, so `"Senior Explorer Agent"` matches). On a
match the guard **denies**:

- `action: "git"` commands carrying a git mutation — `policy.ts:141-143`;
- `action: "shell"` commands carrying a shell file mutation or git mutation —
  `policy.ts:144-147`;
- any `action: "file_write"` — `policy.ts:194`.

**It is a constraint-only input.** It can only add a `deny` to a call that the
rest of the policy would otherwise `allow` (the read-only block runs *after*
boundary/interpreter/git/shell/promotion/pr and *before* protected-path/
secret/workspace-boundary — `policy.ts:113-148`, `:186-195`). Supplying
`trustedRole` **cannot turn a deny into an allow**, and it authorizes nothing
new. The security-relevant fact is **identity**: which seat/session is a
read-only role, and who attests it.

**What it is not.** It is not a capability and not a session-state gate; the
kernel/application still own capability withholding, workspace confinement and
task gating independently. It is a defense-in-depth screen inside the vendored
guard.

### 1.1 What the seat supplies today

The pure tool-call → guard-input mapper `guardInputFromToolCall`
(`src/integrations/mcp-toolbox-guard.ts:331-382`) builds only
`action/command/path/content/patchText/workspaceRoot`; **no role**. The
enrichment seam (`guardCheck`, `mcp-toolbox-guard.ts:106-132`) fills only
`currentBranch`, `protectedBranches`, `liveConfigPaths` via
`createGuardFactsResolver` (`:256-304`), and only for workspace-carrying
`shell`/`git`/`file_write` calls, caller-supplied facts winning and absence
staying absent. The contract comment states the deferral verbatim:
`mcp-toolbox-guard.ts:253-254` — "`trustedRole` is deliberately NOT supplied
here — seat-level role semantics are a separate design decision (queued)."
Result: every guard seat runs with the role lane **inert**; read-only intent
is unenforced *at the guard* everywhere (assessment §10/§11; P6 row).

## 2. The trust boundary: who could assert the role, and from what

The guard is a separate stdio MCP process (`mcp-toolbox-guard.ts:81-89`). Its
`guard_check` arguments are constructed **by the Workflow seat**, not by the
agent. That places the role fact entirely on the seat's side of the boundary:

- **Trusted by construction** — values the seat derives from trusted
  composition: operator/launcher configuration, kernel-derived session
  identity, the seat's own choices (e.g. the enrichment facts read from git).
- **Agent-influenced (untrusted)** — anything from the ACP wire: the
  permission request's `title`, `kind`, `rawInput`, `locations` (the resolver
  already documents this class: "tool names arrive from the agent's
  permission-request titles, the same trust boundary as capability
  classification" — `src/adapters/acp-workflow-resolver.ts:121-128`), and any
  session label the agent can set.

### 2.1 The ACP permission resolver carries **no** role metadata

The resolver's inputs are:

- `AcpPermissionRequestParams` — `sessionId`; `toolCall{ toolCallId, title?,
  kind?, rawInput?, locations? }`; `options[]` (`src/adapters/acp-permission.ts:10-20`).
- `AcpPermissionCorrelation` — `sessionId`, `agentSessionId`, `taskId`,
  `toolName`, `capability` (`acp-permission.ts:22-28`), assembled at the
  composition site `src/integrations/acp-session.ts:649-661`.

The correlation fields are kernel-derived and trusted, but **none of them is a
role**. The ACP request fields are exactly the agent-influenced class. So the
resolver has **no trusted role metadata to read**. A literal "supply
`trustedRole` from the ACP permission resolver's trusted metadata" therefore
has no trusted source today: any implementation must *introduce* a new trusted
input (see §3 option ii).

## 3. The options

### (i) Leave it unsupplied (status quo)

- **Changes:** nothing. The role lane stays inert; the guard behaves exactly as
  it does today.
- **Who asserts / provenance:** nobody; no role fact exists, so none is
  fabricated.
- **Fail-closed:** fully preserved — no new trust surface, no value that can be
  misread as identity. Read-only intent continues to be enforced (where it is
  enforced) by the **kernel/application capability set**, not the guard. The
  hub reviewer is already constructed with `new Set(["read"])`
  (`src/cli/hub.ts:151-157`) and the review rubric tells the reviewer
  "shell commands are not available to you" (`src/review/rubric.ts:88-92`).
- **Security implication / residual:** the guard's read-only screen stays dead
  (G2 part 2 open). A read-only-by-role seat that *does* hold mutation
  capability at the kernel gets no guard backstop. No security regression
  relative to today; a defense-in-depth gap remains, stated.

### (ii) Supply from the ACP permission resolver's trusted metadata

- **What it would actually require:** because §2.1 shows no trusted role exists
  on the ACP path, this option becomes: add a **trusted composition-time role**
  to `WorkflowAcpPermissionResolverOptions` (or a per-call fact to the guard
  provider) and pass it into the `guardCheck` input at
  `acp-workflow-resolver.ts:73`.
- **Who asserts / provenance (the conditions):**
  1. The value must originate from **trusted composition** — the trusted
     launcher/operator deciding "this session/seat is role R" — never parsed
     from `request.toolCall.title/kind/rawInput/locations` or any agent-set
     label. Parsing the wire would launder an agent-influenced value as a
     trusted identity fact.
  2. The value should be validated against the guard's **closed role set**
     (`policy.ts:52`) or documented against that vocabulary; a role outside it
     (`"auditor"`, `"observer"`) silently produces *no* read-only enforcement
     ("false non-read-only", below).
  3. Enrichment applies only to workspace-carrying `shell`/`git`/`file_write`
     calls (the existing seam discipline); caller-supplied facts win; absence
     stays absence.
- **Fail-closed:** the guard decision itself cannot loosen (§1: deny-only). The
  posture that can be weakened is **provenance honesty**, not capability:
  sourcing the value from the wire (condition 1 violated) would produce a
  system that *claims* identity enforcement it does not have. Today that is
  harmless because the lane is deny-only, but the claim is false and any future
  broadening of role semantics (a privileged direction) converts it into
  escalation. The narrower, safer reading of option (ii) is therefore
  indistinguishable from (iii) in mechanism, only wider in plumbing.
- **Security implication / residual:** wider blast radius than (iii) (a
  per-request/per-session plumbing path), and a temptation to derive the value
  from agent-influenced context. Residual: the substring matcher's
  over/under-match (`"amateur"`? no closed token; `"critic-adjacent"` matches
  `critic`) means the *value's spelling* is a security input, not just its
  presence.

### (iii) A narrower alternative: one trusted composition root, one read-only seat

- **What it changes:** supply a **static, composition-time** role at a single
  trusted root for a named read-only seat, rather than threading a general
  per-session role through the resolver. Two shapes:
  - a dedicated guard provider instance for the read-only seat, constructed
    with the role (e.g. `createWorkflowGuardMcpProvider({ ..., role: "reviewer" })`
    or an explicit enrichment option), leaving the shared provider unchanged; or
  - a per-call fact injected only by that seat's composition (the seat sets
    `trustedRole` on the `GuardCheckInput` it already constructs), which needs
    no change to the shared `factsResolver`.
- **Who asserts / provenance:** the same trusted root that already decides the
  seat's capabilities (e.g. the hub reviewer factory at `src/cli/hub.ts:147-157`)
  asserts it; the value is a literal in trusted code, not derived from wire
  data. The shared guard provider at `src/cli/hub.ts:95-103` is **not** given a
  role, so `/bash` and every agent session keep the status-quo behavior.
- **Conditions:** provenance is composition-time (condition 1 of ii); the value
  is one of the closed set (condition 2); only the designated seat gets it.
- **Fail-closed:** unchanged for every session that does not get the fact;
  the designated seat gains only the ability to be denied more (deny-only).
- **Security implication / residual:** adds one new trusted constant and one
  composition seam; the design must ensure the role cannot be routed from a
  session the agent controls (it is a code literal, so it cannot). Cost: the
  read-only seat's real mutation gate is still the kernel capability set; the
  guard role is defense-in-depth, so the marginal security gain is bounded and
  must not be *claimed* as the seat's enforcement.

## 4. What stays fail-closed in every option

- The guard's other lanes (boundary, interpreter, git, shell, promotion, pr,
  protected-path, secret, workspace-boundary, branch-write) are untouched by
  `trustedRole` and keep their decisions.
- No option makes the guard *allow* anything it denies today; the field is
  deny-only.
- No option changes the kernel/application capability posture, workspace
  confinement, or task gating. The reviewer's `{read}` capability set is the
  primary read-only gate today and stays so.
- Absence of the fact continues to mean "no role screen", which is the status
  quo — **not** a fail-closed role default (there is no read-only-by-default
  lane in the vendored core; this must not be misread as one).

## 5. Recommendation (the DECISION remains the operator's)

**Recommend (i) as the correct default now, with (iii) as the only
non-fabricating forward path if the operator later wants the guard's read-only
lane live; do not implement (ii) as literally scoped, because no trusted role
exists on the ACP path and sourcing it from wire metadata would launder an
agent-influenced value as an identity fact.**

- **Core trade-off:** (i) keeps provenance honest and adds no trust surface, at
  the cost of leaving the guard's read-only screen inert — but the *actual*
  read-only enforcement for the one read-only seat that exists today (the hub
  reviewer) is already below the guard, in the kernel capability set
  (`hub.ts:155`) and the review rubric (`rubric.ts:88-92`), so (i) loses less
  than the "G2 part 2 open" framing suggests. (iii) makes the screen live and
  scoped at the cost of a new trusted constant plus a composition seam, and its
  benefit is defense-in-depth only.
- **Why not (ii):** the resolver's trusted fields (correlation) carry no role
  (§2.1); implementing (ii) means inventing a new trusted source, at which
  point it is (iii) with more plumbing and a larger surface on which a future
  author could reach for agent-influenced metadata.
- **Decision input, not decision:** this brief records the options, their
  provenance conditions, and their residuals. The operator chooses Q5
  (source, trust, and which seats carry it) before any implementation.
- **Red-first pin if an option is chosen:** assert the configured role reaches
  `guardCheck` and that a read-only role's `file_write`/`git`/shell mutation is
  denied (`policy.ts:141-148`, `:194`), while an unsupplied seat is
  byte-unchanged.

## 6. Non-goals

- Not deciding Q5; not supplying `trustedRole`; not changing any `src/`,
  vendored-guard, or test file.
- Not re-designing role semantics, the role vocabulary, or the
  `isReadOnlyRole` substring matcher.
- Not re-opening the four-seat ask channel, the plane-3′ surface, the daemon
  lane, the containment ordering, or Q1/Q2/Q3/Q4/Q6.
- Not claiming the guard role as the reviewer's read-only enforcement (it is
  defense-in-depth; the kernel capability set is primary).

## 7. What this brief is and is not

Docs-only. No `src/`, vendored-guard, or test change; `npm run lint`,
`npm run typecheck`, and `npm run build` are **not applicable** and are **not
claimed**. Every claim above is pinned to a cited file:line in the tree at this
branch's base (`origin/main` @ `a06139d2`). The predecessor brief
(`docs/P6_SEATS_ASK_DESIGN_BRIEF.md` §5) framed Q5; this brief supplies the
decision input for it and decides nothing.
