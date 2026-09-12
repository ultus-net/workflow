# Test Intelligence Contract

## P301 Scope

Stage 3 starts with Node.js's built-in test runner because both existing products already execute tests with `node --test`. The first adapter contract is runner-neutral, but only a Node test-runner implementation is approved initially.

The first vertical slices are discovery and explicit local execution. Coverage, watch mode, package-script orchestration, symbol relevance, CI integration, and additional runners remain outside P301-P304.

## Domain Boundary

A test adapter owns runner-specific discovery and execution. MCP remains a validated transport adapter and must not own test-runner parsing or subprocess policy.

Every operation receives an absolute workspace root. The adapter realpaths that root once and uses the result as the confinement and identity root. Candidate files are realpathed before exposure; symlinked paths that escape the canonical workspace are not discoverable or executable. An in-workspace symlink alias is exposed as the normalized workspace-relative path of its real target, so aliases of the same file deduplicate to one descriptor and one ID.

## Discovery

`discoverTests` initially returns deterministic runnable-file descriptors, not individual test cases. Each descriptor has a stable adapter-owned ID, workspace-relative file, human-readable label, and runner kind. The Node runner can execute explicit files and filter executed tests by name, but its documented CLI does not provide a separate no-execution test-case enumeration command. Pretending to discover case names statically would require a JavaScript/TypeScript parser and would still miss dynamically registered tests. IDs are therefore derived from normalized repository-owned test-file paths rather than process order or temporary paths.

Initial Node discovery recursively considers repository-owned files named `*.test.{js,cjs,mjs,ts,cts,mts}` or `*.spec.{js,cjs,mjs,ts,cts,mts}`. This is an adapter policy rather than a claim to reproduce Node's evolving implicit discovery rules. `node_modules`, `.git`, and real paths outside the canonical workspace are excluded. Discovery must not run package lifecycle scripts, install dependencies, or execute test files.

P304 executes JavaScript files with the current Node executable and TypeScript files with the same Node built-in runner plus the package-owned `tsx` import hook. It does not rely on Node's version-dependent native TypeScript stripping. `tsx` is therefore a product runtime dependency for the initial Node adapter rather than a dependency discovered from the target repository.

Results are ordered lexically by canonical workspace-relative file and then stable ID. Public discovery is bounded with a positive `limit`, default 100 and maximum 500. These values are an initial API resource policy aligned with the bounded Stage 2 interfaces, not an empirical performance threshold. `truncated` is true only when an additional permitted result was actually observed.

## Execution

`runTests` executes only explicit discovered test IDs or an explicitly confined test file; it never accepts an arbitrary shell command. Running tests is a local side effect and MCP annotations must not claim read-only behavior.

P304's first MCP surface accepts 1-500 explicit discovered test IDs per call. This aligns execution's argv/resource bound with the maximum public discovery page without introducing arbitrary file or command input; the domain contract can still support explicitly confined files in a later concrete use case.

Execution returns structured per-test status where the runner's execution reporter provides trustworthy identity, plus an aggregate exit status and normalized failures. Execution may reveal test-case identities that discovery intentionally does not claim to know. A nonzero runner exit accompanied by trustworthy test failure events is a normal successful tool result. A nonzero exit with no trustworthy test event, including startup/loader failure or abnormal process termination, is an execution domain error and surfaces as an MCP tool error rather than being invented as an assertion failure.

The public execution request accepts a timeout in milliseconds with a 30,000 ms default, minimum 1 ms, and maximum 300,000 ms. At most 1,000 per-test execution records are returned, and each test name is limited to 4 KiB UTF-8 with an explicit `nameTruncated` indicator. Captured failure diagnostic text is limited to 16 KiB UTF-8 per failed test and 64 KiB UTF-8 total per execution result. At most 100 failed-test records are returned. These are initial API resource policies; truncation indicators are set only when permitted content was actually omitted. Raw unbounded stdout/stderr is not part of the public contract.

The runner receives a sanitized environment rather than `process.env`. The initial Node adapter may copy only `PATH`, `PATHEXT`, `SystemRoot`, `WINDIR`, `COMSPEC`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, and `TZ` when those variables exist. It does not inherit credential-bearing CI variables, `HOME`, or runtime-injection variables such as `NODE_OPTIONS`, and P304 does not accept caller-supplied environment overrides. Tests that require application-specific environment configuration are an explicit initial limitation rather than a reason to expose the MCP server environment.

Environment sanitization is defense in depth, not a sandbox. Repository tests execute with the MCP server's OS identity and can access files, processes, and network resources available to that identity. Test Intelligence does not acquire remote credentials or claim to isolate hostile code. Callers must therefore make the same trust decision as running the repository locally and explicitly opt into execution rather than receiving it as part of discovery.

## Cancellation And Timeout

Execution accepts an `AbortSignal` and enforces the bounded timeout above. Cancellation or timeout must not return until the direct runner child has exited and process resources have been released. On platforms where the adapter can create and terminate an owned process group, it must terminate that group so runner descendants do not survive. Descendant termination is explicitly best-effort on platforms without that primitive; P304 must test the guaranteed direct-child behavior on every supported platform and process-group cleanup where supported rather than claiming a portable guarantee it cannot enforce. Discovery should observe cancellation between filesystem operations.

Cancellation and timeout are distinct normalized outcomes rather than successful test failures.

## Output And Errors

Malformed MCP input is rejected at the MCP boundary. Missing files, escaped real paths, unsupported test IDs, spawn failures, and invalid project conditions are domain errors that surface as MCP tool errors.

Normal failing tests are successful tool calls containing structured failed-test results; a test assertion failure is not an MCP protocol error.

All returned collections and captured diagnostic text use the explicit discovery/execution bounds above. Truncation metadata must mean content was actually omitted, not merely that a configured bound was reached.

## Deterministic Fixture

P303-P304 should use a product-local fixture workspace with passing, failing, nested, and non-test source files. Fixture tests must prove stable discovery order/IDs, confinement, evidence-based truncation, normal failures versus tool errors, cancellation/timeout cleanup, and bounded failure output before real-repository dogfooding.

## P305 Dogfooding Findings

Dogfooding against this monorepo confirms the bounded Node adapter works for real product tests when the workspace root matches the package execution context used by pnpm. Package-scoped discovery completed in 1.3-2.8 ms and execution completed in about 1.6 s for Workflow Guard (32 normalized test records), 6.5 s for Code Intelligence (38 records), and 3.0 s for Test Intelligence (25 records), all with zero failures and no result truncation under the default 30 s timeout. Root discovery found all 12 runnable-looking files in 6.1 ms without truncation.

The exercise also exposed two deliberate limitations to carry into P306. Discovery is filename/runner based, so it includes Test Intelligence's own fixture tests, including an intentionally failing fixture; callers still have to choose explicit IDs before execution. Also, `run_tests` uses the supplied workspace root as the child working directory and does not infer nested package execution contexts. Running the ten non-fixture test files together from the monorepo root timed out at 30 s because existing package tests use package-relative working-directory assumptions, while the same tests complete when each package is the workspace root. Test Intelligence should not guess package boundaries or execute package scripts in P305; project-structure evidence can inform P306 relevance. The explicit-ID boundary continues to prevent accidental execution during discovery, but selected repository tests execute with the MCP server's OS authority as documented above.

## P306 File Relevance

File relevance is structural and explainable rather than semantic. A query accepts one workspace-relative repository file and returns discovered Node test descriptors from the same nearest `package.json` project. Results rank the queried test file itself first (`exact_file`), then tests whose basename before `.test`/`.spec` matches the queried file's basename before its source extension (`matching_stem`), then remaining tests in that project (`same_project`). Each result exposes that reason; ties retain discovery's ordinal file order. This gives monorepos a package-aware fallback without pretending that filename similarity proves dependency coverage.

The source file and candidate tests are canonicalized before project comparison. Escaped symlinks, missing/non-file sources, and queries with no `package.json` at or below the workspace root are errors rather than guesses. Project ownership is determined only from the nearest ancestor `package.json`; package scripts and repository code are not executed. Results use the same default 100, maximum 500 bound as discovery, with evidence-based `truncated` metadata after relevance filtering.

P306 intentionally does not parse imports, infer symbols, exclude paths named `fixtures`, or claim that `same_project` tests cover the changed file. Symbol-to-test relevance remains deferred until a concrete composition with Code Intelligence can provide semantic evidence.

Monorepo dogfooding validates the project boundary and ranking: `apps/workflow-guard-mcp/src/policy.ts` returns `policy.test.ts` first as `matching_stem`, Code Intelligence source returns only its three package tests as `same_project`, and an exact Test Intelligence test file ranks itself first. These queries completed in 1.6-3.6 ms in the current repository. Relevance discovery starts at the identified package root rather than materializing tests from the whole monorepo, while nested packages are still filtered by nearest-package ownership. Test Intelligence's fixture files remain visible as `same_project` candidates where they share the product package; their reason makes the broad fallback explicit rather than silently treating them as dependency evidence.
