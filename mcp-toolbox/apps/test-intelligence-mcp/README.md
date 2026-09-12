# Test Intelligence MCP

Structured test discovery and execution for coding agents over MCP. Requires Node.js 22 or newer.

Run from a published package with `test-intelligence-mcp`. The stdio server exposes `discover_tests`, which accepts an absolute `workspaceRoot` and an optional positive `limit` (default 100, maximum 500). It discovers `*.test` and `*.spec` JavaScript/TypeScript runnable files without executing repository code, returns canonical workspace-relative identities in deterministic order, and reports `truncated` only when another permitted result exists.

`find_relevant_tests` accepts a workspace-relative `file` and ranks discovered tests from its nearest `package.json` project. An exact queried test ranks first, then a test with a matching filename stem, then other tests in the same project; each result reports `exact_file`, `matching_stem`, or `same_project` so callers can distinguish filename evidence from the broad project fallback. Results use the same default 100 and maximum 500 bounds as discovery. This is structural relevance only: it does not claim dependency or coverage evidence, parse imports, or infer symbol relevance.

`run_tests` explicitly executes 1-500 IDs returned by discovery. It accepts an optional timeout from 1-300,000 ms (default 30,000), runs JavaScript with Node's built-in test runner and TypeScript through the package-owned `tsx` hook, and returns normalized test outcomes rather than raw runner output. Execution records are bounded to 1,000 with evidence-based truncation, and test names are bounded to 4 KiB UTF-8 with explicit truncation indicators; failure diagnostics are bounded to 16 KiB per failed test, 64 KiB total, and 100 failure records. Normal assertion failures are successful tool results; loader/startup failures are tool errors.

Execution receives a sanitized environment and does not inherit credentials, `HOME`, `NODE_OPTIONS`, or caller-defined environment overrides. This is defense in depth rather than a sandbox: selected repository tests execute with the MCP server's OS authority and may access resources available to that identity. Cancellation and timeout terminate the runner before returning, including its owned process group where the platform supports that primitive.

The initial Node test-runner contract is documented in `docs/architecture/test-intelligence-contract.md` in the source repository.
