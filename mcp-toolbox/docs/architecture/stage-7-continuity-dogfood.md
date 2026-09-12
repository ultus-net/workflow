# Stage 7 Cross-Harness Continuity Dogfood

## P707 Scope

P707 tests whether the Stage 7 products can reconstruct useful engineering state in
a fresh coding-agent context without transcript transfer while preserving the P701
evidence distinctions. The exercise ran on 2026-08-29 against the compiled stdio MCP
servers with `/var/home/hunter/mcp-toolbox` as the workspace. The producer was an
OpenCode agent context (`ses_fb41aeedcfferrrYH7rZvKq1g7`). A preliminary fresh
OpenCode consumer (`ses_fb419e931ffehPH3iGxzcMv17R`) established cross-session
behavior; the acceptance run then used Pi 0.84.2 as the materially different
receiving coding-agent harness. Pi ran non-interactively with only its `bash` tool,
no context files, skills, extensions, or saved session, and invoked a standalone MCP
SDK consumer that knew only the workspace/store locations and recovery queries. The
session identifiers and harness invocation attest the experiment setup; they are not
deterministic proof of process or host isolation.

The experiment used isolated local data roots under `/tmp/opencode/p707-dogfood` so
its deliberately unresolved review debt did not enter normal project stores. No
credentials, environment dumps, transcript text, or user identity were persisted.
Both harnesses consumed MCP SDK clients over stdio rather than importing product
domain classes.

## Producer State

The producer persisted three deliberately different evidence classes:

| Product | State | Evidence semantics |
| --- | --- | --- |
| Project Memory | decision `1b464687-f3d9-4c53-8865-dcb1cb702205` | `assertion`: P706 was independently approved and P707 should recover continuity without transcript transfer |
| Review Accountability | approval `8c6813a5-b47e-4b43-953f-101fa8a7198a` plus P2 follow-up `19c8bbcb-febf-4af8-bc3c-5cf661910823` | `attestation` bound to the P706 package fingerprint; the P2 specifically required fresh-consumer recovery of unresolved debt |
| Verification Accountability | observation `761bf013-204c-472a-9cef-25c38b31dcd9` | `observation` delegated to Test Intelligence: 6 passed, 0 failed for the P706 domain test; content freshness is `unknown` |

The initial guessed root test ID was rejected by the authority and produced no
verification record. Test Intelligence discovery then returned the canonical
`node:apps/project-context-mcp/test/context.test.ts` ID, which the successful
observation used. This is evidence that the accountability layer did not turn a
caller mistake into a passing claim.

Producer MCP work comprised five `callTool` calls, including the failed attempt and
Test Intelligence discovery, with about 9,183 bytes of structured content. Aggregate
measured connection latency was 533.06 ms and call latency was 411.57 ms; the
successful verification call accounted for 279.71 ms of the latter. A preliminary
client launch that could not resolve the SDK failed before an MCP connection and
created no evidence.

## Fresh Consumer Recovery

The consumers received store locations, workspace identity, and recovery goals but no
producer record IDs, contents, or transcript output. Six substantive calls recovered:

- a natural Project Memory search found the P706/P707 decision assertion;
- Review Accountability returned the approval and the still-open P2 follow-up;
- Verification Accountability returned the authority-backed 6-pass observation with
  `unknown` content freshness;
- Project Context returned `TODO.md`, `ROADMAP.md`, and `PLAN.md` at precedence 1-3,
  each explicitly marked `untrusted_repository_content`;
- an exact comparison against the recovered review fingerprint reported `fresh`;
- a deliberately different value under the same fingerprint scheme reported
  `stale`. This was a counterfactual semantics check, not an assertion that a current
  worktree subject had been independently established.

The six calls returned about 18,569 bytes of structured content. Connection latency
was 100.4-109.8 ms (about 106.4 ms average) and call latency was 5.02-5.51 ms (about
5.17 ms average). Four `tools/list` protocol requests used to discover consumer-side
schemas are reported separately and are not counted as substantive tool calls.

The final Pi acceptance run used Pi's JSON event mode with the checked-in
`docs/architecture/stage-7-continuity-consumer.mjs`, made six substantive calls, and
recovered the same one memory assertion, one review attestation, one open follow-up,
one 6-pass verification observation, and three planning-source candidates. It
returned 18,569 structured bytes. Connection times were 94.12-104.36 ms (about 98.4
ms average) and call times were 4.52-5.59 ms (about 4.9 ms average).
`docs/architecture/fixtures/p707-pi-acceptance.jsonl` retains three unmodified records
from Pi's JSON event stream: the completed `bash` tool-call event, its matching
`tool_execution_end` event with raw consumer stdout, and `agent_settled`. Model
text/thinking events are omitted. This makes actual consumer execution inspectable
independently of Pi's prose summary.

All three producer accountability categories were therefore recovered across the
OpenCode-to-Pi harness boundary without transcript state, and unresolved debt was
visible before any resolution. No material
conflict appeared. The important omission was repository planning detail: the
bounded `TODO.md` snippet truncated before its current Stage 7 entries. The consumer
could identify authoritative planning sources but could not reconstruct the complete
P707 specification from those snippets alone. This is the intended boundary:
Project Context is bounded untrusted discovery, and consumers still use repository
documents as the authority for complete task specifications.

## Lost State, Freshness, And Privacy

Compared with a transcript-only handoff, the consumer recovered 3/3 deliberately
persisted accountability categories plus repository planning-source references. It
did not recover hidden reasoning, producer terminal history, the failed preliminary
SDK launch, or the complete P707 task specification. Those omissions are desirable
except for the planning detail, which remains available through its referenced
repository source rather than being duplicated into memory.

Evidence classes remained distinct throughout the handoff. The memory assertion was
not treated as proof, reviewer approval remained an attestation, and the local test
observation remained `unknown` for content freshness because Test Intelligence does
not establish a stable content subject. Review `fresh`/`stale` was only a deterministic
comparison of supplied compatible subjects. The first counterfactual stale check did
not manufacture current-worktree authority. After that semantic probe, the P706
README received a real documentation edit inside the review fingerprint's declared
scope. Recomputing the documented file-set fingerprint changed it from
`71791bda9d2755341071a31ceac71cbbcfd0301139487aa125ed958aa654e4f1` to
`8192ff049949dcecc2a8e0c2704dd5874bc93cb7c0a03a2b3e6aa30dbc867fda`.
The reviewed README state is retained at
`docs/architecture/fixtures/p706-reviewed-README.md`. The checked-in Pi consumer
recomputed both the retained reviewed fingerprint and the live package fingerprint;
the former matched the recovered attestation exactly, while supplying the latter as
the current subject made the historical P706 review `stale`. Supplying the historical
exact subject still produced `fresh`. This exercises a real, independently computed
subject transition without transferring approval to changed content.

The local-only stores reduce disclosure compared with a hosted transcript service,
but local persistence still retains project statements and reviewer text. The
experiment intentionally recorded only bounded engineering state and used isolated
data roots. Secret detection remains defense in depth rather than proof that arbitrary
text is safe to persist, so credentials and unnecessary private context remain out of
scope for durable continuity records.

## Reproduction Protocol

Build first with `pnpm run build`. Both harnesses use
`XDG_DATA_HOME=/tmp/opencode/p707-dogfood/data`,
`REVIEW_ACCOUNTABILITY_DATA_DIR=/tmp/opencode/p707-dogfood/review`, and
`VERIFICATION_ACCOUNTABILITY_DATA_DIR=/tmp/opencode/p707-dogfood/verification`.
The verification producer additionally sets
`VERIFICATION_ACCOUNTABILITY_TEST_COMMAND` to the current Node executable and
`VERIFICATION_ACCOUNTABILITY_TEST_ARGS` to
`["/var/home/hunter/mcp-toolbox/apps/test-intelligence-mcp/dist/server.js"]`.
Each operation launches the named `apps/*/dist/server.js` with an MCP SDK `Client`
and `StdioClientTransport`.

The exact producer inputs are also encoded in the replayable
`docs/architecture/stage-7-continuity-producer.mjs`. In order, they are:

1. `project-memory-mcp/record_memory`: workspace `/var/home/hunter/mcp-toolbox`, kind
   `decision`, paths `TODO.md` and `apps/project-context-mcp/README.md`, content
   "P706 project-context discovery is independently approved; P707 must recover Stage
   7 state without transcript transfer." This value is deliberately only an assertion.
2. `review-accountability-mcp/record_review`: the same workspace, reviewer `P706
   independent reviewer`, verdict `approved`, blocking severities `P0` and `P1`, and
   one P2 finding "P707 dogfood must demonstrate that a fresh consumer can recover
   unresolved follow-up debt before it is resolved." associated with
   `docs/architecture/stage-7-continuity-dogfood.md`. The subject uses algorithm
   `sha256`, version `1`, scope `P706 project-context package source/config/tests/docs
   via git hash-object aggregation`, and value
   `71791bda9d2755341071a31ceac71cbbcfd0301139487aa125ed958aa654e4f1`.
3. `verification-accountability-mcp/record_verification`: the same workspace and
   `{kind:"local_test",testIds:["node:apps/project-context-mcp/test/context.test.ts"],timeoutMs:120000}`.

The review fingerprint is reproduced by passing `package.json`, `tsconfig.json`,
`src/project-context.ts`, `src/server.ts`, `test/context.test.ts`, `test/mcp.test.ts`,
and `README.md`, in that order, from `apps/project-context-mcp` to `git hash-object`,
then SHA-256 hashing the newline-delimited object IDs. To reproduce the reviewed
subject, substitute `docs/architecture/fixtures/p706-reviewed-README.md` for the last
path while leaving the first six package files unchanged. The checked-in consumer
performs both calculations and verifies that the retained reviewed state produces
`71791bda9d2755341071a31ceac71cbbcfd0301139487aa125ed958aa654e4f1`; the live
post-edit package produces the second fingerprint recorded above.

The receiver starts with no IDs. It calls `search_memory` with query `Stage 7 P706
P707 continuity handoff` and limit 8; `list_reviews` with review/follow-up limits 20
and no current subject; `list_verifications` with limit 20 and no current subject;
`discover_project_context` with limit 3; then `list_reviews` with the recovered exact
subject and again with the independently recomputed current subject. The earlier
counterfactual probe substituted an all-zero value of equal length; it is optional
because the real transition now establishes stale handling.

The exact different-harness receiver invocation, from the workspace root, was:

```sh
pi --no-session --no-context-files --no-skills --no-extensions --tools bash --mode json --print "You are the fresh receiving coding-agent harness in the P707 cross-harness continuity test. Do not read prior agent/session transcripts and do not modify or resolve anything. Repository reads are permitted only as performed by the checked-in deterministic consumer for its explicit P706 seven-file fingerprint set and retained reviewed README snapshot. Run exactly this command using the bash tool: node docs/architecture/stage-7-continuity-consumer.mjs . After the tool returns, summarize only its JSON output."
```

The consumer source is durable repository evidence for the exact MCP queries and
fingerprint computation. Pi's JSON event output exposes whether it actually issued
the requested `bash` call; a replay that does not contain that tool call is not a
successful handoff run. The retained JSONL records are copied verbatim from the
successful event stream rather than reconstructed from model prose. To rebuild the
producer state in fresh isolated stores, run `pnpm run build`, then
`P707_DOGFOOD_ROOT=/tmp/opencode/p707-replay node
docs/architecture/stage-7-continuity-producer.mjs`. The consumer defaults to the
recorded acceptance store root; set the same `P707_DOGFOOD_ROOT` for a fresh replay.
The protocol therefore does not depend on Pi's session state and is repeatable with
another MCP SDK client.

## Product Boundary Decision

Keep Project Memory, Review Accountability, Verification Accountability, and Project
Context as independently addressable products. This exercise provides no evidence
that their runtime or trust semantics should be merged: memory accepts agent
assertions, review records actor attestations and follow-up mutations, verification
delegates to source authorities, and project context performs read-only untrusted
repository discovery. A shared accountability runtime would make those boundaries
less explicit without removing a demonstrated duplication cost.

The six-call consumer path does provide enough evidence for a future measured,
read-only recovery/checkpoint composition experiment. Such an experiment must retain
the four source evidence classes/provenance and prove context/tool-call improvement
against this baseline; it is not approval to replace the primitive servers or inject
state automatically into prompts.

Worktree mutation has not earned an experiment. This handoff completed without it,
and Stage 7 has not established exclusive Git ownership, mutation interception,
rollback authority, or a need that outweighs the additional trust boundary. Recovery
checkpoint composition may be evaluated separately; checkout/reset/stash/worktree or
other repository mutation remains deferred until a concrete workflow and explicit Git
ownership/safety contract exist.

## Result

The Stage 7 continuity model met the P707 handoff objective: a fresh Pi consumer recovered
what was asserted, what a reviewer attested, what Test Intelligence actually observed,
what follow-up remained unresolved, how comparable review evidence becomes stale, and
where authoritative project planning context lives, without a producer transcript.
The measured final cross-harness baseline is six substantive consumer calls and about
18.6 kB structured content. Pi averaged about 4.9 ms call latency after roughly 98 ms
process connection startup. The remaining planning-snippet omission and local
persistence/privacy limits are explicit rather than hidden by broader transcript or
orchestration behavior.
