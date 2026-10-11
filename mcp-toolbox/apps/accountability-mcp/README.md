# Accountability MCP

Durable, subject-bound engineering accountability over MCP: named reviewer
attestations with follow-up debt, plus bounded references to verification
observations. This server merges the former `review-accountability-mcp` and
`verification-accountability-mcp` products behind one stdio server. Every tool
name and behavior is preserved; each subsystem keeps its own durable store.

## Review accountability tools

- `record_review` records that a named reviewer or harness approved or requested
  changes against an explicit commit or content fingerprint. Configured blocking
  severities cannot coexist with an approved verdict. P2/P3 findings atomically
  create durable open follow-ups.
- `list_reviews` returns bounded attestations and open follow-ups. Review freshness
  is `unknown` unless the caller supplies a compatible current subject; exact
  identity is `fresh` and a changed comparable subject is `stale`.
- `resolve_followup` explicitly resolves one open P2/P3 follow-up without changing
  the originating attestation.

Review records are `attestation` evidence: persistence proves what the identified
reviewer stated about the recorded subject, not that the verdict is deterministically
correct. Conflicting attestations remain separate. The server does not launch
reviewers, infer identity across subject kinds, or transfer approval to a changed
subject.

## Verification accountability tools

- `record_verification` accepts a bounded Test request, a provider-qualified CI
  run ID, or a bounded browser verification request (URL plus assertions), then
  calls the configured primitive MCP itself. Callers cannot submit result
  payloads. Stored `observation` records summarize data returned on the trusted
  primitive connection rather than promoting agent prose or caller-created
  Test/CI/browser-shaped JSON.
- `list_verifications` returns at most 20 observations by default and 50
  explicitly. CI observations are `fresh` or `stale` only for the same
  provider/repository revision scheme; browser observations carry the page
  identity the browser tool observed and are `fresh` only for a matching URL and
  page hash; local Test Intelligence content freshness remains `unknown`.
- `run_verification_async` is the Tasks-extension (MCP 2026-07-28, SEP-2663)
  long-running variant of `record_verification`.

Configure primitive commands with `ACCOUNTABILITY_TEST_COMMAND` /
`ACCOUNTABILITY_TEST_ARGS`, `ACCOUNTABILITY_CI_COMMAND` / `ACCOUNTABILITY_CI_ARGS`,
and `ACCOUNTABILITY_BROWSER_COMMAND` / `ACCOUNTABILITY_BROWSER_ARGS` (the
historical `VERIFICATION_ACCOUNTABILITY_*` spellings remain honored as
fallbacks). CI repository identity comes from the same `CI_GITHUB_REPOSITORY`
configuration used by CI Intelligence, and Browser Verification inherits its
`BROWSER_VERIFICATION_*` connection configuration.

Failed, timed-out, cancelled, and truncated observations remain visible evidence;
they are never converted into success. A `truncated` result cannot establish that
omitted checks passed. Recognizable secret-bearing provenance is rejected.

## Storage and retention

Storage is local and workspace-scoped. Each subsystem keeps its own data root so
a merge never mixes the two products' records:

- Review attestations under `XDG_DATA_HOME/accountability-mcp` (or
  `~/.local/share/accountability-mcp`); `REVIEW_ACCOUNTABILITY_DATA_DIR`
  overrides for isolated hosts and tests.
- Verification observations under `XDG_DATA_HOME/accountability-mcp` (or
  `~/.local/share/accountability-mcp`); `VERIFICATION_ACCOUNTABILITY_DATA_DIR`
  overrides for isolated hosts and tests.

Both stores are bounded on three dimensions, all of which are active:

- **Entry bound:** 500 reviews / 500 observations per workspace store.
- **Byte bound:** 5 MiB per workspace store.
- **Age bound:** records older than the retention window are pruned on every
  write, so a store written forever cannot grow without bound.

The retention window defaults to **90 days** and is configurable with the
`ACCOUNTABILITY_RETENTION_DAYS` environment variable (a positive integer number
of days). An unset, non-integer, or non-positive value falls back to the 90-day
default. Pruning drops review records (and their follow-ups) and verification
observations past the window; it never rewrites a record that remains.

## Development

Requires Node.js 22+.

```sh
pnpm run verify
```
