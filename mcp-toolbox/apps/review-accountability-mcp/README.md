# Review Accountability MCP

Durable, subject-bound reviewer attestations and lower-priority follow-up debt for
coding agents and harnesses on the same machine.

## Tools

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

Storage is local and workspace-scoped under
`XDG_DATA_HOME/review-accountability-mcp` (or
`~/.local/share/review-accountability-mcp`). `REVIEW_ACCOUNTABILITY_DATA_DIR` may
override that location for isolated hosts and tests.

## Development

Requires Node.js 22+.

```sh
pnpm run verify
```
