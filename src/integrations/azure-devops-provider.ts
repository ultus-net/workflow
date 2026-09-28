/**
 * W168 (board issue #320): the Azure DevOps work-item provider, riding the
 * ONE ExternalTask record shape — a provider variant, never a fork. The
 * classification mirrors the GitHub lane (task-provider.ts), fail-closed:
 * absent variables are listed under their NAMES, a malformed declaration is
 * named invalid rather than silently coerced, and BOTH lanes fully
 * configured is an explicit ambiguity error — the hub never silently picks
 * a provider.
 *
 * The read path: a WIQL listing (System.ChangedDate descending,
 * $top-capped) followed by the workitems batch fetch — both bounded with a
 * 5s abort (the W144 lesson: no unbounded lane) and authenticated with the
 * PAT in the Authorization header ONLY. Non-2xx answers and transport
 * failures are honest error states naming what happened; the response body
 * is shape-guarded PER ROW — malformed rows are skipped + counted, never a
 * mid-mapping throw that would misreport the fault as hub unavailability.
 *
 * The mapping is the pinned table below: the standard Agile/Scrum/Basic
 * work item states onto the ONE column enum (open/closed); an UNKNOWN
 * state is skipped + counted, never guessed onto a column. Tags ride the
 * "; " join, the assignee comes from System.AssignedTo.displayName when
 * present and a non-empty string, the url must be the item's https html
 * href (_links.html.href), the key is "#<id>", and updatedAt is
 * System.ChangedDate verbatim. The PAT VALUE appears in no returned
 * payload, record, or error text.
 */

import { boardProviderFromEnv, fetchBoardTasks } from "./task-provider.js";
import type { BoardOutcome, BoardProviderState, ExternalTask } from "./task-provider.js";

/** The classified Azure DevOps declaration: the lane's unconfigured state
 * or the configured azure_devops variant of the ONE BoardProviderState
 * union. The token rides the azure_devops variant only, for the
 * Authorization header. */
export type AzureDevOpsProviderState = Extract<BoardProviderState, { readonly kind: "unconfigured" | "azure_devops" }>;

/** The defensive work-item row: what the batch response must supply for a
 * record to render. Every nested level is optional here and re-guarded at
 * runtime — a wrong-typed level degrades its own row, never the board. */
export interface AzureDevOpsWorkItemPayload {
  readonly id: number;
  readonly fields?: {
    readonly "System.Title"?: string;
    readonly "System.State"?: string;
    readonly "System.Tags"?: string;
    readonly "System.AssignedTo"?: { readonly displayName?: unknown } | null;
    readonly "System.ChangedDate"?: string;
  };
  readonly _links?: { readonly html?: { readonly href?: string } };
}

/** The pinned state→column table (the W168 mapping core): the standard
 * Agile/Scrum/Basic work item states onto the ONE column enum. Resolved
 * rides the terminal group with Done/Closed/Removed — the fix is in, the
 * item leaves the open column. An UNKNOWN state is never guessed onto a
 * column; its row is skipped + counted. */
export const AZURE_DEVOPS_STATE_COLUMNS: ReadonlyMap<string, ExternalTask["state"]> = new Map<string, ExternalTask["state"]>([
  ["Proposed", "open"],
  ["New", "open"],
  ["Active", "open"],
  ["Committed", "open"],
  ["To Do", "open"],
  ["Doing", "open"],
  ["Done", "closed"],
  ["Closed", "closed"],
  ["Resolved", "closed"],
  ["Removed", "closed"],
]);

export const AZURE_DEVOPS_PAGE_SIZE = 100;
const AZURE_DEVOPS_API_VERSION = "7.1";
const AZURE_DEVOPS_BASE = "https://dev.azure.com";

const AZURE_DEVOPS_WIQL_QUERY = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.ChangedDate] DESC";
const WORK_ITEM_FIELDS = ["System.Title", "System.State", "System.Tags", "System.AssignedTo", "System.ChangedDate"];

// A "/" inside an org or project declaration would forge an extra API path
// segment: named invalid, never silently coerced (the GitHub lane's rule).
const AZURE_DEVOPS_SEGMENT = /^[^/]+$/;

/**
 * Classifies the operator's Azure DevOps board configuration from env,
 * mirroring the GitHub lane: absent variables are listed under their NAMES;
 * a malformed org or project declaration is named as invalid instead of
 * being silently coerced into a different URL shape.
 */
export function azureDevOpsProviderFromEnv(env: NodeJS.ProcessEnv): AzureDevOpsProviderState {
  const missing: string[] = [];
  const org = env.WORKFLOW_AZURE_DEVOPS_ORG;
  if (org === undefined || org.trim().length === 0) missing.push("WORKFLOW_AZURE_DEVOPS_ORG");
  else if (!AZURE_DEVOPS_SEGMENT.test(org.trim())) missing.push("WORKFLOW_AZURE_DEVOPS_ORG (invalid — expected a single path segment, no '/')");
  const project = env.WORKFLOW_AZURE_DEVOPS_PROJECT;
  if (project === undefined || project.trim().length === 0) missing.push("WORKFLOW_AZURE_DEVOPS_PROJECT");
  else if (!AZURE_DEVOPS_SEGMENT.test(project.trim())) missing.push("WORKFLOW_AZURE_DEVOPS_PROJECT (invalid — expected a single path segment, no '/')");
  const token = env.WORKFLOW_AZURE_DEVOPS_TOKEN;
  if (token === undefined || token.trim().length === 0) missing.push("WORKFLOW_AZURE_DEVOPS_TOKEN");
  if (missing.length > 0 || org === undefined || project === undefined || token === undefined) {
    return { kind: "unconfigured", missing };
  }
  return { kind: "azure_devops", org: org.trim(), project: project.trim(), token: token.trim() };
}

function externalTaskFromWorkItem(payload: AzureDevOpsWorkItemPayload): ExternalTask | undefined {
  if (typeof payload.id !== "number" || !Number.isInteger(payload.id) || payload.id <= 0) return undefined;
  const fields = payload.fields;
  if (typeof fields !== "object" || fields === null) return undefined;
  const title = fields["System.Title"];
  if (typeof title !== "string" || title.length === 0) return undefined;
  const state = fields["System.State"];
  if (typeof state !== "string") return undefined;
  // The pinned table: an unknown state is skipped + counted, never guessed
  // onto a column.
  const column = AZURE_DEVOPS_STATE_COLUMNS.get(state);
  if (column === undefined) return undefined;
  // Tags ride the "; " join: a PRESENT wrong-typed field makes the row
  // malformed (skipped + counted, never a mid-mapping throw); an ABSENT
  // field is the interface contract's honest absent case and maps to no
  // labels; empty segments are dropped after the trim.
  const tags = fields["System.Tags"];
  if (tags !== undefined && typeof tags !== "string") return undefined;
  const labels = typeof tags === "string"
    ? tags.split(";").map((tag) => tag.trim()).filter((tag) => tag.length > 0)
    : [];
  const assignedTo = fields["System.AssignedTo"];
  const displayName = typeof assignedTo === "object" && assignedTo !== null && "displayName" in assignedTo
    ? assignedTo.displayName
    : undefined;
  const assignee = typeof displayName === "string" && displayName.length > 0 ? displayName : undefined;
  const changedDate = fields["System.ChangedDate"];
  if (typeof changedDate !== "string" || changedDate.length === 0) return undefined;
  // The url must be the item's https html href: the record's only outbound
  // link, and a compromised or malicious provider payload must never hand
  // the dashboard a javascript:/data:/http: link (the review-P1 rule).
  const href = payload._links?.html?.href;
  if (typeof href !== "string" || !href.startsWith("https://")) return undefined;
  return {
    provider: "azure_devops",
    key: `#${payload.id}`,
    title,
    state: column,
    url: href,
    labels,
    ...(assignee === undefined ? {} : { assignee }),
    updatedAt: changedDate,
  };
}

/**
 * Fetches the provider's work items (first page, ChangedDate-descending)
 * with bounded 5s aborts (the W144 lesson): a WIQL listing, then the
 * workitems batch. A non-2xx answer and a transport failure are honest
 * error states naming what happened; a broken listing fails closed rather
 * than silently dropping rows the listing claims to exist.
 */
export async function fetchAzureDevOpsBoardTasks(
  provider: AzureDevOpsProviderState,
  fetchImpl: typeof fetch = fetch,
): Promise<BoardOutcome> {
  if (provider.kind !== "azure_devops") return { state: "unconfigured", missing: provider.missing };
  const org = encodeURIComponent(provider.org);
  const project = encodeURIComponent(provider.project);
  const authorization = `Basic ${Buffer.from(`:${provider.token}`, "utf8").toString("base64")}`;
  const headers = {
    authorization,
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "workflow-hub (task board projection)",
  };
  const wiqlUrl = `${AZURE_DEVOPS_BASE}/${org}/${project}/_apis/wit/wiql?api-version=${AZURE_DEVOPS_API_VERSION}&$top=${AZURE_DEVOPS_PAGE_SIZE}`;
  let listingResponse: Response;
  try {
    listingResponse = await fetchImpl(wiqlUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: AZURE_DEVOPS_WIQL_QUERY }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return { state: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!listingResponse.ok) {
    const detail = await listingResponse.text().catch(() => "");
    const suffix = detail.length > 0 && detail.length <= 200 ? `: ${detail}` : "";
    return { state: "error", reason: `the provider answered ${listingResponse.status}${suffix}` };
  }
  let listingParsed: unknown;
  try {
    listingParsed = await listingResponse.json();
  } catch (error) {
    return { state: "error", reason: `the provider body was not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (
    typeof listingParsed !== "object" || listingParsed === null ||
    !("workItems" in listingParsed) || !Array.isArray(listingParsed.workItems)
  ) {
    return { state: "error", reason: "the provider body was not a WIQL work item listing" };
  }
  // Completeness honesty (the W161 review-P1 lesson): the truncation flag
  // keys on the RECEIVED listing count — before malformed rows are
  // filtered — never on the rendered count.
  const received = listingParsed.workItems.length;
  const ids: number[] = [];
  for (const entry of listingParsed.workItems) {
    const id = typeof entry === "object" && entry !== null && "id" in entry ? entry.id : undefined;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      return { state: "error", reason: "the provider's work item listing was malformed" };
    }
    ids.push(id);
  }
  if (received === 0) {
    return {
      state: "ok",
      board: { provider: "azure_devops", repo: `${provider.org}/${provider.project}`, tasks: [], skipped: 0, pullRequestsExcluded: 0 },
    };
  }
  const batchUrl = `${AZURE_DEVOPS_BASE}/${org}/${project}/_apis/wit/workitemsbatch?api-version=${AZURE_DEVOPS_API_VERSION}`;
  let batchResponse: Response;
  try {
    batchResponse = await fetchImpl(batchUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ ids, fields: [...WORK_ITEM_FIELDS] }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return { state: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!batchResponse.ok) {
    const detail = await batchResponse.text().catch(() => "");
    const suffix = detail.length > 0 && detail.length <= 200 ? `: ${detail}` : "";
    return { state: "error", reason: `the provider answered ${batchResponse.status}${suffix}` };
  }
  let parsed: unknown;
  try {
    parsed = await batchResponse.json();
  } catch (error) {
    return { state: "error", reason: `the provider body was not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    !("value" in parsed) || !Array.isArray(parsed.value)
  ) {
    return { state: "error", reason: "the provider body was not a work item list" };
  }
  const tasks: ExternalTask[] = [];
  let skipped = 0;
  // The guard runs per row and only ever adds to the counter: a provider
  // row of any shape can degrade its own record, never the whole board.
  for (const entry of parsed.value) {
    if (typeof entry !== "object" || entry === null) {
      skipped += 1;
      continue;
    }
    const task = externalTaskFromWorkItem(entry as AzureDevOpsWorkItemPayload);
    if (task === undefined) skipped += 1;
    else tasks.push(task);
  }
  return {
    state: "ok",
    board: {
      provider: "azure_devops",
      repo: `${provider.org}/${provider.project}`,
      tasks,
      skipped,
      pullRequestsExcluded: 0,
      ...(received >= AZURE_DEVOPS_PAGE_SIZE ? { truncated: true as const } : {}),
    },
  };
}

/**
 * W168: the hub's read dispatch — classifies BOTH provider lanes' env and
 * routes to exactly one provider read. Both lanes fully configured is an
 * explicit ambiguity error (the hub never silently picks one); when
 * neither lane is fully configured the outcome lists EVERY missing
 * variable under its name.
 */
export async function fetchBoardTasksFromEnv(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<BoardOutcome> {
  const github = boardProviderFromEnv(env);
  const azure = azureDevOpsProviderFromEnv(env);
  if (github.kind === "github" && azure.kind === "azure_devops") {
    return {
      state: "error",
      reason: "both providers are fully configured — the hub never silently picks one; unset one lane (GitHub: WORKFLOW_GITHUB_REPO/WORKFLOW_GITHUB_TOKEN, Azure DevOps: WORKFLOW_AZURE_DEVOPS_ORG/WORKFLOW_AZURE_DEVOPS_PROJECT/WORKFLOW_AZURE_DEVOPS_TOKEN)",
    };
  }
  if (github.kind === "github") return fetchBoardTasks(github, fetchImpl);
  if (azure.kind === "azure_devops") return fetchAzureDevOpsBoardTasks(azure, fetchImpl);
  return {
    state: "unconfigured",
    missing: [
      ...(github.kind === "unconfigured" ? github.missing : []),
      ...(azure.kind === "unconfigured" ? azure.missing : []),
    ],
  };
}
