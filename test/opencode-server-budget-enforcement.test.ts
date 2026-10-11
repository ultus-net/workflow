import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { createOpencodeServerAuthority } from "../src/integrations/opencode-server-authority.js";
import { createOpencodeServerBudget } from "../src/integrations/opencode-server-budget.js";
import { sessionBudgetFromEnv } from "../src/integrations/session-budget.js";
import type { ModelUsageMetrics } from "../src/integrations/model-usage-proxy.js";
import type { RemoteEngine, RemoteEngineEvent } from "../src/integrations/remote-acp/engine.js";

/**
 * C1 F3 — the wired session budget. The plane shipped with
 * `WORKFLOW_SESSION_BUDGET_*` unset, so the budget/downgrade lanes could not be
 * exercised. This pins the whole chain at the composition boundary: env caps →
 * `sessionBudgetFromEnv` (fail closed on malformed) → the server-side watcher →
 * the authority broker (a crossing aborts the in-flight turn and denies every
 * further MUTATION, while a read is still allowed). The malformed-value
 * fail-closed posture is preserved (a broken cap must never degrade to an
 * unenforced session).
 */

const usage = (totalTokens: number): ModelUsageMetrics => ({
  requests: 1, usageEvents: 1, promptTokens: 10, completionTokens: 5, totalTokens, costUsd: 0.001,
  latestPromptTokens: undefined, cacheReadTokens: 0, cacheCreateTokens: 0,
});

function permission(id: string, action: string, metadata: Record<string, unknown>): RemoteEngineEvent {
  return { type: "permission.asked", properties: { id, sessionID: "s1", action, resources: [], metadata } };
}

test("C1 F3: explicit env caps parse; crossing them aborts and denies further mutations while reads pass", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-f3-budget-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const budget = sessionBudgetFromEnv({ WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "1000" });
  assert.deepEqual(budget, { maxTotalTokens: 1000 });

  const aborted: string[] = [];
  const violations: string[] = [];
  let total = 100;
  const watcher = createOpencodeServerBudget({
    budget: budget!,
    usage: () => usage(total),
    abort: async (sessionId) => { aborted.push(sessionId); },
    knownSessions: () => ["s1"],
    onViolation: (reason) => violations.push(reason),
  });
  assert.equal(watcher.check(), undefined, "under the cap is clean");

  // Drive the crossing: the turn aborts once and the violation is sticky.
  total = 5000;
  assert.match(watcher.check() ?? "", /exceeded/);
  assert.deepEqual(aborted, ["s1"]);
  assert.equal(violations.length, 1);
  watcher.stop();

  // Compose the broker against the crossing violation: further MUTATIONS deny,
  // an unrelated READ still passes in the same session.
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    workspace,
  );
  const replies: string[] = [];
  const engine: Pick<RemoteEngine, "events" | "replyPermission"> = {
    async *events() {
      yield permission("r1", "edit", { filePath: join(workspace, "a.ts") });
      yield permission("r2", "grep", {});
    },
    async replyPermission(input) { replies.push(`${input.requestId}:${input.reply}`); },
  };
  const authority = createOpencodeServerAuthority({
    engine,
    application,
    workspace,
    budgetViolation: () => "total tokens 5000 exceeded the session budget cap 1000",
  });
  await authority.start();
  const [mutation, read] = authority.decisions();
  assert.equal(mutation?.decision, "deny");
  assert.match(mutation?.reason ?? "", /session budget violated/);
  assert.equal(read?.decision, "allow", "a read is not a mutation; a crossed budget must not block it");
  assert.deepEqual(replies, ["r1:reject", "r2:once"]);
});

test("C1 F3: a malformed cap fails closed (never a silent unenforced session)", () => {
  assert.throws(() => sessionBudgetFromEnv({ WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "0" }), /positive number/);
  assert.throws(() => sessionBudgetFromEnv({ WORKFLOW_SESSION_BUDGET_COST_USD: "not-a-number" }), /positive number/);
  // Unset stays undefined (the provider-side backstop), never an invented cap.
  assert.equal(sessionBudgetFromEnv({}), undefined);
});
