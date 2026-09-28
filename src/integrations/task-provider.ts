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
 *
 * W171: provider-owned PR discovery. The linked+open in_review state is
 * unreachable while the only producer records the delegated board ISSUE's
 * reference (the PR-state read honestly refuses it). The honest producer is
 * discovery: fetchIssueCrossReferences reads the issue timeline's
 * cross-referenced PRs, and the join (given `discover`) re-reads the exactly-
 * one discovered reference through the same read — the PR's own state
 * decides. Zero or multiple references stay honestly unreadable naming the
 * ambiguity; the join itself records nothing.
 *
 * W163: the closed column converges on the provider-owned state_reason —
 * completed → done, not_planned/duplicate → cancelled; a closed issue with
 * a missing or unknown reason keeps the legacy closed column (no authority,
 * no split, no label guesses). The hub-side board read also carries an etag
 * cache: an entry within the TTL serves the cached board with no upstream
 * call (overlapping tabs share one read), a stale entry revalidates with
 * If-None-Match (a 304 serves the cached board as a revalidated hit), and an
 * entry past the TTL is never served — a failed revalidation is the honest
 * error.
 */

import type { RunOrigin, WorkProductLink } from "./run-registry.js";

/** The neutral external-task record: what a GitHub issue and an Azure
 * DevOps work item can both map onto. `key` is the provider's human task
 * reference ("#12"); `url` links OUT of the dashboard; `updatedAt` is the
 * provider's own timestamp, rendered verbatim. */
export interface ExternalTask {
  readonly provider: "github" | "azure_devops";
  readonly key: string;
  readonly title: string;
  readonly state: "open" | "closed";
  /** W163: the provider-owned state_reason behind a closed state (GitHub's
   * completed/not_planned/duplicate/reopened). Absent is the honest absent
   * case: a closed task without one has NO authority for a split and stays
   * in the legacy closed column; an unrecognized string is the same honest
   * absence — never a guessed column. */
  readonly stateReason?: "completed" | "not_planned" | "duplicate" | "reopened";
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
  /** W163: the read cache's TTL/hit bookkeeping — present only when the hub
   * read rides a cache (the composed hub lane); a cache-less caller's
   * payload is unchanged. */
  readonly cache?: BoardCacheMetadata;
}

/** W163: the hub-side read cache's honest bookkeeping on the board payload —
 * the TTL the hub serves within, whether THIS answer came from the cache,
 * and (for a hit) the cached board's age. A stale entry is never served: it
 * revalidates with If-None-Match first, and `revalidated` marks that 304
 * hit. */
export interface BoardCacheMetadata {
  readonly ttlMs: number;
  readonly hit: boolean;
  readonly ageMs?: number;
  readonly revalidated?: true;
}

/** W163: the TTL the hub serves a cached board read within. Overlapping
 * tabs share one upstream read inside it; past it the entry revalidates with
 * If-None-Match — it is never served stale. */
export const BOARD_CACHE_TTL_MS = 30_000;

/** One cached board read: the etag the provider answered with (absent when
 * the provider supplied none — the next stale read then goes out
 * unconditionally), the ok board it served, and when the hub fetched or last
 * revalidated it. Errors are never cached. */
export interface BoardReadCacheEntry {
  readonly etag?: string;
  readonly board: BoardTasks;
  readonly fetchedAt: number;
}

/** The hub-side board-read cache: keyed by repo, one in-flight read per repo
 * shared across callers (overlapping tabs), entries served only within the
 * TTL. The key set is the env-declared repos — bounded by construction. */
export interface BoardReadCache {
  readonly ttlMs: number;
  get(repo: string): BoardReadCacheEntry | undefined;
  set(repo: string, entry: BoardReadCacheEntry): void;
  /** The read another caller already started for the repo, if any — awaiting
   * it shares that upstream read. */
  inflight(repo: string): Promise<BoardOutcome> | undefined;
  beginInflight(repo: string, read: Promise<BoardOutcome>): void;
  endInflight(repo: string): void;
}

export function createBoardReadCache(ttlMs: number = BOARD_CACHE_TTL_MS): BoardReadCache {
  const entries = new Map<string, BoardReadCacheEntry>();
  const inflights = new Map<string, Promise<BoardOutcome>>();
  return {
    ttlMs,
    get: (repo) => entries.get(repo),
    set: (repo, entry) => {
      entries.set(repo, entry);
    },
    inflight: (repo) => inflights.get(repo),
    beginInflight: (repo, read) => {
      inflights.set(repo, read);
    },
    endInflight: (repo) => {
      inflights.delete(repo);
    },
  };
}

/** The fetch outcome the hub route and the web relay carry. */
export type BoardOutcome =
  | { readonly state: "ok"; readonly board: BoardTasks }
  | { readonly state: "unconfigured"; readonly missing: readonly string[] }
  | { readonly state: "error"; readonly reason: string; readonly status?: number };

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
  /** W163: the provider-owned closed reason (completed/not_planned/
   * duplicate/reopened). Optional like labels: an ABSENT field is the
   * honest absent case; a wrong-TYPED field makes the row malformed. */
  readonly state_reason?: unknown;
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
  // W163: the provider-owned state_reason. A PRESENT wrong-typed field makes
  // the row malformed (the labels precedent: never a coerced guess); an
  // unrecognized string carries no split authority and maps to the honest
  // absence — the projection keeps such a closed row in the legacy column.
  if (payload.state_reason !== undefined && typeof payload.state_reason !== "string") return undefined;
  const stateReason = payload.state_reason === "completed" || payload.state_reason === "not_planned"
    || payload.state_reason === "duplicate" || payload.state_reason === "reopened"
    ? payload.state_reason
    : undefined;
  return {
    provider: "github",
    key: `#${payload.number}`,
    title: payload.title,
    state: payload.state,
    ...(stateReason === undefined ? {} : { stateReason }),
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
 *
 * W163: with a cache, the read is hub-side shared — an entry within the TTL
 * serves the cached board with NO upstream call (overlapping tabs share one
 * read); a stale entry revalidates with If-None-Match and a 304 serves the
 * cached board as a revalidated hit; an entry past the TTL is never served
 * (a failed revalidation is the honest error, never a stale serve); errors
 * are never cached. Without a cache the read is the byte-identical W161
 * path.
 */
export async function fetchBoardTasks(
  provider: GitHubBoardProviderState,
  fetchImpl: typeof fetch = fetch,
  cache?: BoardReadCache,
): Promise<BoardOutcome> {
  if (provider.kind !== "github") return { state: "unconfigured", missing: provider.missing };
  if (cache === undefined) {
    const answer = await readBoardTasksPage(provider, fetchImpl);
    // notModified is unreachable without a conditional request (no etag is
    // ever presented here); named, never guessed.
    return answer.kind === "fresh"
      ? answer.outcome
      : { state: "error", reason: "the provider answered 304 to an unconditional read" };
  }
  const repo = provider.repo;
  const cached = cache.get(repo);
  if (cached !== undefined) {
    const ageMs = Date.now() - cached.fetchedAt;
    if (ageMs < cache.ttlMs) return boardOutcomeWithCache(cached.board, cache.ttlMs, { hit: true, ageMs });
  }
  const pending = cache.inflight(repo);
  if (pending !== undefined) return pending;
  const read = readWithCache(provider, fetchImpl, cache, cached);
  cache.beginInflight(repo, read);
  try {
    return await read;
  } finally {
    cache.endInflight(repo);
  }
}

/** One provider issues-page read: the outcome plus the etag the provider
 * answered with (for the cache's conditional revalidation). A 304 to a
 * conditional request is reported as notModified — the caller serves its
 * cached board. */
type BoardReadAnswer =
  | { readonly kind: "fresh"; readonly outcome: BoardOutcome; readonly etag?: string }
  | { readonly kind: "notModified" };

async function readBoardTasksPage(
  provider: Extract<BoardProviderState, { readonly kind: "github" }>,
  fetchImpl: typeof fetch,
  etag?: string,
): Promise<BoardReadAnswer> {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repoName)}/issues?state=all&sort=updated&direction=desc&per_page=${GITHUB_ISSUES_PAGE_SIZE}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${provider.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "workflow-hub (task board projection)",
        "x-github-api-version": "2022-11-28",
        ...(etag === undefined ? {} : { "if-none-match": etag }),
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return { kind: "fresh", outcome: { state: "error", reason: error instanceof Error ? error.message : String(error) } };
  }
  // The 304 check precedes the !ok gate (304 is not an ok status) and keys
  // on the etag that was actually presented — a 304 to an unconditional
  // request is a provider protocol fault and falls through to the honest
  // error.
  if (response.status === 304 && etag !== undefined) return { kind: "notModified" };
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const suffix = detail.length > 0 && detail.length <= 200 ? `: ${detail}` : "";
    return { kind: "fresh", outcome: { state: "error", reason: `the provider answered ${response.status}${suffix}`, status: response.status } };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    return { kind: "fresh", outcome: { state: "error", reason: `the provider body was not JSON (${error instanceof Error ? error.message : String(error)})`, status: response.status } };
  }
  if (!Array.isArray(parsed)) return { kind: "fresh", outcome: { state: "error", reason: "the provider body was not an issue list", status: response.status } };
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
  const wireEtag = response.headers.get("etag");
  return {
    kind: "fresh",
    outcome: {
      state: "ok",
      board: {
        provider: "github",
        repo: provider.repo,
        tasks,
        skipped,
        pullRequestsExcluded,
        ...(received >= GITHUB_ISSUES_PAGE_SIZE ? { truncated: true as const } : {}),
      },
    },
    ...(wireEtag === null ? {} : { etag: wireEtag }),
  };
}

/** The cache-participating read: revalidates a stale entry (304 serves the
 * cached board and refreshes its TTL window), stores a fresh ok board with
 * its etag, and never stores an error — the next read retries upstream. */
async function readWithCache(
  provider: Extract<BoardProviderState, { readonly kind: "github" }>,
  fetchImpl: typeof fetch,
  cache: BoardReadCache,
  cached: BoardReadCacheEntry | undefined,
): Promise<BoardOutcome> {
  const answer = await readBoardTasksPage(provider, fetchImpl, cached?.etag);
  if (answer.kind === "notModified") {
    // Unreachable without a cached etag (the conditional request is only
    // sent when one exists); named, never guessed.
    if (cached === undefined) return { state: "error", reason: "the provider answered 304 without a cached board" };
    cache.set(provider.repo, { ...cached, fetchedAt: Date.now() });
    return boardOutcomeWithCache(cached.board, cache.ttlMs, { hit: true, revalidated: true, ageMs: 0 });
  }
  if (answer.outcome.state === "ok") {
    cache.set(provider.repo, {
      ...(answer.etag === undefined ? {} : { etag: answer.etag }),
      board: answer.outcome.board,
      fetchedAt: Date.now(),
    });
  }
  return answer.outcome.state === "ok"
    ? boardOutcomeWithCache(answer.outcome.board, cache.ttlMs, { hit: false })
    : answer.outcome;
}

/** The board outcome served at a cache participation point: the cached or
 * freshly read board with the cache's honest TTL/hit bookkeeping attached. */
function boardOutcomeWithCache(
  board: BoardTasks,
  ttlMs: number,
  meta: { readonly hit: boolean; readonly ageMs?: number; readonly revalidated?: true },
): BoardOutcome {
  return {
    state: "ok",
    board: {
      ...board,
      cache: {
        ttlMs,
        hit: meta.hit,
        ...(meta.ageMs === undefined ? {} : { ageMs: meta.ageMs }),
        ...(meta.revalidated === true ? { revalidated: true as const } : {}),
      },
    },
  };
}

/** The single-issue fetch outcome behind the W162 delegate dispatch. The
 * error state's `status` (W167) is the provider's machine-readable answer
 * code where one exists — the human reason already states the number; the
 * field structures it (for the liveness record's 401/403 classification)
 * instead of leaving it to be parsed back out of the string. A transport
 * failure has no answer, so no status. */
export type BoardTaskOutcome =
  | { readonly state: "ok"; readonly task: ExternalTask }
  | { readonly state: "unconfigured"; readonly missing: readonly string[] }
  | { readonly state: "error"; readonly reason: string; readonly status?: number };

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
  if ("pull_request" in parsed) return { state: "error", reason: `#${issueNumber} is a pull request, not an issue`, status: response.status };
  const task = externalTaskFromPayload(parsed as GitHubIssuePayload);
  if (task === undefined) return { state: "error", reason: `#${issueNumber} did not match the task shape`, status: response.status };
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
 * its reason, and nothing is ever coerced into a guessed PR state. W171: the
 * not-a-pull-request error additionally carries the machine marker
 * (`notPullRequest: true`) the discovery join keys on — every other error
 * site omits it. */
export type WorkProductStateOutcome =
  | { readonly state: "ok"; readonly product: WorkProductPullRequestState }
  | { readonly state: "unconfigured"; readonly missing: readonly string[] }
  | { readonly state: "error"; readonly reason: string; readonly notPullRequest?: true };

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
  if (!("pull_request" in parsed)) return { state: "error", reason: `#${issueNumber} is not a pull request`, notPullRequest: true };
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

/** The W171 issue-timeline cross-reference discovery outcome: the guarded
 * cross-referenced pull requests behind a board issue, or the honest
 * unconfigured/error states (the same posture as every provider read). */
export type CrossReferenceOutcome =
  | {
      readonly state: "ok";
      /** The cross-referenced PR references — the provider's own "#N" key
       * and https href, verbatim. */
      readonly refs: readonly { readonly key: string; readonly url: string }[];
      /** Timeline rows that failed the guard — counted, never guessed. */
      readonly skipped: number;
    }
  | { readonly state: "unconfigured"; readonly missing: readonly string[] }
  | { readonly state: "error"; readonly reason: string; readonly status?: number };

/**
 * W171: fetches the issue timeline's cross-referenced pull requests with the
 * SAME bounded fetch and shape-guard discipline as fetchBoardTasks — the
 * provider-owned discovery the board's work-product join composes from when
 * a linked reference holds a board issue rather than a PR. Only rows with a
 * "cross-referenced" event whose source issue carries the pull_request
 * marker, a positive numeric reference, and an https href count; malformed
 * rows are skipped and COUNTED. Zero matches is an honest empty list, never
 * an error.
 */
export async function fetchIssueCrossReferences(
  provider: BoardProviderState,
  issueNumber: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CrossReferenceOutcome> {
  // The cross-reference read is GitHub-only this slice: an ADO-configured
  // hub answers unconfigured NAMING the gap (the work-product read's arm) —
  // never a fabricated discovery through the wrong lane.
  if (provider.kind === "azure_devops") {
    return { state: "unconfigured", missing: ["WORKFLOW_GITHUB_REPO (the cross-reference read is GitHub-only; the azure_devops lane serves no cross-reference read)"] };
  }
  if (provider.kind !== "github") return { state: "unconfigured", missing: provider.missing };
  const url = `${GITHUB_API}/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repoName)}/issues/${issueNumber}/timeline`;
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
    return { state: "error", reason: `the provider answered ${response.status}${suffix}`, status: response.status };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    return { state: "error", reason: `the provider body was not JSON (${error instanceof Error ? error.message : String(error)})`, status: response.status };
  }
  if (!Array.isArray(parsed)) return { state: "error", reason: "the provider body was not a timeline", status: response.status };
  const refs: { key: string; url: string }[] = [];
  let skipped = 0;
  // The guard runs per row and only ever adds to the counter: a provider row
  // of any shape can degrade its own reference, never the whole discovery.
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      skipped += 1;
      continue;
    }
    const row = entry as { readonly event?: unknown; readonly source?: unknown };
    const source = typeof row.source === "object" && row.source !== null ? (row.source as { readonly issue?: unknown }) : undefined;
    const sourceIssue = typeof source?.issue === "object" && source.issue !== null
      ? (source.issue as { readonly number?: unknown; readonly html_url?: unknown; readonly pull_request?: unknown })
      : undefined;
    if (
      row.event !== "cross-referenced" ||
      sourceIssue === undefined ||
      !("pull_request" in sourceIssue) ||
      typeof sourceIssue.number !== "number" ||
      !Number.isInteger(sourceIssue.number) ||
      sourceIssue.number <= 0 ||
      typeof sourceIssue.html_url !== "string" ||
      !sourceIssue.html_url.startsWith("https://")
    ) {
      skipped += 1;
      continue;
    }
    refs.push({ key: `#${sourceIssue.number}`, url: sourceIssue.html_url });
  }
  return { state: "ok", refs, skipped };
}

/**
 * The W165 card-level work-product state the board renders: the honest
 * absence when no run is linked, the hub's own PR read when one is, or the
 * read's failure reason verbatim when the provider would not answer.
 */
export type WorkProductCardState =
  | { readonly state: "linked"; readonly runId: string; readonly product: WorkProductPullRequestState }
  | { readonly state: "unreadable"; readonly runId: string; readonly reason: string }
  | { readonly state: "unlinked" };

/**
 * W162 slice 2: the hub-owned in_progress join — the OPEN board cards whose
 * provider-task origin names their key on an ACTIVE registry run (the
 * delegate route's recorded attribution, joined by the raw-id contract).
 * Pure: the route supplies the registry facts (active run ids + recorded
 * origins), the board supplies the cards. Nothing here reads clocks or
 * infers state — a timestamp heuristic is exactly what this join must never
 * be; a finished run's card is absent here because finish() removed its
 * ACTIVE membership even though its origin record persists.
 */
export function inProgressBoardTasks(
  board: BoardTasks,
  origins: ReadonlyMap<string, RunOrigin>,
  activeRunIds: readonly string[],
): readonly string[] {
  const activeProviderTaskKeys = new Set<string>();
  for (const runId of activeRunIds) {
    const origin = origins.get(runId);
    if (origin?.kind === "provider-task") activeProviderTaskKeys.add(origin.key);
  }
  return board.tasks
    .filter((task) => task.state === "open" && activeProviderTaskKeys.has(task.key))
    .map((task) => task.key);
}

/**
 * W165: the hub-side join over the registry's recorded run→PR links and the
 * board's task rows — one WorkProductCardState per board card, keyed by the
 * card's own reference. The most recently recorded link per reference wins
 * (the registry map's iteration order IS its recording order); the read
 * receives the numeric issue the link's key names ("#N"). Cards without a
 * recorded link are never sent to the provider — they render the honest
 * unlinked state, and no state is ever inferred.
 *
 * W171: the join stays PURE. When a linked reference's read fails with the
 * not-a-pull-request marker and `discover` is provided, the join asks the
 * PROVIDER (never a client) for the issue's cross-referenced PRs: exactly one
 * discovered reference is reported through `onDiscovered` (recording is the
 * route's bookkeeping) and re-read through the SAME read callback, so the
 * PR's own state decides the card. Zero references keep the unchanged
 * not-a-pull-request reason; multiple references and discovery faults are
 * honest unreadable states naming the ambiguity verbatim. `discover` absent
 * keeps the W165 behavior byte-identical.
 */
export async function workProductStates(
  board: BoardTasks,
  links: ReadonlyMap<string, WorkProductLink>,
  read: (issueNumber: number) => Promise<WorkProductStateOutcome>,
  discover?: (issueNumber: number) => Promise<CrossReferenceOutcome>,
  onDiscovered?: (runId: string, ref: { readonly key: string; readonly url: string }) => void,
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
      if (outcome.state === "error") {
        // W171: the not-a-pull-request marker is the discovery trigger — the
        // delegated board ISSUE's reference can never satisfy the PR-state
        // read; the provider's own timeline discovers the actual PR.
        if (outcome.notPullRequest === true && discover !== undefined) {
          const discovery = await discover(link.issueNumber);
          if (discovery.state === "error") return [task.key, { state: "unreadable", runId: link.runId, reason: discovery.reason }];
          if (discovery.state === "unconfigured") {
            return [task.key, { state: "unreadable", runId: link.runId, reason: `the provider is not configured (${discovery.missing.join(", ")})` }];
          }
          if (discovery.refs.length === 0) {
            // Zero cross-referenced PRs: the unchanged not-a-pull-request
            // reason — discovery found nothing, so the honest state stands.
            return [task.key, { state: "unreadable", runId: link.runId, reason: outcome.reason }];
          }
          if (discovery.refs.length > 1) {
            return [task.key, { state: "unreadable", runId: link.runId, reason: `the issue's timeline cross-references ${discovery.refs.length} pull requests; the work product is ambiguous` }];
          }
          const ref = discovery.refs[0];
          if (ref === undefined) {
            // Unreachable (refs.length === 1 passed); named, never guessed.
            return [task.key, { state: "unreadable", runId: link.runId, reason: "the discovered cross-reference is not a pull-request reference" }];
          }
          const discovered = /^#(\d+)$/.exec(ref.key);
          if (discovered === null || discovered[1] === undefined) {
            // Unreachable from the provider's own guard (its rows are guarded
            // to a numeric "#N" reference); a nonconforming discover is named,
            // never guessed.
            return [task.key, { state: "unreadable", runId: link.runId, reason: "the discovered cross-reference is not a pull-request reference" }];
          }
          const prNumber = Number(discovered[1]);
          onDiscovered?.(link.runId, ref);
          const product = await read(prNumber);
          if (product.state === "ok") return [task.key, { state: "linked", runId: link.runId, product: product.product }];
          if (product.state === "error") return [task.key, { state: "unreadable", runId: link.runId, reason: product.reason }];
          return [task.key, { state: "unreadable", runId: link.runId, reason: `the provider is not configured (${product.missing.join(", ")})` }];
        }
        return [task.key, { state: "unreadable", runId: link.runId, reason: outcome.reason }];
      }
      // An unconfigured PR-state read cannot answer for a LINKED card — the
      // honest unreadable state names the missing declaration.
      return [task.key, { state: "unreadable", runId: link.runId, reason: `the provider is not configured (${outcome.missing.join(", ")})` }];
    }),
  );
  return Object.fromEntries(cards);
}

/** The W163 column set: columns from the provider-owned state field plus the
 * provider-owned state_reason split of closed — completed → done,
 * not_planned/duplicate → cancelled; a closed task with a missing or unknown
 * reason keeps the legacy closed column (no authority, no split, no label
 * guesses). Provider order preserved per column, inputs never mutated. The
 * `stateReasonAuthority` marker reports whether ANY task carries a
 * provider-owned reason: once true, the legacy closed column stands only for
 * tasks without one. */
export interface BoardProjection {
  readonly open: readonly ExternalTask[];
  readonly done: readonly ExternalTask[];
  readonly cancelled: readonly ExternalTask[];
  /** Closed tasks without split authority (missing or unknown state_reason)
   * — the legacy closed column's population. */
  readonly closed: readonly ExternalTask[];
  readonly stateReasonAuthority: boolean;
}

export function boardProjection(board: BoardTasks): BoardProjection {
  const open: ExternalTask[] = [];
  const done: ExternalTask[] = [];
  const cancelled: ExternalTask[] = [];
  const closed: ExternalTask[] = [];
  for (const task of board.tasks) {
    if (task.state === "open") {
      open.push(task);
      continue;
    }
    if (task.stateReason === "completed") {
      done.push(task);
      continue;
    }
    if (task.stateReason === "not_planned" || task.stateReason === "duplicate") {
      cancelled.push(task);
      continue;
    }
    closed.push(task);
  }
  return {
    open,
    done,
    cancelled,
    closed,
    stateReasonAuthority: board.tasks.some((task) => task.stateReason !== undefined),
  };
}
