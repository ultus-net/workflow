# Decision brief: the note/artifact store and the care fact store

**Status:** Open - awaiting operator decision (2026-10-17)
**Decision owner:** operator
**Gates:** the hub care view and note view (currently unbuilt by design)
**Context:** `augur/docs/planning-questions.md` Q26, Q28, Q29, Q31; `augur/docs/integration-plan.md` M5/M6/M7

## Why this brief exists

Two hub views stay deliberately unbuilt. Neither has an authoritative data
source the hub can read today: the note view lacks a content read and an
admission surface, and the care view lacks both a decided fact store and a
reality-orientation policy. Building them now would project fabricated or empty
content, which violates the hub's "fabricates nothing" discipline
(`src/ui/webapp/workspace-view.tsx:7`). This brief frames the two decisions so
the views can be built on real data.

## Grounding (what already exists)

The two blockers differ in kind. One is nearly unblocked; the other is a genuine
policy decision.

### The note/artifact side is closer than it looks

- A produced note is already a markdown file on disk. `augur` writes it with
  `writeFileSync(outPath, result.markdown, "utf8")` under the resolved workspace
  (`augur/src/cli.ts:72-79`).
- The hub already lists that workspace. The hub's workspace capability is
  opt-in via `WORKFLOW_ASSISTANT_WORKSPACE`, naming the shared `augur-workspace`
  Azure Files mount (e.g. `/workspace`), and its `POST /workspace` read returns a
  bounded directory listing (root, `truncated` flag, per-entry name/kind/size/
  modifiedMs) (`src/cli/hub.ts:490-496`, `src/integrations/hub-http.ts:323-338`).
- The Workspace view renders that listing and states it "fabricates nothing"
  (`src/ui/webapp/workspace-view.tsx:7`); the listing route itself states the hub
  "never reads file contents" (`src/integrations/hub-http.ts:327`).
- The bounded evidence content store is a different mechanism: it holds only
  `"test-output" | "screenshot"` bytes for the evidence strip, capped at 24
  entries and 256 KiB (`src/integrations/evidence-content-store.ts:22-40`).
  It is not, and should not become, a note store.

So a note view needs a CONTENT read over files that already exist, not a new
store. The decision is about admission and metadata, not persistence.

### The care fact side is a genuine open policy question

The care fact store shape is undecided at the requirement level, not the
implementation level. Three questions drive it:

- **Q26** (`augur/docs/planning-questions.md:1440-1445`): the authoritative store
  of facts about his life and care. Options named: a curated file tree in
  dotfiles (the golden-source pattern); a structured store with a proper edit
  surface; a hybrid (curated core, agent-updated annotations). Care facts change
  weekly, not per-retrospective, and that pressure weighs against the
  curated-file answer.
- **Q28** (`augur/docs/planning-questions.md:1455-1459`): the reality-orientation
  policy when he asserts something false. Options: gentle reality orientation,
  validation without endorsement, deflection and redirect. Must be a hard system
  behavior, not model discretion.
- **Q31** (`augur/docs/planning-questions.md:1474-1480`): does every factual
  assertion get grounded against the store before utterance (expensive, slow), or
  only high-stakes categories (medication, schedule, people), with the rest
  uncorrected. This decides the store's read path and latency budget.

The care view's content depends on Q26 (shape) and its read discipline on Q31.
Q28 shapes what the view must let the operator audit.

---

## Decision 1: note/artifact surface for the hub note view

**Question:** where do produced notes live authoritatively, and how does the hub
read them without becoming a general file browser?

### Option A - workspace-file convention (recommended)

An `augur` run writes each note to a known subdirectory of the shared workspace
(for example `<workspace>/notes/<date>-<slug>.md`) with a small sidecar of
admission metadata. The hub note view lists that subtree through the existing
`POST /workspace` pattern and reads a single note's content through a new
bounded `POST /note-read` route confined to that subtree. Like `POST /workspace`,
the new route is operator-token authorized (`authorizeHubToken`,
`src/integrations/hub-http.ts:4,209`) and withholds itself (404) when the
workspace capability is unset. The read route is net-new: the existing listing
route deliberately reads no file contents
(`src/integrations/hub-http.ts:323-338`), so it is the read-free precedent, not
the read itself. Its bounds mirror the evidence store's discipline
(`src/integrations/evidence-content-store.ts:22-40`): a path-confinement
allowlist (the notes subtree only) and a per-note byte cap.

- Pros: no new store; reuses the share, the mount and listing route the hub
  already has when `WORKFLOW_ASSISTANT_WORKSPACE` is set; notes stay diffable
  files on disk, matching the "config is policy" and golden-source patterns; the
  assistant and the operator see the same bytes.
- Cons: needs an admission sidecar (title, source, date, run id, verdict
  summary) so the view is not a raw file browser; needs the bounded read route
  and its own path-confinement test.
- Effort: small. One write convention in `augur`, one bounded read route, one
  view, all following W197's shape.

### Option B - registry-backed notes

A run records each note in a hub-side registry (run id, path, verdict counts,
digest). The view lists registry rows and reads content by path.

- Pros: the list query is structured and cheap; admission metadata is
  first-class; supersession and dedup are expressible.
- Cons: a second thing to keep in sync with the filesystem; risks the "two
  sources of truth" defect class the learner-profile work just closed; more code
  than the content warrants today.
- Effort: medium.

### Option C - extend the evidence content store

Add `"note"` to the stored kinds and route notes through it.

- Rejected in the framing, listed for completeness: the store is a bounded
  24-entry, 256 KiB preview buffer for the evidence strip
  (`src/integrations/evidence-content-store.ts:22-40`). Notes are durable,
  unbounded in count, and not preview fragments. Overloading it would evict
  captures and misstate durability.

**Recommendation: Option A.** Notes are already files, the hub already lists the
directory, and the only new surface is a bounded, path-confined content read
plus an admission sidecar.

**What the view shows once A lands:** title, source, produced-at, run id, the
verification verdict summary (from `result.lint` / `result.blocked`,
`augur/src/cli.ts:83-89`), and the note body. Full state cycle: loading, error,
empty (no notes yet), populated, plus the hub's truncation notice.

---

## Decision 2: the care fact store shape (Q26), with Q28 and Q31 discussed

**Question:** what is the authoritative store of care facts, and how does the
care route read it. (Vocabulary: the *care route* is the identity-scoped
assistant route; the *care loop* is the runtime turn that emits a care reply;
the *care view* is the hub surface the operator audits.)

### Option A - curated file tree (golden source)

Care facts live as human-edited files (YAML or markdown) in dotfiles, the
golden-source pattern. The runtime loads and indexes them read-only; the agent
never writes.

- Pros: maximal operator control; matches the lessons-registry and style-pack
  discipline; a care-fact change is a reviewable diff; the strongest story for
  Q31 (the store is small, curated, known).
- Cons: care facts change weekly, and a schema-less file tree is awkward to
  query; the operator carries the edit load (Q26 flags this tension).
- Fitness for Q28: strong. The reality-orientation policy is a fixed config
  value alongside the facts, set with professional input.

### Option B - structured store with an edit surface

A structured store (SQLite, or a typed JSON document with a validation schema)
behind a small hub edit surface. The operator edits through the hub; the runtime
reads.

- Pros: real schema and validation; an audit trail on edits; scales to weekly
  churn; queryable without a bespoke index.
- Cons: the largest build; a new store to back up and version; the edit surface
  is its own security surface.
- Fitness for Q28: strong, if the policy value is a typed field with a
  write-audit.

### Option C - hybrid (curated core, agent annotations) (recommended)

A curated core is authoritative and human-edited; the agent may attach
annotations (timestamps, observed counters) that never override core facts.

- Pros: preserves operator authority while letting the runtime record what it
  observed; matches the evidence-based, annotated instinct elsewhere.
- Cons: the core-versus-annotation boundary must be enforced in code, not
  convention, or it degrades into Option B with unclear authority. It inherits
  Option A's con: the authoritative core is still human-edited, so the operator
  carries the edit load for facts that change weekly. Q29 (self-reported claims)
  already points at the annotation channel, so this option also gives those
  claims a home. The gain over Option A is the inert home for observations that
  must never become assertions.
- Fitness for Q28: strong, same as A, with the annotation channel kept out of
  the authoritative read.

### Cross-cutting: the Q31 read path (applies to all three)

Q31 asks whether every factual assertion is grounded before utterance, or only
high-stakes categories:

- **Ground-everything:** every care utterance passes through the store and a
  verdict gate before emit, the way `verify.ts` blocks notes
  (`augur/src/verify.ts`, per-claim verdicts, block gating). Slow and expensive,
  but uniform. The store answers a lookup on the hot path.
- **High-stakes-only (medication, schedule, people):** ground those categories;
  everything else is uncorrected. Cheaper, but the uncorrected band is exactly
  where a wrong name or date does damage.

**Recommended rule, sharper than a category split:** the curated core is the
ONLY source of factual assertions. The annotation channel lives beside the core
and is excluded from the authoritative read, enforced in code, not convention.
The rule is not a category split, so there is no expensive per-claim LLM
grounding call to trim later: a claim is a keyed lookup against a small curated
core, not a separate reasoning pass. The fail-closed surface is structural.

**Two behaviors, two triggers (resolving the Q28 relationship).** The core
enforces two distinct things, and conflating them is why Q28 looks like it gates
the whole rule:

- **Not asserting what is not in the core (structural, no Q28 needed).** A
  claim absent from the core is simply not emitted. This is the fail-closed
  default and it needs no policy value: silence is the fallback.
- **How to respond when the user asserts something false (needs Q28).** When
  the user himself asserts a falsehood, the system must choose: gentle
  orientation, validation without endorsement, or redirect. That choice IS the
  Q28 policy and has no structural default. It is the behavior the care view
  must let the operator audit, so Q28 is a GATING dependency for the care view.

**Enforcement point (named, so the rule is operative):** the assertion gate sits
at the care loop's pre-emit step, the same position `verify.ts` blocks notes
(`augur/src/verify.ts:159-190`). Every outgoing factual claim is checked against
the authored core. The gate reads the core only; the annotation channel is never
a source, at read or render time. This gate does not need Q28 to be fail-closed:
an ungrounded claim is dropped. Q28 governs the separate false-user-assertion
response above.

**Annotation channel is inert data.** An annotation is never asserted unless it
is promoted into the authored core by the operator. The brief states no
automatic promotion path; promotion is a deliberate human edit, which is the
point of choosing the hybrid over a pure structured store.

**Recommendation: Option C for the store, the curated-core-only assertion rule
for the read.** The hybrid keeps operator authority (facts stay human-edited),
gives self-reported claims an explicit home (Q29), and confines the annotation
channel out of the authoritative read.

**Q28 caveat.** The reality-orientation policy value itself is NOT settled by
this recommendation and should not be. Q28 is flagged in the plan as needing
professional input; the operator sets that value with clinical advice. This
brief recommends only the store shape (C) and the read rule (curated core only).

---

## What unblocks once decided

- **Decision 1 (recommended A):** the hub note view becomes buildable on real
  data. No store build; one bounded read route and one view.
- **Decision 2 (recommended C + curated-core-only):** the care fact store and
  the read rule get their contract, so the care view's data side is buildable.
  The assertion gate is fail-closed without Q28 (an ungrounded claim is dropped).
  Q28 still gates the care view's full behavior: it supplies the
  false-user-assertion response the view must expose. Decision 2 unblocks the
  store and the read; Q28 remains the one open item before the care view ships.

## What stays deferred regardless

- The real notification channel for `notify-mcp` (Discord/email/ntfy/SMS) is a
  separate decision; the seam is built (W208) and a recording channel stands in.
- M7's curated loop, fact-grounded replies, and probe suite all wait on
  Decision 2.
