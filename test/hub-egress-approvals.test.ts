import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import { createEgressPolicyRevisionStore } from "../src/integrations/egress-policy-revisions.js";
import { createModelUsageProxy, METERED_PLACEHOLDER_KEY, type EgressDenialEvent } from "../src/integrations/model-usage-proxy.js";

/**
 * W182 (A7): the hub-scoped operator approval surface on egress deny. A proxy
 * denial parks a redacted pending rule through the SHARED denial sink; the hub
 * exposes it on /egress/pending and merges a durable revision on
 * /egress/answer. Ordinary-token gated, like the sibling hub routes.
 */

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] }];

function setup() {
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const workspace = mkdtempSync(join(tmpdir(), "wf-egress-hub-ws-"));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    workspace,
  );
  return { graph, application, workspace };
}

async function post(url: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("W182: a proxy denial parks on the hub and an approval merges a durable revision on /egress/answer", async (t) => {
  const { graph, application, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-hub-"));
  const revisionsPath = join(dir, "egress-revisions.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const egressApprovals = createEgressPolicyRevisionStore({
    path: revisionsPath,
    baseline: { version: 0, rules: [] },
    generation: "gen-1",
    fingerprint: () => ({ policyVersion: 0, providerFingerprint: "static" }),
  });
  // The exact wiring the hub CLI composes: the proxy's shared denial sink
  // parks an approvable rule on the store.
  const sink = (event: EgressDenialEvent) =>
    egressApprovals.recordDenial({
      policy: event.policy,
      reason: event.reason,
      host: event.host,
      pathname: event.pathname,
      ...(event.port === undefined ? {} : { port: event.port }),
      ...(event.method === undefined ? {} : { method: event.method }),
    });

  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph, egressApprovals });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));

  // A proxy denial through the shared sink parks a redacted pending rule.
  const denied = sink({ policy: "egress_policy", reason: "no_matching_rule", host: "api.example.com", port: 443, method: "POST", pathname: "/v1/chat?secret=QUERY_SECRET_VALUE" });
  assert.equal(denied.parked, true);

  const pending = await post(hub.url, token, "/egress/pending", {});
  assert.equal(pending.status, 200);
  assert.equal(pending.body.generation, "gen-1");
  const parked = pending.body.pending as Array<{ requestId: string; proposal: { pathname: string } }>;
  assert.equal(parked.length, 1);
  assert.equal(parked[0]?.proposal.pathname, "/v1/chat", "the parked payload strips the query string");
  assert.equal(JSON.stringify(pending.body).includes("QUERY_SECRET_VALUE"), false);

  const answered = await post(hub.url, token, "/egress/answer", { requestId: parked[0]!.requestId, decision: "allow" });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.status, "merged");
  assert.equal(typeof answered.body.revision, "number");

  const after = await post(hub.url, token, "/egress/pending", {});
  assert.equal((after.body.pending as unknown[]).length, 0);
  assert.equal((after.body.revisions as unknown[]).length, 1, "the merged revision is durable");
  assert.equal(JSON.parse(readFileSync(revisionsPath, "utf8")).generation, "gen-1");
});

test("W182: /egress routes require the bearer token and reject malformed or unknown answers", async (t) => {
  const { graph, application, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-hub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const egressApprovals = createEgressPolicyRevisionStore({
    path: join(dir, "egress-revisions.json"),
    baseline: { version: 0, rules: [] },
    generation: "gen-1",
    fingerprint: () => ({ policyVersion: 0, providerFingerprint: "static" }),
  });
  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph, egressApprovals });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));

  const noToken = await fetch(`${hub.url}/egress/pending`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noToken.status, 401, "every hub route requires the bearer token");
  const noTokenAnswer = await fetch(`${hub.url}/egress/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noTokenAnswer.status, 401);

  const malformed = await post(hub.url, token, "/egress/answer", { requestId: "", decision: "allow" });
  assert.equal(malformed.status, 400);
  const badDecision = await post(hub.url, token, "/egress/answer", { requestId: "egress-1", decision: "maybe" });
  assert.equal(badDecision.status, 400);
  const unknown = await post(hub.url, token, "/egress/answer", { requestId: "egress-unknown", decision: "allow" });
  assert.equal(unknown.status, 404, "an unknown or stale id is never a successful answer");
});

test("W182: the /egress routes 404 when the hub composes no approval store (fail closed)", async (t) => {
  const { graph, application, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-hub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));

  assert.equal((await post(hub.url, token, "/egress/pending", {})).status, 404);
  assert.equal((await post(hub.url, token, "/egress/answer", { requestId: "x", decision: "allow" })).status, 404);
});

test("W182: the shared denial sink fires from a real proxy and reaches the hub store", async (t) => {
  const { graph, application, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-hub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const egressApprovals = createEgressPolicyRevisionStore({
    path: join(dir, "egress-revisions.json"),
    baseline: { version: 0, rules: [] },
    generation: "gen-1",
    fingerprint: () => ({ policyVersion: 0, providerFingerprint: "static" }),
  });
  const sink = (event: EgressDenialEvent) =>
    egressApprovals.recordDenial({
      policy: event.policy,
      reason: event.reason,
      host: event.host,
      pathname: event.pathname,
      ...(event.port === undefined ? {} : { port: event.port }),
      ...(event.method === undefined ? {} : { method: event.method }),
    });
  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph, egressApprovals });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));

  // A real proxy with the shared sink wired (a foreign credential refusal).
  const proxy = await createModelUsageProxy({ upstream: "http://127.0.0.1:9", apiKey: "REAL_KEY", onEgressDenied: sink });
  t.after(() => proxy.close());
  t.after(() => egressApprovals.cancelAll());
  const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY.replace("metered", "foreign")}` },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(response.status, 403);

  const pending = await post(hub.url, token, "/egress/pending", {});
  // A foreign credential is credential custody: it is observed and parked for
  // visibility, but its `approvable` flag is false and an allow never merges.
  const parkedRows = pending.body.pending as Array<{ requestId: string; approvable: boolean }>;
  assert.equal(parkedRows.length, 1, "the custody refusal is visible to the operator");
  assert.equal(parkedRows[0]?.approvable, false, "a custody refusal is never approvable by an egress rule");
  const refused = await post(hub.url, token, "/egress/answer", { requestId: parkedRows[0]!.requestId, decision: "allow" });
  assert.equal(refused.status, 409, "a custody refusal answers the structured not-approvable refusal");
  assert.equal(refused.body.status, "not-approvable");
  const after = await post(hub.url, token, "/egress/pending", {});
  assert.equal((after.body.revisions as unknown[]).length, 0, "nothing merged");
});
