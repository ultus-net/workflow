# CI Intelligence Contract

## P601 Scope

Stage 6 starts with CI Intelligence because this repository already relies on
GitHub-hosted CI and Stage 5 identified external CI history as the next useful
evidence for change assessment. The domain is initially read-only. It reports
bounded normalized CI run and check evidence; it does not rerun, cancel,
dispatch, approve, mutate configuration, download arbitrary artifacts, or expose
provider credentials.

The first provider implementation may target GitHub Actions because that is the
repository's demonstrated CI system. The domain contract remains provider-neutral:
provider identifiers and URLs may be retained as provenance, but MCP callers do
not construct provider requests or receive raw provider responses.

## Domain Boundary

A CI provider adapter owns authentication, provider request construction,
pagination, response validation, normalization, cancellation, and provider-side
resource bounds. The domain exposes normalized run/check evidence. MCP owns input
schema validation and maps normalized domain errors to tool errors; it must not
interpret provider payloads or credentials.

The initial query identifies a repository through trusted product configuration,
not through an arbitrary caller-supplied API base URL. Callers may select a
bounded branch, commit SHA, or run identifier only where the provider adapter can
represent that selector without executing repository code. Provider repository
identity and the returned repository/run identity must agree; mismatches fail
closed rather than returning evidence for another repository.

CI evidence is observational. A passing run or check proves only the provider
state reported for the identified revision and workflow/check; it does not prove
that a local worktree was tested, that every relevant test ran, or that a check
covered a particular symbol.

## Trust And Credentials

Credentials come only from trusted process/product configuration. Repository
files, MCP arguments, remote response fields, logs, annotations, job names, step
names, commit messages, and URLs cannot supply or override credentials, API
hosts, authorization headers, or permission scopes.

The initial provider must require read-only access sufficient for CI metadata and
must document the exact provider permissions it needs. Missing permission is a
domain error, not a reason to broaden scope automatically. Mutating permissions
are neither required nor exercised by the initial product.

Authorization headers, tokens, cookies, credential-bearing request metadata, and
raw provider responses are never part of public results or diagnostic errors.
Errors may include a bounded provider status/category and a product-owned message,
but must not echo response headers or unvalidated response bodies. Logging, when
introduced, follows the same rule.

Remote CI data is untrusted content. Provider text is returned only in explicitly
bounded evidence fields and is never interpreted as instructions, shell input,
filesystem paths to read, or permission to make another request. Links are
evidence strings, not URLs that the server automatically follows. The adapter
uses a fixed HTTPS provider endpoint selected by trusted configuration and does
not follow response-provided API links as arbitrary hosts.

## Normalized Run Evidence

The first vertical slice returns recent CI runs for a selected repository and,
where requested, one exact commit SHA or branch. Each run has a stable
provider-qualified ID, workflow name, revision SHA, optional branch, normalized
state, normalized conclusion when terminal, start/update timestamps when the
provider supplies them, and an optional provider web URL retained as provenance.

Run state is `queued`, `in_progress`, or `completed`. Terminal conclusion is one
of `success`, `failure`, `cancelled`, `timed_out`, `skipped`, `neutral`,
`action_required`, or `unknown`. Unknown future provider conclusions remain
explicitly `unknown` and preserve a bounded provider value as diagnostic
provenance rather than being treated as success or failure.

Runs are ordered newest first by provider creation/start time, with stable run ID
as the deterministic tie-breaker. The public query accepts a positive `limit`,
default 20 and maximum 100. `truncated` is true only when at least one additional
permitted normalized run was observed. Pagination must stop once that fact is
known; the adapter must not exhaust provider history merely to count omitted
records.

P602 begins with run-level evidence. Job/check detail, logs, annotations,
artifacts, historical flake inference, and cross-run analytics require separate
tasks because they introduce materially different output, privacy, and context
bounds.

P603 dogfood prerequisite: the configured GitHub repository returned zero live
workflow runs when queried after P602, while its checked-in `CI` workflow has a
single `verify` job. Run evidence can therefore identify a failed workflow but
cannot localize failure to a job when workflows gain multiple jobs. P603 adds
only bounded job summaries for an explicit provider-qualified run ID. Step
results, logs, annotations, and separate check-run APIs remain deferred because
the current evidence does not demonstrate a need for their additional remote
metadata.

Job summaries preserve the run contract's normalized state/conclusion vocabulary
and expose provider-qualified job ID, bounded job name, revision, start and
optional completion timestamps, and optional provider web URL. The query accepts an explicit
`github:<run_id>` and a positive `limit`, default 20 and maximum 100. Results are
returned in provider page order because GitHub does not document a job sort order;
P603 therefore does not claim a global chronological top-N. `truncated` requires
an observed extra job. Repository authority derives from the trusted
repository-scoped request path because GitHub's Job payload has no repository
field; each returned `run_id` must still match the requested run. Response-size,
cancellation, timeout, error/privacy, pagination-ceiling, and trusted
configuration rules are otherwise identical to run listing. GitHub job `steps`,
runner identity/labels, and raw provider URLs other than the bounded web
provenance URL are not returned.

## Cancellation, Rate Limits, And Errors

Every provider request accepts an `AbortSignal`, uses a product-owned request
timeout, and stops pagination promptly after cancellation. Cancellation and
timeout are normalized domain errors. The adapter must not silently return a
partial result as complete after either condition.

Provider authentication failure, authorization failure, repository mismatch,
not-found selectors, rate limiting, malformed responses, unsupported provider
states, transport failure, cancellation, and timeout are normalized domain
errors. Rate-limit errors may expose bounded reset/retry timing when the provider
supplies it, but never raw headers. A valid repository with no matching runs is a
successful empty result.

Response validation happens before provider data enters domain results. The
adapter enforces internal response/body and pagination ceilings in addition to
the public record limit. Exceeding a safety ceiling before trustworthy record
boundaries are established is an error rather than a partial success.

## Deterministic Provider Fixture

P602-P604 use a product-local fake HTTP provider rather than live CI. Fixtures
must cover no runs; queued, running, passing, failing, cancelled, timed-out, and
unknown conclusions; branch and exact-SHA filtering; multiple pages; deterministic
ordering; evidence-based truncation; malformed JSON/schema; mismatched repository
identity; authentication/authorization failures; rate limiting; timeout; and
cancellation.

Hostile-response fixtures include oversized text, token-like values in response
headers and bodies, provider-controlled URLs pointing at a different host, and
instruction-like workflow names/messages. Tests prove secrets/headers/raw bodies
do not cross the public error/result boundary, untrusted URLs are not followed,
and remote text remains inert bounded data. Provider tests must not require real
network credentials.

After deterministic coverage passes, dogfooding may query this repository's real
CI with an explicitly supplied least-privilege credential. Live credentials and
live-provider availability are never prerequisites for the normal test suite.

## Deliberately Deferred

P601 does not approve CI mutations, workflow dispatch/rerun/cancellation,
artifact downloads, raw logs, annotations, provider webhooks, deployment state,
runtime observability, coverage inference, flaky-test inference, or Stage 7
`assess_change` composition. A second CI provider does not justify itself; add one
only after demonstrated demand and then extract a provider interface from the two
real adapters where their semantics actually match.

## P602 Acceptance Boundary

The next task defines `ci-intelligence-mcp` as an independently publishable
package and implements the smallest read-only run-listing vertical slice against
one provider adapter. It must keep credentials in trusted configuration, expose
only the normalized bounded result above, use deterministic fake-provider tests,
cover compiled MCP behavior and packed-artifact launch, and require no live
credential in repository verification. Provider-specific API details and exact
permission names must be verified against current official provider documentation
before implementation.
