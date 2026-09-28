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
 *
 * W162: the board card's delegate dispatch composes its run from THIS
 * hub-side read (fetchBoardTask) — attribution comes from the hub's own
 * provider read, never the browser's claim.
 *
 * W165: the provider-owned pull-request state behind a board issue's
 * run→work-product linkage. fetchWorkProductState reads ONE provider PR with
 * the same bounded fetch and shape-guard discipline as fetchBoardTask, and
 * workProductStates joins the registry's recorded links with the board's
 * rows into the card-level states the board renders. Nothing here mutates
 * the provider, the kernel, or any registry — the linkage is recorded
 * hub-side by the delegate lane (run-registry), never composed here.
 */

import type { WorkProductLink } from "./run-registry.js";

/** The neutral external-task record: what a GitHub issue and an Azure
 * DevOps work item can both map onto. `key` is the provider's human task
 * reference ("#12"); `url` links OUT of the dashboard; `updatedAt` is the
 * provider's own timestamp, rendered verbatim. */
export interface ExternalTask {
  readonly provider: "github" | "azure_devops";
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
  readonly provider: "github" | "azure_devops";
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

/** The classified env declaration (W168: one union — the Azure DevOps lane
 * is a provider VARIANT of this record shape, never a fork). The token
 * rides ONLY the provider variants — the unconfigured/error states carry
 * no secret material. */
export type BoardProviderState =
  | { readonly kind: "unconfigured"; readonly missing: readonly string[] }
  | { readonly kind: "github"; readonly owner: string; readonly repo: string; readonly repoName: string; readonly token: string }
  | { readonly kind: "azure_devops"; readonly org: string; readonly project: string; readonly token: string };

/** The BoardProviderState lanes the GitHub fetchers serve: unconfigured
 * plus github. The W168 azure_devops lane dispatches to the Azure DevOps
 * provider instead (fetchBoardTasksFromEnv), so the fetchers' input stays
 * type-honest while the GitHub logic below stays byte-identical. */
export type GitHubBoardProviderState = Extract<BoardProviderState, { readonly kind: "unconfigured" | "github" }>;

export const GITHUB_ISSUES_PAGE_SIZE = 100;
const GITHUB_API = "https://api.github.com";

const REPO_DECLARATION = /^[^/\s]+\/[^/\s]+$/;

/**
 * Classifies the operator's board configuration from env. Absent variables
 * are listed under their NAMES; a malformed repo declaration is named as
 * invalid instead of being silently coerced into an owner/repo split.
 */
export function boardProviderFromEnv(env: NodeJS.ProcessEnv): GitHubBoardProviderState {
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
  provider: GitHubBoardProviderState,
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

/** The single-issue fetch outcome behind the W162 delegate dispatch. */
export type BoardTaskOutcome =
  | { readonly state: "ok"; readonly task: ExternalTask }
  | { readonly state: "unconfigured"; readonly missing: readonly string[] }
  | { readonly state: "error"; readonly reason: string };

/**
 * W162: fetches ONE provider issue with the same bounded fetch and shape
 * guard as fetchBoardTasks — the hub-side read the delegate route composes
 * its run from (the attribution is recorded from this read, never from the
 * client's claim). A transport failure, a non-2xx answer, a non-issue body,
 * or a pull request is an honest error state; nothing is fabricated into a
 * task.
 */
export async function fetchBoardTask(
  provider: GitHubBoardProviderState,
  issueNumber: number,
  fetchImpl: typeof fetch = fetch,
): Promise<BoardTaskOutcome> {
  if (provider.kind !== "github") return { state: "unconfigured", missing: provider.missing };
  const url = `${GITHUB_API}/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repoName)}/issues/${issueNumber}`;
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "error", reason: "the provider body was not an issue" };
  }
  if ("pull_request" in parsed) return { state: "error", reason: `#${issueNumber} is a pull request, not an issue` };
  const task = externalTaskFromPayload(parsed as GitHubIssuePayload);
  if (task === undefined) return { state: "error", reason: `#${issueNumber} did not match the task shape` };
  return { state: "ok", task };
}

/** The provider-owned pull-request state a linked board card renders (W165):
 * the provider's own fields verbatim, the draft flag carried ONLY when the
 * payload has one, and the read's as-of liveness stated. */
export interface WorkProductPullRequestState {
  readonly provider: "github";
  /** The provider's human PR reference ("#34") — the join's link key. */
  readonly key: string;
  /** The provider's own https href, verbatim. */
  readonly url: string;
  /** The provider's own open/closed, verbatim. */
  readonly state: "open" | "closed";
  readonly draft?: boolean;
  /** When the hub made the read (ISO) — the rendered "as of" liveness. */
  readonly asOf: string;
}

/** The W165 PR-state read outcome: fetchBoardTask's honest-state posture —
 * an unconfigured provider names its missing declaration, a fault carries
 * its reason, and nothing is ever coerced into a guessed PR state. */
export type WorkProductStateOutcome =
  | { readonly state: "ok"; readonly product: WorkProductPullRequestState }
  | { readonly state: "unconfigured"; readonly missing: readonly string[] }
  | { readonly state: "error"; readonly reason: string };

/**
 * W165: fetches the provider's pull-request record behind a linked board
 * reference with the SAME bounded fetch and shape-guard discipline as
 * fetchBoardTask — the hub-side read the board's work-product join composes
 * from. The "pull_request" row marker is required (a plain issue at the
 * linked reference is the honest "not a pull request" error, never a guessed
 * state), the state field must hold the provider's own open/closed contract,
 * and the href is https-only like the board's row guard.
 */
export async function fetchWorkProductState(
  provider: BoardProviderState,
  issueNumber: number,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkProductStateOutcome> {
  // The work-product read is GitHub-only this slice: an ADO-configured hub
  // answers unconfigured NAMING the gap (fail-closed, the W161 pattern) —
  // never a fabricated PR-state read through the wrong lane.
  if (provider.kind === "azure_devops") {
    return { state: "unconfigured", missing: ["WORKFLOW_GITHUB_REPO (the work-product read is GitHub-only; the azure_devops lane serves no PR-state read)"] };
  }
  if (provider.kind !== "github") return { state: "unconfigured", missing: provider.missing };
  const url = `${GITHUB_API}/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repoName)}/issues/${issueNumber}`;
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "error", reason: "the provider body was not an issue" };
  }
  if (!("pull_request" in parsed)) return { state: "error", reason: `#${issueNumber} is not a pull request` };
  const row = parsed as GitHubIssuePayload & { readonly draft?: unknown };
  const prNumber = row.number;
  const prState = row.state;
  const href = row.html_url;
  const draft = row.draft;
  const shapeError = `#${issueNumber} did not match the pull-request shape`;
  if (typeof prNumber !== "number") return { state: "error", reason: shapeError };
  if (typeof row.title !== "string" || row.title.length === 0) return { state: "error", reason: shapeError };
  if (prState !== "open" && prState !== "closed") return { state: "error", reason: shapeError };
  // The URL becomes an href in the view: only the provider's https scheme is
  // accepted — a hostile payload can never hand the dashboard a javascript:
  // or data: link (the board's review-P1 guard, mirrored).
  if (typeof href !== "string" || !href.startsWith("https://")) return { state: "error", reason: shapeError };
  if (typeof row.updated_at !== "string" || row.updated_at.length === 0) return { state: "error", reason: shapeError };
  // The draft flag: a wrong-typed one makes the row malformed; an absent one
  // maps the honest absence (never draft:false by inference).
  if (draft !== undefined && typeof draft !== "boolean") return { state: "error", reason: shapeError };
  return {
    state: "ok",
    product: {
      provider: "github",
      key: `#${prNumber}`,
      url: href,
      state: prState,
      ...(typeof draft === "boolean" ? { draft } : {}),
      asOf: new Date().toISOString(),
    },
  };
}

/** The W165 card-level work-product state the board renders: the honest
 * absence when no run is linked, the hub's own PR read when one is, or the
 * read's failure reason verbatim when the provider would not answer. */
export type WorkProductCardState =
  | { readonly state: "linked"; readonly runId: string; readonly product: WorkProductPullRequestState }
  | { readonly state: "unreadable"; readonly runId: string; readonly reason: string }
  | { readonly state: "unlinked" };

/**
 * W165: the hub-side join over the registry's recorded run→PR links and the
 * board's task rows — one WorkProductCardState per board card, keyed by the
 * card's own reference. The most recently recorded link per reference wins
 * (the registry map's iteration order IS its recording order); the read
 * receives the numeric issue the link's key names ("#N"). Cards without a
 * recorded link are never sent to the provider — they render the honest
 * unlinked state, and no state is ever inferred.
 */
export async function workProductStates(
  board: BoardTasks,
  links: ReadonlyMap<string, WorkProductLink>,
  read: (issueNumber: number) => Promise<WorkProductStateOutcome>,
): Promise<Record<string, WorkProductCardState>> {
  const latest = new Map<string, { readonly runId: string; readonly issueNumber: number }>();
  for (const [runId, link] of links) {
    const reference = /^#(\d+)$/.exec(link.key);
    if (reference === null || reference[1] === undefined) continue;
    latest.set(link.key, { runId, issueNumber: Number(reference[1]) });
  }
  const cards = await Promise.all(
    board.tasks.map(async (task): Promise<readonly [string, WorkProductCardState]> => {
      const link = latest.get(task.key);
      if (link === undefined) return [task.key, { state: "unlinked" }];
      const outcome = await read(link.issueNumber);
      if (outcome.state === "ok") return [task.key, { state: "linked", runId: link.runId, product: outcome.product }];
      if (outcome.state === "error") return [task.key, { state: "unreadable", runId: link.runId, reason: outcome.reason }];
      // An unconfigured PR-state read cannot answer for a LINKED card — the
      // honest unreadable state names the missing declaration.
      return [task.key, { state: "unreadable", runId: link.runId, reason: `the provider is not configured (${outcome.missing.join(", ")})` }];
    }),
  );
  return Object.fromEntries(cards);
}

/** The board projection: columns from the provider-owned state field only,
 * provider order preserved (updated-descending), inputs never mutated. */
export function boardProjection(board: BoardTasks): { readonly open: readonly ExternalTask[]; readonly closed: readonly ExternalTask[] } {
  return {
    open: board.tasks.filter((task) => task.state === "open"),
    closed: board.tasks.filter((task) => task.state === "closed"),
  };
}
