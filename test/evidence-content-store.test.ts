import assert from "node:assert/strict";
import test from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { createEvidenceContentStore } from "../src/integrations/evidence-content-store.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";

// W158: the bounded evidence-content store — the kernel record carries only
// the reference; the bytes live here, bounded like the web image store.

test("W158: put stores bounded content and get resolves it by ref", () => {
  const store = createEvidenceContentStore();
  const stored = store.put("test-output", "text/plain", "3 passing\n0 failing");
  assert.ok(stored !== undefined);
  assert.match(stored.ref, /^content:[0-9a-f]{8}:\d+$/, "the ref carries the store's per-instance nonce (a persisted record against a fresh store misses honestly, never cross-matches)");
  assert.equal(stored.kind, "test-output");
  assert.equal(stored.byteSize, Buffer.byteLength("3 passing\n0 failing", "utf8"));
  const fetched = store.get(stored.ref);
  assert.equal(fetched?.bytes, "3 passing\n0 failing");
  assert.equal(fetched?.mediaType, "text/plain");
  assert.equal(store.get("content:9999"), undefined, "an unknown ref is an honest miss");
});

test("W158: an over-cap payload is refused — honest absence, never a truncated or fabricated reference", () => {
  const store = createEvidenceContentStore({ maxBytes: 16 });
  assert.ok(store.put("test-output", "text/plain", "exactly 16 bytes") !== undefined, "at the cap fits");
  assert.equal(store.put("test-output", "text/plain", "this payload is longer than sixteen bytes"), undefined, "over the cap is refused");
  assert.equal(store.size(), 1);
});

test("W158: eviction is oldest-first and bounded — a snapshot of a long hub's store stays small", () => {
  const store = createEvidenceContentStore({ maxEntries: 3 });
  const refs: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const stored = store.put("test-output", "text/plain", `run ${index}`);
    assert.ok(stored !== undefined);
    refs.push(stored.ref);
  }
  assert.equal(store.size(), 3, "the store stays bounded");
  assert.equal(store.get(refs[0]!), undefined, "the oldest entry is evicted");
  assert.equal(store.get(refs[1]!), undefined);
  assert.equal(store.get(refs[4]!)?.bytes, "run 4", "the newest entries survive");
});

// ── The registry capture: the PASSED test output is bounded content ON the
// very evidence record the verification consumed — one record, not a parallel
// copy; the bytes live in this store, the kernel record carries only the
// reference, and an over-cap payload is honest absence.

const captureRegistry = (store: ReturnType<typeof createEvidenceContentStore>, output: string) => {
  const tasks: WorkflowTask[] = [{ id: taskId("seed"), title: "Seed", state: "READY", dependencies: [], requiredEvidence: [] }];
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const application = new WorkflowApplication(graph, hostCapabilities({ transport: "native", authoritativePreMutation: true }), [], new Set(["read", "mutation", "process"]), process.cwd());
  const registry = createRunRegistry(application, graph, {
    reviewer: (controller) => async (input) => {
      await controller.begin({ runId: "schedule:hub-reviewer-cap", title: "Hub reviewer run", workspace: process.cwd() });
      await controller.review({ runId: input.runId, reviewerRunId: "schedule:hub-reviewer-cap", verdict: "approved", summary: "TEST INTEGRITY: pass. TASK COMPLETENESS: pass. CLEANLINESS: pass. SECURITY: pass. PLATFORM: pass." });
      return { reviewerRunId: "schedule:hub-reviewer-cap", verdict: "approved", recorded: true, summary: "TEST INTEGRITY: pass. TASK COMPLETENESS: pass. CLEANLINESS: pass. SECURITY: pass. PLATFORM: pass." };
    },
    testRunner: async () => ({ passed: true, output }),
    contentStore: store,
  });
  return { registry, graph, application };
};

test("W158: the passed test output is captured as bounded content on the same evidence record the verification consumed", async () => {
  const store = createEvidenceContentStore();
  const { registry, graph } = captureRegistry(store, "suite: 12 pass, 0 fail");
  await registry.controller.begin({ runId: "author-cap", title: "Author run", workspace: process.cwd(), requiresReview: true });
  await registry.controller.finish({ runId: "author-cap", outcome: "verified" });

  const withContent = graph.evidence().find((entry) => entry.content !== undefined);
  assert.ok(withContent !== undefined, "the test evidence record carries a content reference");
  assert.equal(withContent.content?.kind, "test-output");
  assert.equal(withContent.authority, "environment", "it is the run's own test evidence, not a parallel record");
  const fetched = store.get(withContent.content?.ref ?? "");
  assert.equal(fetched?.bytes, "suite: 12 pass, 0 fail", "the store serves exactly the output the verification consumed");
});

test("W158: an over-cap capture is honest absence — the evidence record stays plain, no fabricated reference", async () => {
  const tinyStore = createEvidenceContentStore({ maxBytes: 4 });
  const { registry, graph } = captureRegistry(tinyStore, "suite: 12 pass, 0 fail — much longer than four bytes");
  await registry.controller.begin({ runId: "author-cap2", title: "Author run", workspace: process.cwd(), requiresReview: true });
  await registry.controller.finish({ runId: "author-cap2", outcome: "verified" });

  const evidence = graph.evidence().filter((entry) => entry.authority === "environment");
  assert.equal(evidence.some((entry) => entry.content !== undefined), false, "no content reference was fabricated");
  assert.equal(evidence.length >= 1, true, "the test evidence itself still verified the run — plain record, honest absence");
});
