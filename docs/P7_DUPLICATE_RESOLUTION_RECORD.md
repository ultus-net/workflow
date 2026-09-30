# P7 duplicate-resolution record — W093 / W096 (the serverless-hosting operator intent)

**Date:** 2026-09-30 · **Status:** reconciliation **PROPOSAL only** — **the
resolution is the operator's call.** · **RESOLVED 2026-09-30: the operator
chose Option A — see §5 (added 2026-09-30).** Nothing here deletes, merges, or rewrites
either record; both ledger fragments stay byte-for-byte as landed. · **Item:**
parked P7 (`docs/PARKED_AND_LIMITATIONS.md:36`, issue #286; surfaced
2026-09-24 by the contradiction sweep merged as PR #107). · **Sources read in
full:** the P7 row (`docs/PARKED_AND_LIMITATIONS.md:36`); the two ledger
fragments (`docs/ledger/W093-serverless-hosting-option-for-the-control-plane-az-function-.md`,
38 lines, and
`docs/ledger/W096-serverless-hosting-option-for-the-control-plane-az-function-.md`,
33 lines) and their pre-freeze TASKS.md blocks (`TASKS.md:2200`, `:2357`); the
sweep's record (PR #107, `docs/w098-status-and-residual-26`, commit `9ecf2c79`
— "fix the status/registry contradictions"; the parked-file creation record
`docs/ledger/W116-the-parked-items-and-limitations-registry-file-complete-the-.md:5-10`);
the batch-3 hosting assessment
(`docs/HOSTING_ASSESSMENT_2026-09-30.md`, ledger fragment
`docs/ledger/HOSTING-ASSESSMENT.md`); the protocol-planes map
(`docs/PROTOCOL_PLANES_2026-09-22.md`).

---

## 0. What P7 asks

The P7 row states the whole thing in one cell
(`docs/PARKED_AND_LIMITATIONS.md:36`):

> **W093/W096 duplicate resolution** — the same operator-intent item
> (serverless hosting, 2026-09-22) recorded twice; merge into one or supersede
> one. **Operator's call** — both are operator-intent records; W096 carries the
> fuller constraint enumeration, W093 the plane-3 loopback facts.

Two records were created for the same operator intent during the 2026-09-24
session that produced the contradiction sweep (PR #107). The honesty rules
(`AGENTS.md`, "Dated records are append-only") forbid silently deleting one.
So P7 is not a merge-mechanically item; it is a **decision-first** item: the
operator names one canonical record and the other gets a dated supersession
note, or the operator directs a merge. This file supplies the side-by-side
input. It records no decision.

## 1. The two entries side by side

Both are **operator-intent records**, not agent-authored design: the intent
("the control plane will likely run as an Azure Function — a serverless hosting
option alongside the local daemon") is the operator's, dated 2026-09-22 in both,
and both carry status *intent-only, no design, no claims*.

| | W093 | W096 |
|---|---|---|
| Fragment | `docs/ledger/W093-…-az-function-.md` | `docs/ledger/W096-…-az-function-.md` |
| Title | "…(Planned — intent recorded, design queued)" | "…(Planned - intent + constraints only)" |
| Operator intent, date | 2026-09-22 (`:5`) | 2026-09-22 (`:5`) |
| Status line | "intent + constraints only. No design, no claims." (`:8`) | "intent recorded; design queued." (`:7`) |
| Shape | Bulleted; a "what the hub is today" paragraph + five citation-bearing constraint bullets | Compact single paragraph enumerating the re-opened surfaces |
| Unique content | **The plane-3 loopback facts**: "the hub today is a local daemon: plane 3 binds loopback-only (`127.0.0.1`, discovery-file tokens), plane 3′ is the uncredentialed browser channel (`THREAT_MODEL.md`-accepted loopback posture), agent transports are local stdio/ACP, containment is bwrap, and durable state is local files" (`:8-12`) | **The fuller constraint enumeration**: one sentence naming every re-opened surface — plane-3 auth, the plane-3-prime channel, agent transports, containment, durable state, long-running loops (`:7-16`) |
| Citations in the constraint text | `PROTOCOL_PLANES_2026-09-22.md`, `OPENCODE_REMOTE_ACP_SPEC.md`, `DURABLE_STATE_INVENTORY.md` (explicit, per bullet) | `PROTOCOL_PLANES_2026-09-22.md`, `DURABLE_STATE_INVENTORY.md` (inline in the paragraph) |
| Acceptance criteria | hosting assessment "per the **four-plane map** … with the THREAT_MODEL re-read"; plane map re-stated "what moves, what stays local, what the credential model becomes"; operator decision recorded (`:32-38`) | hosting assessment "per the **plane map**"; plane map re-stated for the hosted topology; operator decision recorded (`:28-33`) |
| Extra mark | — | Carries the inline **DUPLICATE note** (found 2026-09-24, contradiction sweep), `:18-26` — i.e. W096 is where the sweep's finding itself was recorded |

**The shared intent.** Both records state the same operator intent on the same
date: the control plane will likely run as an Azure Function alongside the
local daemon. Both state the same status (intent only), the same protocol-planes
source, and the **same single open deliverable**: the hosting assessment
(AZ Function vs container-app vs stay-local) with a THREAT_MODEL re-read,
followed by an operator decision. **No work is queued twice** — the criterion
is one deliverable recorded in two places (`docs/ledger/W096-…-az-function-.md:25-26`).

**The differences.** They are two *renderings* of one intent, not two
intents. W093 is the longer, bulleted, citation-bearing version and uniquely
carries the **plane-3 loopback facts** (the "hub is a local daemon" paragraph) —
the load-bearing trust-boundary detail. W096 is the compact version and
uniquely carries the **fuller one-paragraph constraint enumeration** of all the
re-opened surfaces in a single place, and is the record that carries the
sweep's DUPLICATE finding itself. Nothing in either contradicts the other;
there is no factual conflict to reconcile, only a canonicity question.

## 2. The cross-reference: the batch-3 hosting assessment

The intent both records carry is exactly the deliverable the batch-5 hosting
assessment serves: `docs/HOSTING_ASSESSMENT_2026-09-30.md` (issue #140; landed
in the 2026-09-30 wave's batch 3, its ledger fragment recording the PR as "to
be linked at open" — `docs/ledger/HOSTING-ASSESSMENT.md:7`). Its
own framing names the W093/W096 items as "the open decision it informs"
(`docs/HOSTING_ASSESSMENT_2026-09-30.md:11-16`) and cites the W093 fragment
throughout — for the two-credential-class plane-3 boundary (`:307`), for the
five re-opened surfaces (`:161-168`), for the long-running-loop mismatch
(`:134-137`, `:324`, `:357`), and for the operator-decision criterion
(`:371-375`). The assessment answers the *technical* half of both records'
open criterion (the three options, assessed against recorded machinery) and
records a recommendation; it explicitly records **no decision** — the hosting
choice stays the operator's, exactly as the P7 resolution does.

Practical consequence for P7: **the batch-5 assessment cites W093 exclusively,
by line.** Any resolution that demotes W093 from canonical would stale those
citations. This is evidence for the recommendation below, not a decision.

## 3. Proposed resolution (the operator's call)

Three shapes are available; the operator picks one. **All three are proposals —
none is applied by this record.**

- **Option A (recommended) — W093 canonical; W096 gains a dated supersession
  note.** W093 is the canonical W093/W096 entry; W096 gets an appended dated
  note (2026-09-30) saying it is superseded by W093 as canonical, that its
  fuller constraint enumeration remains preserved in place and is not deleted,
  and that the batch-3 hosting assessment cites W093. Rationale: W093 carries
  the plane-3 loopback facts, the expanded citations, and is the record the
  batch-5 assessment cites by line, so this is the least-churn reconciliation
  and it keeps the assessment's citations stable. Cost: the "fuller constraint
  enumeration" the P7 row attributes to W096 stays in a superseded record
  rather than the canonical one.
- **Option B — W096 canonical; W093 gains a dated supersession note.**
  Rationale: W096 carries the fuller constraint enumeration (the P7 row's own
  emphasis) and already carries the sweep's DUPLICATE finding. Cost: it stales
  the batch-5 assessment's W093 line citations, which would then need their own
  dated note.
- **Option C — merge, then supersede.** Fold W096's compact six-surface
  enumeration into W093 as a dated addendum and append a dated supersession
  note to W096. Rationale: consolidates both unique payloads into the canonical
  record without deleting either. Cost: it touches two append-only records in
  one operation; the merge addendum must be additive (never a rewrite), and the
  "no work is queued twice" fact must survive.

**Recommendation (input only): Option A**, on the recorded evidence — W093 is
the citation anchor for the already-landed batch-5 assessment and carries the
plane-3 loopback facts; W096's enumeration is preserved, not lost. **The
resolution is the operator's call** (the P7 row's verbatim disposition,
`docs/PARKED_AND_LIMITATIONS.md:36`).

## 4. What this record does not do

- It does not delete, merge, rewrite, or re-date either fragment. Both remain
  write-once records; a supersession note, if directed, is appended, never a
  replacement.
- It recorded no decision at the time — **the operator's decision is now
  applied; see §5** — and it authorizes no code. Docs-only.

## 5. Resolution applied (2026-09-30)

**The operator chose Option A on 2026-09-30.** W093
(`docs/ledger/W093-…-az-function-.md`) is the canonical W093/W096 record; W096
(`docs/ledger/W096-…-az-function-.md`) carries the dated supersession note
appended 2026-09-30 — nothing deleted, merged, or rewritten, its fuller
constraint enumeration preserved in place. The shared operator intent
(serverless hosting, 2026-09-22) is served by the batch-5 hosting assessment
(`docs/HOSTING_ASSESSMENT_2026-09-30.md`). The alternatives (Option B, Option C)
remain recorded above as not-taken.

**Applied:** the P7 row (`docs/PARKED_AND_LIMITATIONS.md:36`) carries the dated
resolution note in its status and approval cells, and **the item is resolved in
place under the parked-items list** (the P17 precedent — a resolved entry stays
listed with its dated disposition; the row's history is retained, not deleted).
Ledger fragment: `docs/ledger/P7-supersession-applied.md`. Issue #286 is closed
by the PR carrying this change.

**Evidence:** the two fragments read in full (W093 38 lines, W096 33 lines);
the P7 row (`docs/PARKED_AND_LIMITATIONS.md:36`); the sweep record (PR #107,
commit `9ecf2c79`; W116 fragment `:5-10`); the batch-3 hosting assessment
(`docs/HOSTING_ASSESSMENT_2026-09-30.md`, 375 lines; ledger fragment
`docs/ledger/HOSTING-ASSESSMENT.md`) and its W093 citations. Docs-only: lint
and typecheck are **not applicable** (no executable surface touched).
