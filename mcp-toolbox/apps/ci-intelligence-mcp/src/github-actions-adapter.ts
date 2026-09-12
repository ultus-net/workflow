import { z } from "zod";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;
const API_VERSION = "2026-03-10";

const workflowRunSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().nullable(),
  head_branch: z.string().nullable(),
  head_sha: z.string().min(1),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  run_started_at: z.string().datetime().nullable().optional(),
  html_url: z.string(),
  repository: z.object({ full_name: z.string().min(1) }),
}).passthrough();

const workflowRunsSchema = z.object({
  workflow_runs: z.array(workflowRunSchema).max(100),
}).passthrough();

const workflowJobSchema = z.object({
  id: z.number().int().nonnegative(),
  run_id: z.number().int().nonnegative(),
  head_sha: z.string().min(1),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
  html_url: z.string().nullable(),
}).passthrough();

const workflowJobsSchema = z.object({ jobs: z.array(workflowJobSchema).max(100) }).passthrough();

export interface GitHubActionsConfig {
  repository: string;
  token?: string;
  apiUrl?: string;
}

export interface CiRun {
  id: string;
  workflowName: string;
  revision: string;
  branch?: string;
  state: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral" | "action_required" | "unknown";
  providerConclusion?: string;
  startedAt?: string;
  updatedAt: string;
  webUrl?: string;
}

export interface ListCiRunsOptions {
  branch?: string;
  revision?: string;
  limit?: number;
}

export interface CiRunResult {
  runs: CiRun[];
  truncated: boolean;
}

export interface CiJob {
  id: string;
  runId: string;
  name: string;
  revision: string;
  state: CiRun["state"];
  conclusion?: CiRun["conclusion"];
  providerConclusion?: string;
  startedAt: string;
  completedAt?: string;
  webUrl?: string;
}

export interface CiJobResult { jobs: CiJob[]; truncated: boolean }

export class CiProviderError extends Error {
  constructor(message: string, readonly category: "authentication" | "authorization" | "not_found" | "rate_limited" | "transport" | "invalid_response" | "cancelled" | "timeout") {
    super(message);
    this.name = "CiProviderError";
  }
}

function boundedText(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= MAX_TEXT_BYTES) return value;
  return bytes.subarray(0, MAX_TEXT_BYTES).toString("utf8").replace(/\uFFFD$/u, "");
}

function normalizeRun(run: z.infer<typeof workflowRunSchema>, repository: string): CiRun {
  const state = run.status === "completed"
    ? "completed"
    : run.status === "in_progress"
      ? "in_progress"
      : ["queued", "requested", "waiting", "pending"].includes(run.status ?? "")
        ? "queued"
        : undefined;
  if (!state) throw new CiProviderError("Provider returned an unsupported workflow run state", "invalid_response");

  const knownConclusions = new Set(["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required"]);
  const conclusion = state === "completed"
    ? (knownConclusions.has(run.conclusion ?? "") ? run.conclusion as NonNullable<CiRun["conclusion"]> : "unknown")
    : undefined;
  const webUrl = URL.canParse(run.html_url) ? boundedText(run.html_url) : undefined;
  return {
    id: `github:${run.id}`,
    workflowName: boundedText(run.name ?? "Unnamed workflow"),
    revision: boundedText(run.head_sha),
    ...(run.head_branch ? { branch: boundedText(run.head_branch) } : {}),
    state,
    ...(conclusion ? { conclusion } : {}),
    ...(conclusion === "unknown" && run.conclusion ? { providerConclusion: boundedText(run.conclusion) } : {}),
    ...(run.run_started_at ? { startedAt: run.run_started_at } : { startedAt: run.created_at }),
    updatedAt: run.updated_at,
    ...(webUrl ? { webUrl } : {}),
  };
}

function matchesSelectors(run: z.infer<typeof workflowRunSchema>, options: ListCiRunsOptions): boolean {
  return (!options.branch || run.head_branch === options.branch) && (!options.revision || run.head_sha === options.revision);
}

function normalizeState(status: string): CiRun["state"] | undefined {
  return status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : ["queued", "requested", "waiting", "pending"].includes(status) ? "queued" : undefined;
}

function normalizeConclusion(state: CiRun["state"], value: string | null): Pick<CiJob, "conclusion" | "providerConclusion"> {
  if (state !== "completed") return {};
  const known = new Set(["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required"]);
  return known.has(value ?? "")
    ? { conclusion: value as NonNullable<CiRun["conclusion"]> }
    : { conclusion: "unknown", ...(value ? { providerConclusion: boundedText(value) } : {}) };
}

export class GitHubActionsAdapter {
  private readonly repository: string;
  private readonly apiUrl: URL;

  constructor(private readonly config: GitHubActionsConfig, private readonly fetcher: typeof fetch = fetch, private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS) {
    if (!/^[^/\s]+\/[^/\s]+$/u.test(config.repository)) throw new Error("CI_GITHUB_REPOSITORY must be owner/name");
    this.repository = config.repository;
    const apiUrl = new URL(config.apiUrl ?? "https://api.github.com");
    if (apiUrl.protocol !== "https:" && apiUrl.hostname !== "127.0.0.1" && apiUrl.hostname !== "localhost") {
      throw new Error("CI_GITHUB_API_URL must use HTTPS");
    }
    this.apiUrl = apiUrl;
  }

  async listRuns(options: ListCiRunsOptions = {}, signal?: AbortSignal): Promise<CiRunResult> {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
    const observed: CiRun[] = [];
    let page = 1;

    while (observed.length <= limit) {
      const url = this.apiUrlFor(`repos/${this.repository.split("/").map(encodeURIComponent).join("/")}/actions/runs`);
      url.searchParams.set("per_page", String(Math.min(100, limit + 1)));
      url.searchParams.set("page", String(page));
      if (options.branch) url.searchParams.set("branch", options.branch);
      if (options.revision) url.searchParams.set("head_sha", options.revision);
      const payload = await this.request(url, signal);
      for (const run of payload.workflow_runs) {
        if (run.repository.full_name.toLowerCase() !== this.repository.toLowerCase()) {
          throw new CiProviderError("Provider returned a run for a different repository", "invalid_response");
        }
        if (!matchesSelectors(run, options)) continue;
        observed.push(normalizeRun(run, this.repository));
      }
      if (observed.length > limit || payload.workflow_runs.length < Math.min(100, limit + 1)) break;
      if (page >= MAX_PAGES) throw new CiProviderError("CI provider pagination exceeds the safety limit", "invalid_response");
      page += 1;
    }

    observed.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || a.id.localeCompare(b.id));
    return { runs: observed.slice(0, limit), truncated: observed.length > limit };
  }

  async listJobs(runId: string, limit = 20, signal?: AbortSignal): Promise<CiJobResult> {
    const match = /^github:([1-9]\d*)$/u.exec(runId);
    if (!match) throw new Error("runId must be a provider-qualified GitHub run ID");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
    const providerRunId = match[1] as string;
    const observed: CiJob[] = [];
    let page = 1;
    while (observed.length <= limit) {
      const url = this.apiUrlFor(`repos/${this.repository.split("/").map(encodeURIComponent).join("/")}/actions/runs/${providerRunId}/jobs`);
      url.searchParams.set("filter", "latest");
      url.searchParams.set("per_page", String(Math.min(100, limit + 1)));
      url.searchParams.set("page", String(page));
      const payload = await this.request(url, signal, workflowJobsSchema);
      for (const job of payload.jobs) {
        if (String(job.run_id) !== providerRunId) throw new CiProviderError("Provider returned a job for a different run", "invalid_response");
        const state = normalizeState(job.status);
        if (!state) throw new CiProviderError("Provider returned an unsupported workflow job state", "invalid_response");
        observed.push({
          id: `github:${job.id}`, runId, name: boundedText(job.name), revision: boundedText(job.head_sha), state,
          ...normalizeConclusion(state, job.conclusion), startedAt: job.started_at,
          ...(job.completed_at ? { completedAt: job.completed_at } : {}),
          ...(job.html_url && URL.canParse(job.html_url) ? { webUrl: boundedText(job.html_url) } : {}),
        });
      }
      if (observed.length > limit || payload.jobs.length < Math.min(100, limit + 1)) break;
      if (page >= MAX_PAGES) throw new CiProviderError("CI provider pagination exceeds the safety limit", "invalid_response");
      page += 1;
    }
    return { jobs: observed.slice(0, limit), truncated: observed.length > limit };
  }

  private apiUrlFor(path: string): URL {
    const basePath = this.apiUrl.pathname.endsWith("/") ? this.apiUrl.pathname : `${this.apiUrl.pathname}/`;
    const url = new URL(this.apiUrl);
    url.pathname = `${basePath}${path}`.replace(/\/+/gu, "/");
    url.search = "";
    return url;
  }

  private async request<T extends z.ZodTypeAny>(url: URL, signal: AbortSignal | undefined, schema: T = workflowRunsSchema as unknown as T): Promise<z.infer<T>> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: combinedSignal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "ci-intelligence-mcp/0.1.0",
          ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
        },
      });

      if (!response.ok) {
        const category = response.status === 401 ? "authentication" : response.status === 403 ? "authorization" : response.status === 404 ? "not_found" : response.status === 429 ? "rate_limited" : "transport";
        throw new CiProviderError(`CI provider request failed with status ${response.status}`, category);
      }
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > MAX_RESPONSE_BYTES) throw new CiProviderError("CI provider response exceeds the safety limit", "invalid_response");
      if (!response.body) throw new CiProviderError("CI provider returned an invalid response", "invalid_response");

      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new CiProviderError("CI provider response exceeds the safety limit", "invalid_response");
        }
        chunks.push(value);
      }

      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      } catch (error) {
        if (error instanceof CiProviderError) throw error;
        throw new CiProviderError("CI provider returned an invalid response", "invalid_response");
      }
    } catch (error) {
      if (error instanceof CiProviderError) throw error;
      if (signal?.aborted) throw new CiProviderError("CI request cancelled", "cancelled");
      if (timeout.aborted) throw new CiProviderError("CI request timed out", "timeout");
      throw new CiProviderError("CI provider request failed", "transport");
    }
  }
}
