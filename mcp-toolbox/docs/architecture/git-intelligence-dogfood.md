# Git Intelligence Dogfood

P406 exercised the Git Intelligence domain adapters against the real
`workflow-guard-mcp` monorepo on 2026-08-28, before any Git/Code Intelligence
composition. Measurements used the product-local `tsx` toolchain and pointed
`workspaceRoot` at the canonical monorepo worktree root. Each representative
query was run three times; serialized sizes below are `JSON.stringify` UTF-8
byte counts and timings are local wall-clock observations, not performance
budgets.

## Repository shape

The worktree is in the middle of a root-package-to-monorepo migration. A
max-limit status query reports 106 entries: 85 untracked files, 20 tracked
deletions, and one tracked modification. The new `apps/`, `packages/`, root
planning files, and architecture documents are mostly untracked, while the
committed `HEAD` still contains the former root package. There are no staged
changes.

This shape matters more than repository size for the current evidence. Git
cannot infer that an untracked `apps/workflow-guard-mcp/src/pr-policy.ts` is the
successor of deleted `src/pr-policy.ts`; that relationship does not exist in
the index or committed history yet.

## Observations

`working_tree_status` was correct and compact. With the public default limit
of 100 it returned 100 deterministic path-sorted entries with `truncated:
true`, taking 4.63-8.42 ms and serializing to 8,868 bytes. At the public maximum
of 500 it exposed all 106 entries with `truncated: false` in 7.85 ms and 9,259
bytes. The structured states made the migration shape apparent without parsing
porcelain output, although a caller using the default must react to
`truncated` before assuming it has the complete change set.

`local_diff` correctly separates index and worktree evidence. Staged scope was
empty (`files: []`) in 5.05-5.37 ms and 56 bytes. Unstaged scope returned all
21 tracked changes in 44.36-49.11 ms. The result was about 140 KiB and reported
`evidenceTruncated: true`: file metadata remained complete, but the bounded
patch budget could not carry all deletion evidence. A limit-10 query was about
68 KiB, took 28.11 ms, and correctly reported both file-list and patch-evidence
truncation. Most importantly, diff does not include the 85 untracked files, so
it cannot by itself describe this migration even when its file limit is high.

`file_history` on committed `src/pr-policy.ts` returned its local commit
provenance in 5.73-8.23 ms and 269 bytes. The same query for untracked
`TODO.md` correctly returned no commits in 3.69-4.72 ms. `file_blame` on
committed `src/pr-policy.ts` returned 50 normalized lines with `truncated:
true` in 5.63-6.29 ms and 9,660 bytes. Blame of untracked `TODO.md` correctly
failed because that path does not exist in committed `HEAD`. These semantics
are useful for committed provenance but deliberately do not pretend that
working-tree-only files have history.

## Composition implications

Structured Git evidence is sufficient to answer which tracked paths changed,
whether a change is staged, the bounded patch for many ordinary edits, and the
committed provenance of a known path. It is also sufficiently low-latency for
separate agent calls in this repository: status/provenance were single-digit
milliseconds and the patch-heavy diff remained below 50 ms in these runs.

It is incomplete for answering which symbols changed. Patch text would still
need language-aware interpretation, and large diffs consume substantially more
context than status metadata. More importantly, the current migration proves
that pre-commit repository shape can defeat pathname-based correlation:
untracked destination files have no Git rename/provenance relationship to the
tracked deletions they replace. Automatically composing Git and Code
Intelligence would not repair that missing Git fact and could imply stronger
evidence than exists.

P406 therefore supplies no evidence for a product-to-product dependency.
Agents can use a compact status call to select paths, request bounded diff only
where patch evidence is useful, and query history/blame for committed paths.
P407 should evaluate changed-symbol correlation as an optional intelligence
layer only if it can preserve these evidence boundaries and demonstrate value
beyond separate Git and Code Intelligence calls.
