# CI Intelligence MCP

Read-only, bounded CI evidence for coding agents over MCP. The initial provider
is GitHub Actions and exposes run listing plus job summaries for an explicit run.

## Configuration

Configuration is trusted process configuration, never MCP input:

- `CI_GITHUB_REPOSITORY` (required): repository as `owner/name`.
- `CI_GITHUB_TOKEN` (optional): bearer token for private repositories. For a
  fine-grained token, grant read access needed to view Actions workflow runs.
- `CI_GITHUB_API_URL` (optional): GitHub API origin, default
  `https://api.github.com`. Set this only to a trusted GitHub Enterprise API or
  controlled test endpoint. The server never follows provider-returned API URLs.

The product is read-only. It does not rerun, cancel, dispatch, approve, download
artifacts, or expose steps or raw logs. Provider text is untrusted evidence and results are
bounded. A passing CI run is evidence about the provider-reported revision, not
proof that a local worktree or particular symbol was tested.

Run locally after building:

```sh
pnpm run build
CI_GITHUB_REPOSITORY=owner/repo node dist/server.js
```

See `../../docs/architecture/ci-intelligence-contract.md` for the full trust and
normalization contract.
