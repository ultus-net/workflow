/**
 * W167 (board issue #319): the READ-ONLY issue detail surface and the
 * hub-recorded provider read state behind the board's external-reference
 * liveness pills.
 *
 * The detail read reuses the shared provider discipline of
 * `task-provider.ts`: the operator's env declaration is classified by the
 * same `boardProviderFromEnv`, the provider is fetched over bounded 5s-abort
 * REST calls with an injectable `fetchImpl`, every row passes a defensive
 * shape guard, and every failure is an honest unconfigured/error state that
 * names what happened. Two reads make one detail: the issue itself (whose
 * body is the description) and its comment thread (author, body, created —
 * verbatim from the provider). A href-unsafe `html_url` is malformed exactly
 * as on the board (the review P1 pin); the detail record itself carries no
 * href, so the discipline never even gets the chance to render one.
 *
 * The proposal decision (recorded here, do not reverse): operator-authored
 * comments are NOT taken. No write path exists for the board, and a comment
 * posted to the provider is operator-token dispatch through the application
 * authority — the amendment-1 dispatch class, its own iteration. This
 * module reads; it never writes.
 *
 * The liveness record (`ProviderReadRecord`) is the hub's OWN memory of its
 * most recent provider read attempt — recorded at read time by the
 * composition root's wrapped read closures, never derived in the view and
 * never claimed from a client. The pills' four classes (the research's
 * Fresh / Stale / Requires auth / Unreachable) derive from this record in
 * the webapp presenters; here the record only stores what the provider
 * actually answered. A 401/403-class answer records `requires-auth`; a
 * transport failure, a 5xx, and the other refusals (a 404 unknown repo, a
 * 429 rate limit, an unreadable body, and the both-lanes-configured
 * ambiguity refusal — the hub never silently picks a provider, so no
 * provider contact happened at all) record `unreachable` with the
 * verbatim reason carried alongside — the label stays within the
 * four-class vocabulary while the tooltip states what actually happened.
 * An unconfigured hub performs NO provider read and records NOTHING: no
 * pill may claim a freshness the hub has no record of.
 *
 * The credential handling is the task-provider's: the token rides only the
 * authorization header and never any returned payload, record, or route
 * answer (pinned by value in test/issue-detail.test.ts).
 */

import { GITHUB_ISSUES_PAGE_SIZE, type BoardProviderState } from "./task-provider.js";

/** The provider's REST base — the task-provider's own (shared endpoint,
 * duplicated here only because the constant is module-private there and the
 * two modules must not grow a private import seam). */
const GITHUB_ISSUES_API = "https://api.github.com";

/** One thread row, verbatim from the provider: the author login, the body,
 * and the created timestamp it supplied — nothing synthesized. */
export interface IssueComment {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

/** The read-only issue detail: the provider's own description (body) and
 * comment thread, plus its honest bookkeeping. */
export interface IssueDetail {
  readonly provider: "github";
  /** The provider's human task reference ("#12"), from the fetched record. */
  readonly key: string;
  readonly title: string;
  /** The provider's own body text, verbatim. ABSENT when the provider
   * supplied none (a null or empty body is never coerced into ""). */
  readonly description?: string;
  readonly comments: readonly IssueComment[];
  /** Provider comment rows that failed the shape guard — counted, never
   * rendered with a guessed author or timestamp. */
  readonly commentsSkipped: number;
  /** Set when the response filled the whole first comment page: more may
   * exist, and the thread must say so rather than imply completeness. */
  readonly commentsTruncated?: true;
}

/** The fetch outcome the hub route and the web relay carry. A failed read
 * carries the provider's machine-readable status alongside the human
 * reason — the liveness record classifies 401/403-class answers from it
 * (the reason string is never parsed). */
export type IssueDetailOutcome =
  | { readonly state: "ok"; readonly detail: IssueDetail }
  | { readonly state: "unconfigured"; readonly missing: readonly string[] }
  | { readonly state: "error"; readonly reason: string; readonly status?: number };

/** The shape every provider-read outcome shares — the recorder's input. */
export type ProviderReadCarrier =
  | { readonly state: "ok" }
  | { readonly state: "unconfigured"; readonly missing: readonly string[] }
  | { readonly state: "error"; readonly reason: string; readonly status?: number };

/** The recorded read outcome classes behind the liveness pills. */
export type ProviderReadOutcome = "ok" | "requires-auth" | "unreachable";

/** The hub-recorded provider read state: ONE record of the hub's most
 * recent provider read attempt. This — and nothing else — is what the
 * liveness pills may derive from. */
export interface ProviderReadRecord {
  /** The hub-clock instant the completed read attempt was recorded at. */
  readonly at: string;
  readonly outcome: ProviderReadOutcome;
  /** The verbatim human reason a failed read carries — never laundered
   * into the pill label. */
  readonly reason?: string;
}

/**
 * Classifies a provider answer's machine status into the recorded read
 * outcome: a 401/403-class answer is the auth fault; everything else the
 * hub could not read through — a transport failure (no status at all), a
 * 5xx, and the other refusals (404 unknown repo, 429 rate limit, an
 * unreadable body) — is unreachable, with the verbatim reason recorded
 * alongside so the pill never hides what happened.
 */
export function classifyProviderRead(status: number | undefined): ProviderReadOutcome {
  if (status === 401 || status === 403) return "requires-auth";
  return "unreachable";
}

/** The hub's provider-read ledger: the record every liveness pill derives
 * from. Holds the most recent completed read; an unconfigured hub (which
 * never contacted the provider) records nothing. */
export interface ProviderReadLedger {
  record(outcome: ProviderReadCarrier): void;
  current(): ProviderReadRecord | undefined;
}

export function createProviderReadLedger(now: () => Date = () => new Date()): ProviderReadLedger {
  let current: ProviderReadRecord | undefined;
  return {
    record(outcome: ProviderReadCarrier): void {
      // An unconfigured hub never contacted the provider — there is NO read
      // to record, and a fabricated record would claim a freshness the hub
      // has no evidence of.
      if (outcome.state === "unconfigured") return;
      if (outcome.state === "ok") {
        current = { at: now().toISOString(), outcome: "ok" };
        return;
      }
      current = {
        at: now().toISOString(),
        outcome: classifyProviderRead(outcome.status),
        ...(outcome.reason.length > 0 ? { reason: outcome.reason } : {}),
      };
    },
    current: () => current,
  };
}

/**
 * Wraps a provider-read closure so every invocation records its outcome
 * hub-side (the composition root wraps each of its read closures once — the
 * routes never classify, and a read performed for ANY route updates the
 * record). The outcome passes through unchanged; a throwing read records
 * nothing (the previous record stands — no fabricated state).
 */
export function recordProviderReads<Arguments extends unknown[], Outcome extends ProviderReadCarrier>(
  ledger: ProviderReadLedger,
  read: (...arguments_: Arguments) => Promise<Outcome>,
): (...arguments_: Arguments) => Promise<Outcome> {
  return async (...arguments_: Arguments) => {
    const outcome = await read(...arguments_);
    ledger.record(outcome);
    return outcome;
  };
}

/** The defensive issue guard: what the provider must supply for the detail
 * to render. Same posture as the board's row guard — a wrong-typed field
 * makes the read malformed (an honest error), never a coerced guess. */
interface GitHubIssuePayload {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly state?: unknown;
  readonly html_url?: unknown;
  readonly body?: unknown;
  readonly pull_request?: unknown;
}

/** The defensive comment-row guard. */
interface GitHubIssueCommentPayload {
  readonly user?: { readonly login?: unknown } | null;
  readonly body?: unknown;
  readonly created_at?: unknown;
}

const issueHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "workflow-hub (task board projection)",
  "x-github-api-version": "2022-11-28",
});

/**
 * Fetches ONE issue's detail (the description read, then the thread read —
 * a failed issue read never renders a half detail) with the same bounded
 * fetch and shape guard as fetchBoardTasks. A transport failure, a non-2xx
 * answer, a pull request, or a malformed payload is an honest error state;
 * malformed comment rows are skipped and COUNTED. Nothing is fabricated
 * into the detail.
 */
export async function fetchIssueDetail(
  provider: BoardProviderState,
  issueNumber: number,
  fetchImpl: typeof fetch = fetch,
): Promise<IssueDetailOutcome> {
  // The detail read is GitHub-only this slice: an ADO-configured hub answers
  // unconfigured NAMING the gap (fail-closed, the W161 pattern) — never a
  // fabricated detail read through the wrong lane.
  if (provider.kind === "azure_devops") {
    return { state: "unconfigured", missing: ["WORKFLOW_GITHUB_REPO (the issue-detail read is GitHub-only; the azure_devops lane serves no detail/thread read)"] };
  }
  if (provider.kind !== "github") return { state: "unconfigured", missing: provider.missing };
  const issueUrl = `${GITHUB_ISSUES_API}/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repoName)}/issues/${issueNumber}`;
  let response: Response;
  try {
    response = await fetchImpl(issueUrl, {
      headers: issueHeaders(provider.token),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return { state: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const suffix = detail.length > 0 && detail.length <= 200 ? `: ${detail}` : "";
    return { state: "error", reason: `the provider answered ${response.status}${suffix}`, status: response.status };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    return { state: "error", reason: `the provider body was not JSON (${error instanceof Error ? error.message : String(error)})`, status: response.status };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "error", reason: "the provider body was not an issue", status: response.status };
  }
  if ("pull_request" in parsed) {
    return { state: "error", reason: `#${issueNumber} is a pull request, not an issue`, status: response.status };
  }
  const issue = parsed as GitHubIssuePayload;
  if (typeof issue.number !== "number") {
    return { state: "error", reason: `#${issueNumber} did not match the issue shape`, status: response.status };
  }
  if (typeof issue.title !== "string" || issue.title.length === 0) {
    return { state: "error", reason: `#${issueNumber} did not match the issue shape`, status: response.status };
  }
  if (issue.state !== "open" && issue.state !== "closed") {
    return { state: "error", reason: `#${issueNumber} did not match the issue shape`, status: response.status };
  }
  // The URL becomes an href on the board card: only the provider's https
  // scheme is accepted — the same review P1 pin as the board's row guard.
  if (typeof issue.html_url !== "string" || !issue.html_url.startsWith("https://")) {
    return { state: "error", reason: `#${issueNumber} did not match the issue shape`, status: response.status };
  }
  // The provider's own body text, verbatim; a null (or empty) body is the
  // provider supplying NO description — recorded as absent, never coerced
  // into an empty string.
  const description = typeof issue.body === "string" && issue.body.length > 0 ? issue.body : undefined;
  let commentsResponse: Response;
  try {
    commentsResponse = await fetchImpl(`${issueUrl}/comments?per_page=${GITHUB_ISSUES_PAGE_SIZE}`, {
      headers: issueHeaders(provider.token),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return { state: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!commentsResponse.ok) {
    const detail = await commentsResponse.text().catch(() => "");
    const suffix = detail.length > 0 && detail.length <= 200 ? `: ${detail}` : "";
    return { state: "error", reason: `the provider answered ${commentsResponse.status}${suffix}`, status: commentsResponse.status };
  }
  let commentsParsed: unknown;
  try {
    commentsParsed = await commentsResponse.json();
  } catch (error) {
    return { state: "error", reason: `the provider body was not JSON (${error instanceof Error ? error.message : String(error)})`, status: commentsResponse.status };
  }
  if (!Array.isArray(commentsParsed)) {
    return { state: "error", reason: "the provider body was not a comment list", status: commentsResponse.status };
  }
  // Completeness honesty: the truncation flag keys on the RECEIVED page
  // count — before malformed rows are filtered — never on the rendered
  // count, which would hide a full page behind skipped rows.
  const received = commentsParsed.length;
  const comments: IssueComment[] = [];
  let commentsSkipped = 0;
  for (const entry of commentsParsed) {
    if (typeof entry !== "object" || entry === null) {
      commentsSkipped += 1;
      continue;
    }
    const row = entry as GitHubIssueCommentPayload;
    const author = typeof row.user?.login === "string" && row.user.login.length > 0 ? row.user.login : undefined;
    const body = typeof row.body === "string" ? row.body : undefined;
    const createdAt = typeof row.created_at === "string" && row.created_at.length > 0 ? row.created_at : undefined;
    // A comment missing its attribution (the author the provider supplies)
    // or its timestamp is skipped and counted — never rendered with a
    // synthesized "@unknown" or a guessed date.
    if (author === undefined || body === undefined || createdAt === undefined) {
      commentsSkipped += 1;
      continue;
    }
    comments.push({ author, body, createdAt });
  }
  return {
    state: "ok",
    detail: {
      provider: "github",
      key: `#${issue.number}`,
      title: issue.title,
      ...(description === undefined ? {} : { description }),
      comments,
      commentsSkipped,
      ...(received >= GITHUB_ISSUES_PAGE_SIZE ? { commentsTruncated: true as const } : {}),
    },
  };
}
