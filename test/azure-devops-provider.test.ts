import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AZURE_DEVOPS_PAGE_SIZE,
  AZURE_DEVOPS_STATE_COLUMNS,
  azureDevOpsProviderFromEnv,
  fetchAzureDevOpsBoardTasks,
  fetchBoardTasksFromEnv,
  type AzureDevOpsWorkItemPayload,
} from "../src/integrations/azure-devops-provider.js";

// W168 (board issue #320) — the Azure DevOps work-item provider behind the
// ONE ExternalTask record shape (a provider variant, never a fork). Pins
// per the task spec:
//   1. the lane classification is fail-closed like the GitHub lane: absent
//      variables are listed under their NAMES and a malformed declaration
//      is named invalid, never silently coerced;
//   2. BOTH lanes fully configured is an explicit ambiguity error — the hub
//      never silently picks a provider;
//   3. the state→column mapping is the PINNED table over the standard
//      Agile/Scrum/Basic states; an unknown state is skipped + counted,
//      never guessed onto a column;
//   4. malformed rows are skipped + counted per row — never a mid-mapping
//      throw — and the record's url must be the item's https html href;
//   5. the PAT VALUE appears in no returned payload, record, or error text
//      (searched by VALUE, the W161 token-leak pin pattern).

const ADO_TOKEN = "ado-pat-sup3r-secret-4b7d";

const ADO_ENV = {
  WORKFLOW_AZURE_DEVOPS_ORG: "my-org",
  WORKFLOW_AZURE_DEVOPS_PROJECT: "My Project",
  WORKFLOW_AZURE_DEVOPS_TOKEN: ADO_TOKEN,
};

const workItem = (
  id: number,
  overrides: { readonly fields?: Record<string, unknown>; readonly href?: string } = {},
): AzureDevOpsWorkItemPayload =>
  ({
    id,
    fields: {
      "System.Title": `Work item ${id}`,
      "System.State": "New",
      "System.Tags": "",
      "System.AssignedTo": null,
      "System.ChangedDate": "2026-09-27T10:00:00Z",
      ...overrides.fields,
    },
    _links: { html: { href: overrides.href ?? `https://dev.azure.com/my-org/My%20Project/_workitems/edit/${id}` } },
  }) as AzureDevOpsWorkItemPayload;

type RecordedCall = {
  url: string;
  headers: Record<string, string>;
  method?: string | undefined;
  body?: unknown | undefined;
  signal?: unknown | undefined;
};

const stubFetch = (status: number, body: string) => {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key] = value;
    calls.push({ url: String(input), headers, method: init?.method, body: init?.body, signal: init?.signal });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
};

const routeFetch = (wiqlBody: string, batchBody: string, statuses: { readonly wiql?: number; readonly batch?: number } = {}) => {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key] = value;
    const url = String(input);
    const isWiql = url.includes("/_apis/wit/wiql");
    calls.push({
      url,
      headers,
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      signal: init?.signal,
    });
    return new Response(isWiql ? wiqlBody : batchBody, {
      status: isWiql ? statuses.wiql ?? 200 : statuses.batch ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
};

test("W168: the Azure DevOps lane classification fails closed — absent or malformed env names the variable, mirroring the GitHub lane", () => {
  const unconfigured = azureDevOpsProviderFromEnv({});
  assert.equal(unconfigured.kind, "unconfigured");
  assert.deepEqual(unconfigured.kind === "unconfigured" ? unconfigured.missing : [], [
    "WORKFLOW_AZURE_DEVOPS_ORG",
    "WORKFLOW_AZURE_DEVOPS_PROJECT",
    "WORKFLOW_AZURE_DEVOPS_TOKEN",
  ]);
  const half = azureDevOpsProviderFromEnv({ WORKFLOW_AZURE_DEVOPS_ORG: "my-org" });
  assert.equal(half.kind, "unconfigured");
  assert.deepEqual(half.kind === "unconfigured" ? half.missing : [], [
    "WORKFLOW_AZURE_DEVOPS_PROJECT",
    "WORKFLOW_AZURE_DEVOPS_TOKEN",
  ]);
  const blank = azureDevOpsProviderFromEnv({ WORKFLOW_AZURE_DEVOPS_ORG: "   " });
  assert.equal(blank.kind, "unconfigured");
  assert.deepEqual(blank.kind === "unconfigured" ? blank.missing : [], [
    "WORKFLOW_AZURE_DEVOPS_ORG",
    "WORKFLOW_AZURE_DEVOPS_PROJECT",
    "WORKFLOW_AZURE_DEVOPS_TOKEN",
  ]);
  // A "/" inside an org or project would forge an API path segment: named
  // invalid, never silently coerced into a different URL shape.
  const malformedOrg = azureDevOpsProviderFromEnv({ ...ADO_ENV, WORKFLOW_AZURE_DEVOPS_ORG: "my/org" });
  assert.equal(malformedOrg.kind, "unconfigured");
  assert.match(malformedOrg.kind === "unconfigured" ? malformedOrg.missing.join(";") : "", /WORKFLOW_AZURE_DEVOPS_ORG.*invalid/);
  const malformedProject = azureDevOpsProviderFromEnv({ ...ADO_ENV, WORKFLOW_AZURE_DEVOPS_PROJECT: "../other" });
  assert.equal(malformedProject.kind, "unconfigured");
  assert.match(malformedProject.kind === "unconfigured" ? malformedProject.missing.join(";") : "", /WORKFLOW_AZURE_DEVOPS_PROJECT.*invalid/);
  const configured = azureDevOpsProviderFromEnv(ADO_ENV);
  assert.equal(configured.kind, "azure_devops");
  assert.deepEqual(configured.kind === "azure_devops" ? { org: configured.org, project: configured.project } : {}, {
    org: "my-org",
    project: "My Project",
  });
});

test("W168: the state→column table is the pinned one over the standard Agile/Scrum/Basic states", () => {
  assert.deepEqual(
    [...AZURE_DEVOPS_STATE_COLUMNS.entries()].sort(),
    [
      ["Active", "open"],
      ["Closed", "closed"],
      ["Committed", "open"],
      ["Doing", "open"],
      ["Done", "closed"],
      ["New", "open"],
      ["Proposed", "open"],
      ["Removed", "closed"],
      ["Resolved", "closed"],
      ["To Do", "open"],
    ],
  );
});

test("W168: the ADO read maps well-formed work items through the pinned table and the credential never crosses the outcome", async () => {
  const { impl, calls } = routeFetch(
    JSON.stringify({ workItems: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }] }),
    JSON.stringify({
      count: 6,
      value: [
        workItem(1, { fields: { "System.State": "Active", "System.Tags": "backend; ui", "System.AssignedTo": { displayName: "hunter" } } }),
        workItem(2, { fields: { "System.State": "Done" } }),
        workItem(3, { fields: { "System.State": "Doing" } }),
        workItem(4, { fields: { "System.State": "Resolved" } }),
        // A wrong-typed AssignedTo degrades to NO assignee — the row still
        // maps (the interface contract's honest absent case, like GitHub's).
        workItem(5, { fields: { "System.AssignedTo": "not-an-object" } }),
        workItem(6, { fields: { "System.AssignedTo": { displayName: "" } } }),
      ],
    }),
  );
  const provider = azureDevOpsProviderFromEnv(ADO_ENV);
  assert.equal(provider.kind, "azure_devops");
  const outcome = await fetchAzureDevOpsBoardTasks(provider, impl);
  assert.equal(outcome.state, "ok");
  if (outcome.state !== "ok") return;
  // The PAT VALUE never rides the mapped outcome — searched by VALUE (the
  // W161 pattern); the Basic encoding is searched too.
  const rendered = JSON.stringify(outcome);
  assert.ok(!rendered.includes(ADO_TOKEN));
  assert.ok(!rendered.includes(Buffer.from(`:${ADO_TOKEN}`, "utf8").toString("base64")));
  assert.equal(outcome.board.provider, "azure_devops");
  assert.equal(outcome.board.repo, "my-org/My Project");
  assert.equal(outcome.board.pullRequestsExcluded, 0);
  assert.equal(outcome.board.skipped, 0);
  assert.equal(outcome.board.tasks.length, 6);
  assert.deepEqual(outcome.board.tasks.map((task) => task.key), ["#1", "#2", "#3", "#4", "#5", "#6"]);
  assert.deepEqual(outcome.board.tasks.map((task) => task.state), ["open", "closed", "open", "closed", "open", "open"]);
  assert.deepEqual(outcome.board.tasks[0]?.labels, ["backend", "ui"]);
  assert.equal(outcome.board.tasks[0]?.assignee, "hunter");
  assert.equal(outcome.board.tasks[1]?.assignee, undefined);
  assert.deepEqual(outcome.board.tasks[1]?.labels, []);
  assert.equal(outcome.board.tasks[4]?.assignee, undefined);
  assert.equal(outcome.board.tasks[5]?.assignee, undefined);
  assert.equal(outcome.board.tasks[0]?.updatedAt, "2026-09-27T10:00:00Z");
  assert.equal(outcome.board.tasks[0]?.url, "https://dev.azure.com/my-org/My%20Project/_workitems/edit/1");
  // The wire: two bounded, explicitly addressed calls; the PAT rides the
  // Authorization header ONLY, and both calls carry an abort signal.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://dev.azure.com/my-org/My%20Project/_apis/wit/wiql?api-version=7.1&$top=100");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers.authorization, `Basic ${Buffer.from(`:${ADO_TOKEN}`, "utf8").toString("base64")}`);
  assert.equal(calls[1]?.url, "https://dev.azure.com/my-org/My%20Project/_apis/wit/workitemsbatch?api-version=7.1");
  assert.deepEqual(calls[1]?.body, {
    ids: [1, 2, 3, 4, 5, 6],
    fields: ["System.Title", "System.State", "System.Tags", "System.AssignedTo", "System.ChangedDate"],
  });
  assert.ok(calls[0]?.signal instanceof AbortSignal);
  assert.ok(calls[1]?.signal instanceof AbortSignal);
});

test("W168: malformed ADO rows are skipped + counted per row — never a mid-mapping throw, never a guessed record", async () => {
  const good = workItem(7);
  const rows: unknown[] = [
    "not an object", // non-object row
    { fields: good.fields, _links: good._links }, // no id
    { id: "seven", fields: good.fields, _links: good._links }, // wrong-typed id
    { id: 0, fields: good.fields, _links: good._links }, // non-positive id
    { id: 11, fields: "nope" }, // wrong-typed fields
    { id: 12 }, // absent fields
    workItem(1, { fields: { "System.Title": "" } }), // empty title
    workItem(2, { fields: { "System.Title": 7 } }), // wrong-typed title
    workItem(3, { fields: { "System.State": "On Hold" } }), // UNKNOWN state — skipped, never guessed
    workItem(4, { fields: { "System.Tags": 7 } }), // wrong-typed tags FIELD: the row is malformed
    workItem(5, { fields: { "System.ChangedDate": undefined } }), // absent changed date
    { id: 6, fields: good.fields }, // no _links envelope
    { id: 10, fields: good.fields, _links: "not-an-envelope" }, // wrong-typed _links
    workItem(13, { href: "http://dev.azure.com/my-org/_workitems/edit/13" }), // non-https href
    workItem(14, { href: "javascript:alert(1)" }), // scheme forgery
    good,
  ];
  const { impl } = routeFetch(
    JSON.stringify({ workItems: [{ id: 7 }] }),
    JSON.stringify({ count: rows.length, value: rows }),
  );
  const provider = azureDevOpsProviderFromEnv(ADO_ENV);
  const outcome = await fetchAzureDevOpsBoardTasks(provider, impl);
  assert.equal(outcome.state, "ok");
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(outcome.board.skipped, 15);
  assert.deepEqual(outcome.board.tasks.map((task) => task.key), ["#7"]);
});

test("W168: a full WIQL page is flagged truncated — the flag keys on the received listing count, not the filtered render count", async () => {
  const listing = Array.from({ length: AZURE_DEVOPS_PAGE_SIZE }, (_, index) => ({ id: index + 1 }));
  const value = [
    ...Array.from({ length: AZURE_DEVOPS_PAGE_SIZE - 10 }, (_, index) => workItem(index + 1)),
    ...Array.from({ length: 10 }, (_, index) => ({ id: `bad-${index}`, fields: {} })),
  ];
  const { impl } = routeFetch(
    JSON.stringify({ workItems: listing }),
    JSON.stringify({ count: AZURE_DEVOPS_PAGE_SIZE, value }),
  );
  const provider = azureDevOpsProviderFromEnv(ADO_ENV);
  const outcome = await fetchAzureDevOpsBoardTasks(provider, impl);
  assert.equal(outcome.state, "ok");
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(outcome.board.truncated, true);
  assert.equal(outcome.board.skipped, 10);
  assert.equal(outcome.board.tasks.length, AZURE_DEVOPS_PAGE_SIZE - 10);
});

test("W168: an empty WIQL listing answers an honest empty board without a second fetch", async () => {
  const { impl, calls } = routeFetch(JSON.stringify({ workItems: [] }), JSON.stringify({ count: 0, value: [] }));
  const provider = azureDevOpsProviderFromEnv(ADO_ENV);
  const outcome = await fetchAzureDevOpsBoardTasks(provider, impl);
  assert.equal(outcome.state, "ok");
  if (outcome.state !== "ok") return assert.fail("expected ok");
  assert.deepEqual(outcome.board.tasks, []);
  assert.equal(outcome.board.skipped, 0);
  assert.equal(outcome.board.provider, "azure_devops");
  assert.equal(outcome.board.repo, "my-org/My Project");
  assert.equal(outcome.board.truncated, undefined);
  assert.equal(calls.length, 1);
});

test("W168: provider faults stay honest errors — a rejected credential and a transport failure never become an empty board", async () => {
  const provider = azureDevOpsProviderFromEnv(ADO_ENV);
  const rejected = await fetchAzureDevOpsBoardTasks(provider, stubFetch(401, JSON.stringify({ message: "Azure DevOps PAT authorization required" })).impl);
  assert.equal(rejected.state, "error");
  assert.match(rejected.state === "error" ? rejected.reason : "", /401/);
  // The PAT VALUE never rides an error reason either — searched by VALUE.
  assert.ok(!JSON.stringify(rejected).includes(ADO_TOKEN));
  const failing = (async (): Promise<Response> => {
    throw new Error("connection refused");
  }) as typeof fetch;
  const unreachable = await fetchAzureDevOpsBoardTasks(provider, failing);
  assert.equal(unreachable.state, "error");
  assert.match(unreachable.state === "error" ? unreachable.reason : "", /connection refused/);
});

test("W168: a malformed provider body is an honest error — non-JSON, a missing WIQL listing, and a non-batch envelope never fabricate a board", async () => {
  const provider = azureDevOpsProviderFromEnv(ADO_ENV);
  const notJson = await fetchAzureDevOpsBoardTasks(provider, stubFetch(200, "<html>not json</html>").impl);
  assert.equal(notJson.state, "error");
  assert.match(notJson.state === "error" ? notJson.reason : "", /not JSON/);
  const noListing = await fetchAzureDevOpsBoardTasks(provider, stubFetch(200, JSON.stringify({ count: 0 })).impl);
  assert.equal(noListing.state, "error");
  assert.match(noListing.state === "error" ? noListing.reason : "", /WIQL/);
  const brokenListing = await fetchAzureDevOpsBoardTasks(
    provider,
    routeFetch(JSON.stringify({ workItems: [{ id: 1 }, { nope: true }] }), "{}").impl,
  );
  assert.equal(brokenListing.state, "error");
  assert.match(brokenListing.state === "error" ? brokenListing.reason : "", /listing was malformed/);
  const batchRejected = await fetchAzureDevOpsBoardTasks(
    provider,
    routeFetch(JSON.stringify({ workItems: [{ id: 1 }] }), "{}", { batch: 500 }).impl,
  );
  assert.equal(batchRejected.state, "error");
  assert.match(batchRejected.state === "error" ? batchRejected.reason : "", /500/);
  const batchNotJson = await fetchAzureDevOpsBoardTasks(
    provider,
    routeFetch(JSON.stringify({ workItems: [{ id: 1 }] }), "<html>not json</html>").impl,
  );
  assert.equal(batchNotJson.state, "error");
  assert.match(batchNotJson.state === "error" ? batchNotJson.reason : "", /not JSON/);
  const noEnvelope = await fetchAzureDevOpsBoardTasks(
    provider,
    routeFetch(JSON.stringify({ workItems: [{ id: 1 }] }), JSON.stringify({ count: 1 })).impl,
  );
  assert.equal(noEnvelope.state, "error");
  assert.match(noEnvelope.state === "error" ? noEnvelope.reason : "", /work item list/);
});

test("W168: both lanes fully configured is an honest ambiguity error — the hub never silently picks one", async () => {
  const { impl, calls } = routeFetch(JSON.stringify({ workItems: [] }), "[]");
  const outcome = await fetchBoardTasksFromEnv(
    {
      WORKFLOW_GITHUB_REPO: "o/r",
      WORKFLOW_GITHUB_TOKEN: "t",
      ...ADO_ENV,
    },
    impl,
  );
  assert.equal(outcome.state, "error");
  assert.match(outcome.state === "error" ? outcome.reason : "", /both providers are fully configured/);
  assert.match(outcome.state === "error" ? outcome.reason : "", /WORKFLOW_AZURE_DEVOPS_ORG/);
  // Never a silent pick: not a single provider call was made, and the
  // reason carries no secret material (searched by VALUE).
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify(outcome).includes(ADO_TOKEN));
});

test("W168: the env dispatcher routes each configured lane to its own provider read and merges missing names when neither is configured", async () => {
  // GitHub lane only → api.github.com.
  const githubStub = routeFetch("[]", "[]");
  const githubOutcome = await fetchBoardTasksFromEnv({ WORKFLOW_GITHUB_REPO: "o/r", WORKFLOW_GITHUB_TOKEN: "t" }, githubStub.impl);
  assert.equal(githubOutcome.state, "ok");
  if (githubOutcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(githubOutcome.board.provider, "github");
  assert.match(githubStub.calls[0]?.url ?? "", /^https:\/\/api\.github\.com\//);

  // Azure DevOps lane only → dev.azure.com.
  const adoStub = routeFetch(JSON.stringify({ workItems: [] }), "[]");
  const adoOutcome = await fetchBoardTasksFromEnv(ADO_ENV, adoStub.impl);
  assert.equal(adoOutcome.state, "ok");
  if (adoOutcome.state !== "ok") return assert.fail("expected ok");
  assert.equal(adoOutcome.board.provider, "azure_devops");
  assert.match(adoStub.calls[0]?.url ?? "", /^https:\/\/dev\.azure\.com\//);

  // Neither lane configured → unconfigured listing EVERY missing name.
  const neither = await fetchBoardTasksFromEnv({}, routeFetch("[]", "[]").impl);
  assert.equal(neither.state, "unconfigured");
  assert.deepEqual(neither.state === "unconfigured" ? neither.missing : [], [
    "WORKFLOW_GITHUB_REPO",
    "WORKFLOW_GITHUB_TOKEN",
    "WORKFLOW_AZURE_DEVOPS_ORG",
    "WORKFLOW_AZURE_DEVOPS_PROJECT",
    "WORKFLOW_AZURE_DEVOPS_TOKEN",
  ]);
});
