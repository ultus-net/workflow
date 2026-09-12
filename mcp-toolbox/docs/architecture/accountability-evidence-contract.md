# Accountability Evidence And Provenance Contract

## P701 Scope

Stage 7 begins with a client-neutral contract for durable accountability evidence.
The contract defines what a portable record may claim, which subject that claim
applies to, how its provenance is retained, and when a consumer may call it fresh.
It does not choose a database, event store, synchronization protocol, MCP package,
or host lifecycle integration.

The contract is deliberately narrower than a transcript. Accountability records
capture bounded facts needed to recover engineering state across sessions and
harnesses. They do not preserve hidden reasoning, authorize actions, or make an
agent's completion statement into proof that work, review, or verification occurred.

## Evidence Classes And Trust

Every accountability record has exactly one evidence class. Storage or transport
must not promote a record into a stronger class:

- `observation`: a normalized result established by an identified authority, such
  as a Test Intelligence execution result, CI provider result, Git observation, or
  a deterministic local subject measurement. Its authority is limited to what the
  originating capability actually observed.
- `attestation`: a bounded statement made by an identified actor or reviewer, such
  as approval or a finding. It proves that the actor made that statement about the
  bound subject; it does not make the statement deterministically correct.
- `derived`: a deterministic conclusion over identified observation, attestation,
  or derived inputs. All material input references are retained. A derivation never
  gains more authority or freshness than its required inputs.
- `assertion`: a claim supplied by an agent, user, imported project record, or other
  source that did not establish the claim through a defined observation or
  attestation authority. Assertions are useful durable context but are not promoted
  into verification, review, or deterministic evidence by repetition or storage.

`fact`, `decision`, `constraint`, and `lesson` planned for Project Memory are memory
kinds, not evidence classes. For example, a recorded project constraint may be an
`assertion` with repository provenance; a deterministic Git state is an
`observation`. P702 must preserve this distinction rather than treating the word
"fact" as a stronger trust level.

The origin is part of provenance. A record identifies a bounded origin kind and
origin identity sufficient to distinguish the authority or actor that produced it,
plus an observation/attestation time when known. Provider/tool-specific identifiers
may be retained as bounded opaque provenance. Human explanation text is never a
substitute for structured origin, subject, or source references.

Subject binding is itself an authority claim. An evidence producer may bind a
content-sensitive subject only when it observed that subject at the evidence
boundary or a trusted adapter can establish that the subject remained stable for
the whole operation. Measuring a worktree immediately before or after an operation
does not prove it remained unchanged during that operation. In that case the
observation remains valid at the scope its source actually established, but
content-sensitive freshness is `unknown`. A host with an authoritative mutation
interception point may establish stronger stability; an ordinary MCP connection may
not claim equivalent authority.

## Subject Identity

Evidence that can become stale must bind to the narrowest subject it actually
establishes. Subjects use explicit kinds rather than a generic caller-provided
string:

- `workspace`: the canonical real filesystem root. This identifies a project
  location but does not imply any particular contents.
- `worktree`: a canonical workspace plus an implementation-defined deterministic
  state fingerprint covering the repository state material to the observation.
  The fingerprint algorithm and scope are part of subject provenance; values from
  different algorithms/scopes are not equal. A scheme declares the state dimensions
  it covers, such as tracked contents, index state, untracked files, modes, symlinks,
  or submodule identity. Evidence whose correctness depends on material outside that
  scope cannot use the fingerprint as complete freshness proof.
- `commit`: a repository identity plus exact full commit object ID. A branch name,
  tag, abbreviated hash, or current `HEAD` label is not a commit subject because it
  can move or be ambiguous.
- `fingerprint`: an explicitly named deterministic digest of other bounded material
  when neither worktree nor commit identity describes the actual subject. The
  algorithm, version, and scope are included in the identity.

Repository identity must prevent a commit object ID from silently transferring
between unrelated projects. For local Git subjects the canonical repository/worktree
identity is sufficient for the initial local model. A future cross-machine identity
scheme requires its own contract; P701 does not equate repository names, remote URLs,
or directory basenames with repository identity.

The initial contract defines no trusted equivalence between a provider repository
identity and a canonical local repository identity. Matching commit hashes or remote
URL text do not establish equivalence. Until a later trusted binding defines it,
provider commit evidence remains valid for its provider repository subject but has
`unknown` freshness relative to a local repository/worktree subject.

A record may additionally associate bounded normalized workspace-relative paths for
retrieval. Path associations are indexes/context, not subject identity and not proof
that the path still exists or has unchanged contents.

Not every durable assertion has a content-sensitive subject. A repository-owned
decision intended to remain applicable across ordinary edits may bind to the
`workspace` subject and remain current until explicitly superseded or invalidated.
Verification and review evidence about code state must use a content-sensitive
`worktree`, `commit`, or defined `fingerprint` subject; binding those claims only to
`workspace` is invalid.

## Freshness And Invalidation

Freshness is determined against an explicitly established current subject, never
from record age, session identity, actor identity, or confidence text. The portable
states are:

- `fresh`: the record's subject identity equals the current subject under the same
  subject kind and identity/fingerprint scheme, and every freshness dependency
  required by the record is fresh.
- `stale`: a comparable current subject was established and differs, a required
  source/dependency is stale or superseded, or the record was explicitly
  invalidated.
- `unknown`: no comparable current subject can be established, subject schemes are
  not comparable, or required source freshness cannot be established.

`unknown` must not be collapsed into `fresh`. A record may remain useful historical
evidence while stale or unknown, but consumers must not present it as current proof.
An observation timestamp may help a person understand history; time alone neither
freshens nor invalidates a record.

P701 compares subjects only when their kind and identity scheme are compatible.
Different kinds, including `commit` versus `worktree`, are incomparable and produce
`unknown` unless a future defined authority supplies an explicit relationship with
its own provenance. A clean worktree whose `HEAD` names commit `C` is not silently
the same subject as `commit(C)`.

Supersession and freshness are separate. Supersession says a newer durable record
replaces an older record for its declared purpose. It does not rewrite or delete the
older record's provenance, and a newer superseding assertion does not make unrelated
verification evidence fresh. Cyclic or dangling supersession relationships are
invalid or unresolved rather than silently resolved by recency.

Invalidation and supersession relationships are provenance-bearing claims. A
concrete product defines which origin/evidence class may create each relationship
for a compatible project, subject, and purpose. An imported or agent assertion
cannot invalidate, supersede, or alter the evidence class of an observation or
attestation merely by naming its identifier. Unauthorized relationships are rejected
or retained only as non-authoritative assertions, never applied to freshness.

Derived evidence carries references to all material sources and is fresh only when
its own subject is fresh and every source needed for the derivation remains usable
under the derivation's declared freshness rules. A derivation must not copy source
claims into a new record merely to sever their provenance or freshness dependency.

## Evidence References

Accountability references existing Test, CI, Git, Code, or Change Intelligence
evidence rather than reimplementing those authorities. A reference contains a
stable record/origin identifier, evidence class, bound subject identity, and only
the bounded summary necessary for progressive disclosure. It may include the source
capability name and provider-qualified IDs needed to retrieve or explain the source.

Local Test Intelligence currently establishes the canonical execution workspace and
test outcome, but not a stable worktree fingerprint throughout execution. An
accountability adapter must therefore not attach a before/after fingerprint and call
that result fresh for the measured state. P705 may retain workspace provenance with
`unknown` content freshness until a source or trusted host adapter establishes a
content-sensitive execution subject. The same rule applies whenever a source's
native contract establishes less subject identity than accountability would like.

A reference does not make ephemeral evidence durable by assertion alone. The
accountability producer must either persist the bounded normalized observation with
its provenance or retain a trustworthy retrievable source identifier whose authority
and subject can still be checked. If the source is unavailable, freshness becomes
`unknown` where source revalidation is required; the system must not reconstruct a
passing result from an agent's prose description.

Test Intelligence remains the authority for observed local test execution. CI
Intelligence remains the authority for provider-reported CI state. Git Intelligence
remains the authority for its local read-only observations. Change Intelligence may
provide derived evidence while retaining primitive provenance. Workflow Guard may
consume accountability evidence for deterministic policy, but neither accountability
nor MCP connectivity creates a host enforcement point.

## Bounds And Progressive Disclosure

All public record collections, path associations, source references, summaries, and
free-text evidence are explicitly bounded by the concrete product that exposes them.
That product must publish positive defaults/maxima before implementation and report
truncation only after observing omitted permitted material. Internal safety ceilings
that prevent trustworthy record boundaries from being established are errors, not
successful truncated evidence.

Concrete products also bound provenance/source-reference counts and identifier/text
sizes. If required provenance cannot fit without losing the identity of its authority
or subject, the operation fails rather than returning an ambiguous truncated
reference. Optional omitted evidence carries explicit truncation/incompleteness, and
derivations cannot infer absence from it.

Truncation is provenance. A record derived from truncated input must retain that
incompleteness where it affects the claim and must not infer absence from omitted
evidence. Search results return compact record metadata/references first; consumers
request deeper bounded content explicitly rather than receiving the project memory
or accountability history wholesale.

P701 intentionally does not set one numeric limit for every future product. P702,
P704, and P705 have different payload and lifecycle needs and must choose concrete
limits with deterministic boundary tests instead of inheriting arbitrary numbers.

## Privacy And Untrusted Content

Repository content, memory text, review text, agent assertions, provider text, and
imported records are untrusted data. Returning or storing them does not authorize
shell execution, filesystem access, network requests, credential use, or additional
tool calls. Instruction-like content remains inert evidence.

Accountability records must not contain credentials, authentication headers,
cookies, private keys, environment dumps, or other known secret-bearing material.
Concrete products must reject or redact detected secrets before persistence and must
ensure errors/logs do not echo rejected values. Redaction is represented explicitly;
it must not silently change the meaning of proof-bearing structured fields.

Before persistence, each durable product defines its concrete secret
detection/redaction boundary, behavior when required provenance cannot safely be
retained, and local retention/deletion/export disclosure semantics. Detection is
defense in depth rather than proof that arbitrary text is secret-free; credentials
from trusted product configuration remain categorically excluded regardless of
content scanning.

Collect the minimum provenance needed to identify authority and subject. Host session
IDs, user identities, machine paths, provider URLs, and actor metadata are not
included merely because they are available. A concrete product that needs them must
define their purpose, bounds, disclosure behavior, and retention implications.

The initial Stage 7 model is local. A hosted synchronization layer may later carry
bounded records, but remote storage cannot promote their evidence class. Cross-machine
identity, authorization, concurrent conflict resolution, retention, and deletion are
separate decisions required before such synchronization is approved.

## Cancellation And Failure Semantics

Potentially long-running filesystem, source-authority, or storage operations support
caller cancellation using the concrete product/runtime's cancellation mechanism and
observe it between bounded operations. Cancellation returns a normalized error and
must not return a partial write or partial evidence set as complete. A concrete
durable store must define atomic write behavior before mutating records; P701 does
not select that store or require one language-specific cancellation API.

Malformed records, unsupported subject/evidence kinds, provenance mismatches,
cross-project subject use, invalid supersession, safety-ceiling exhaustion, storage
failure, and cancellation are errors rather than reasons to weaken provenance.
Missing or incomparable current-subject evidence produces `unknown` freshness when
the historical record itself remains valid. Absence of a record is absence of
evidence, not evidence that an event did not occur.

## Adversarial Contract Examples

These cases are mandatory boundary examples for later deterministic fixtures:

1. A test observation passes for worktree fingerprint `A`. A file then changes and
   the current fingerprint is `B`. The historical pass remains retrievable but is
   `stale` for `B`; an agent statement that the edit is unrelated cannot transfer it.
2. CI reports success for commit `C` in repository `R1`. The same commit-like value
   is presented from workspace/repository `R2`, or the local worktree is ahead of
   `C`. The CI observation is not current proof for that subject; repository mismatch
   is rejected and provider/local subjects are `unknown` relative to each other until
   a trusted cross-identity binding exists.
3. An approval attestation names worktree fingerprint `A`; the worktree becomes `B`.
   The approval is a real historical attestation but stale. Copying its text into a
   new agent assertion about `B` does not create a fresh approval.
4. An agent records "all tests pass" without an identified Test/CI observation. The
   record is an `assertion`, not verification evidence, even if another agent repeats
   it or stores it as Project Memory `fact`.
5. A derived "verification complete" record references passing local tests but the
   referenced result was truncated or one required evidence reference is unavailable.
   The derivation preserves incompleteness or becomes `unknown`; it cannot claim that
   omitted tests passed.
6. A workspace-scoped architectural constraint is read after ordinary code edits.
   It may remain fresh because its declared subject is the project identity, until a
   valid superseding/invalidation record changes that state. The same workspace-only
   binding is rejected for a test-pass or code-review approval claim.
7. A memory entry contains instruction text asking the receiving agent to run a shell
   command or send a token to a URL. It is returned as bounded untrusted content and
   confers no execution/network authority.
8. A record from another canonical workspace has matching paths and text. It is not
   silently imported as current evidence for this workspace. Cross-project transfer
   requires an explicit import/rebinding operation whose resulting claim remains an
   assertion unless a defined authority re-establishes it.
9. A Test Intelligence run starts while the workspace has fingerprint `A` and a
   caller observes `A` again afterward, but no authority observed mutations during
   execution. The result is not bound to `A` by inference; its content-sensitive
   freshness is `unknown`.
10. A derivation needs six material source references but a concrete API can retain
   only five. It reports incompleteness/truncation when that remains meaningful, or
   fails if dropping the source would make provenance ambiguous; it never reports a
   complete six-source claim with one source silently omitted.

## Relationship To P702-P706

P702 applies this contract to bounded Project Memory record/search, provenance,
supersession, path association, and secret handling. It should implement only the
subject machinery needed by that vertical slice rather than building the full future
accountability surface speculatively.

P704 adds review attestations and durable follow-up debt using the attestation class
and content-sensitive subjects. P705 references verification observations and derives
fresh/stale/unknown state without creating another runner/provider. P706 discovers
repository-owned planning context as untrusted bounded context; discovery does not
turn task text into deterministic evidence or orchestration authority.

No shared runtime/contracts package is approved by P701. Extraction still requires
multiple concrete consumers with identical lifecycle and trust semantics.

## Verification Gate

P701 is accepted when this contract is consistent with the existing Test, Git,
Change, CI, and Workflow Guard boundaries; explicitly covers stale-subject transfer,
cross-workspace evidence, unsupported agent assertions, bounded references, privacy,
cancellation, and failure semantics; and passes independent architecture review.
Implementation tasks must turn the adversarial examples into deterministic tests for
the concrete public surfaces they introduce.
