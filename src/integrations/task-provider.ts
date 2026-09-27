/**
 * W161 (the external-task board, Paperclip borrow iteration 1): the GitHub
 * task provider and the board projection.
 *
 * The operator wants a project board fed by a connected repository's issue
 * tracker (GitHub first, Azure DevOps behind the same record shape later).
 * This module is the READ-ONLY external surface of that board: it classifies
 * the operator's env declaration, fetches the provider's issues over a
 * bounded REST call, guards the payload shape, and projects the records into
 * board columns. Nothing here mutates the provider, the kernel, or any
 * registry — delegation from a board card is a later iteration that will
 * dispatch through the application authority like every other write.
 *
 * Fail-closed posture (the house rule):
 * - an absent or malformed env declaration is an "unconfigured" state that
 *   NAMES the offending variable; it is never an empty board;
 * - a provider rejection (bad credential, rate limit) or a network failure
 *   is an honest "error" state carrying the reason;
 * - a well-formed response maps records verbatim; pull requests (which ride
 *   the issues endpoint) are excluded and COUNTED; malformed rows are
 *   skipped and COUNTED — the board renders records, never guesses.
 *
 * The credential handling: the token is read from WORKFLOW_GITHUB_TOKEN at
 * classification time, sent only as the provider request's authorization
 * header, and NEVER included in any returned payload — the hub route and
 * the web relay carry records only. (Credential custody
 * (`src/ui/admin-control-plane.ts`) is the later home for this secret; the
 * env path is the minimal iteration.)
 *
 * The board columns derive ONLY from the provider-owned `state` field
 * (open/closed) plus the provider's own sort order (updated, descending).
 * No UI-side status inference: an assigned issue is still open, a labeled
 * issue is whatever its labels say, and the "delegated" column arrives in a
 * later iteration as hub-owned run linkage, not a timestamp heuristic.
 */

/** The neutral external-task record: what a GitHub issue and an Azure
 * DevOps work item can both map onto. `key` is the provider's human task
 * reference ("#12"); `url` links OUT of the dashboard; `updatedAt` is the
 * provider's own timestamp, rendered verbatim. */
export interface ExternalTask {
  readonly provider: "github";
  readonly key: string;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly url: string;
  readonly labels: readonly string[];
  readonly assignee?: string;
  readonly updatedAt: string;
}

/** One fetched page of provider records plus its honest bookkeeping. */
export interface BoardTasks {
  readonly provider: "github";
  /** The configured "owner/name" repository declaration, verbatim. */
  readonly repo: string;
  readonly tasks: readonly ExternalTask[];
  /** Provider rows that failed the shape guard — counted, never rendered. */
  readonly skipped: number;
  /** Pull requests riding the issues endpoint — excluded, counted. */
  readonly pullRequestsExcluded: number;
  /** Set when the response filled the whole first page: more may exist, and
   * the board must say so rather than imply completeness. */
  readonly truncated?: true;
}

/** The fetch outcome the hub route and the web relay carry. */
export type BoardOutcome =
  | { readonly state: "ok"; readonly board: BoardTasks }
  | { readonly state: "unconfigured"; readonly missing: readonly string[] }
  | { readonly state: "error"; readonly reason: string };

/** The classified env declaration. The token rides the "github" variant
 * ONLY — the unconfigured/error states carry no secret material. */
export type BoardProviderState =
  | { readonly kind: "unconfigured"; readonly missing: readonly string[] }
  | { readonly kind: "github"; readonly owner: string; readonly repo: string; readonly repoName: string; readonly token: string };

export const GITHUB_ISSUES_PAGE_SIZE = 100;
const GITHUB_API = "https://api.github.com";

const REPO_DECLARATION = /^[^/\s]+\/[^/\s]+$/;

/**
 * Classifies the operator's board configuration from env. Absent variables
 * are listed under their NAMES; a malformed repo declaration is named as
 * invalid instead of being silently coerced into an owner/repo split.
 */
export function boardProviderFromEnv(env: NodeJS.ProcessEnv): BoardProviderState {
  const missing: string[] = [];
  const declaration = env.WORKFLOW_GITHUB_REPO;
  if (declaration === undefined || declaration.trim().length === 0) {
    missing.push("WORKFLOW_GITHUB_REPO");
  } else if (!REPO_DECLARATION.test(declaration.trim())) {
    missing.push("WORKFLOW_GITHUB_REPO (invalid — expected 'owner/name')");
  }
  const token = env.WORKFLOW_GITHUB_TOKEN;
  if (token === undefined || token.trim().length === 0) missing.push("WORKFLOW_GITHUB_TOKEN");
  if (missing.length > 0 || declaration === undefined || token === undefined) {
    return { kind: "unconfigured", missing };
  }
  const [owner, repoName] = declaration.trim().split("/");
  // The regex above guarantees both segments exist; the non-null assertions
  // stay local to this split and the type still carries no bare strings.
  return { kind: "github", owner: owner ?? "", repo: declaration.trim(), repoName: repoName ?? "", token: token.trim() };
}

/** The defensive row guard: what the provider must supply for a record to
 * render. Everything optional is either present-and-typed or absent — a
 * wrong-typed field makes the row malformed (skipped + counted), never a
 * coerced guess. */
export interface GitHubIssuePayload {
  /** The API object URL rides the payload; consumed fields only below —
   * the guard ignores the rest rather than coercing it. */
  readonly url?: unknown;
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly html_url: string;
  readonly updated_at: string;
  readonly labels?: readonly ({ readonly name?: unknown } | string)[];
  readonly assignee?: { readonly login?: unknown } | null;
  readonly pull_request?: unknown;
}

function externalTaskFromPayload(payload: GitHubIssuePayload): ExternalTask | undefined {
  if (typeof payload.number !== "number") return undefined;
  if (typeof payload.title !== "string" || payload.title.length === 0) return undefined;
  if (payload.state !== "open" && payload.state !== "closed") return undefined;
  // The URL becomes an href in the view: only the provider's https scheme is
  // accepted — a compromised or malicious provider payload must never hand
  // the dashboard a javascript:/data: link (review P1).
  if (typeof payload.html_url !== "string" || !payload.html_url.startsWith("https://")) return undefined;
  if (typeof payload.updated_at !== "string" || payload.updated_at.length === 0) return undefined;
  // Labels: a PRESENT wrong-typed field makes the whole row malformed
  // (skipped + counted, review P1: never a mid-mapping throw that would
  // misreport the fault as hub unavailability); an ABSENT field is the
  // interface contract's honest "absent" case (review P3) and maps to no
  // labels; wrong-typed ELEMENTS are dropped element-wise — both the object
  // form and GitHub's legacy string form are real provider shapes, an
  // empty/unnamed entry renders nothing.
  if (payload.labels !== undefined && !Array.isArray(payload.labels)) return undefined;
  const labels = (payload.labels ?? []).flatMap((label) => {
    if (typeof label === "string") return label.length > 0 ? [label] : [];
    return typeof label?.name === "string" && label.name.length > 0 ? [label.name] : [];
  });
  const assignee = typeof payload.assignee?.login === "string" ? payload.assignee.login : undefined;
  return {
    provider: "github",
    key: `#${payload.number}`,
    title: payload.title,
    state: payload.state,
    url: payload.html_url,
    labels,
    ...(assignee === undefined ? {} : { assignee }),
    updatedAt: payload.updated_at,
  };
}

/**
 * Fetches the provider's issues (first page, updated-descending) with a
 * bounded 5s abort (the W144 lesson: no unbounded lane). A non-2xx answer
 * and a transport failure are honest error states that name what happened.
 */
export async function fetchBoardTasks(
  provider: BoardProviderState,
  fetchImpl: typeof fetch = fetch,
): Promise<BoardOutcome> {
  if (provider.kind !== "github") return { state: "unconfigured", missing: provider.missing };
  const url = `${GITHUB_API}/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repoName)}/issues?state=all&sort=updated&direction=desc&per_page=${GITHUB_ISSUES_PAGE_SIZE}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${provider.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "workflow-hub (task board projection)",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return { state: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const suffix = detail.length > 0 && detail.length <= 200 ? `: ${detail}` : "";
    return { state: "error", reason: `the provider answered ${response.status}${suffix}` };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    return { state: "error", reason: `the provider body was not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!Array.isArray(parsed)) return { state: "error", reason: "the provider body was not an issue list" };
  // Completeness honesty (review P1): the truncation flag keys on the RECEIVED
  // page count — before PRs and malformed rows are filtered — never on the
  // rendered count, which would hide a full page behind excluded rows.
  const received = parsed.length;
  const tasks: ExternalTask[] = [];
  let skipped = 0;
  let pullRequestsExcluded = 0;
  // The guard runs per row and only ever adds to the counters: a provider row
  // of any shape can degrade its own record, never the whole board.
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      skipped += 1;
      continue;
    }
    if ("pull_request" in entry) {
      pullRequestsExcluded += 1;
      continue;
    }
    const task = externalTaskFromPayload(entry as GitHubIssuePayload);
    if (task === undefined) skipped += 1;
    else tasks.push(task);
  }
  return {
    state: "ok",
    board: {
      provider: "github",
      repo: provider.repo,
      tasks,
      skipped,
      pullRequestsExcluded,
      ...(received >= GITHUB_ISSUES_PAGE_SIZE ? { truncated: true as const } : {}),
    },
  };
}

/** The board projection: columns from the provider-owned state field only,
 * provider order preserved (updated-descending), inputs never mutated. */
export function boardProjection(board: BoardTasks): { readonly open: readonly ExternalTask[]; readonly closed: readonly ExternalTask[] } {
  return {
    open: board.tasks.filter((task) => task.state === "open"),
    closed: board.tasks.filter((task) => task.state === "closed"),
  };
}
