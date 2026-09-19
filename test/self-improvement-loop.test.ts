import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";
import {
  createAuthorityGate,
  createExecFileRunner,
  createGitCandidateWorkspace,
  createSelfImprovementLoop,
  type ImprovementProposal,
  type LoopObjective,
  type LoopOutcome,
  type ProposalSource,
  type SelfImprovementLoopOptions,
} from "../src/integrations/self-improvement-loop.js";

/**
 * W073 — bounded recursive self-improvement loop. Hermetic unit coverage over
 * fake seams (bounds, fail-closed paths, audit), an end-to-end composition
 * through the real `createRunRegistry` (evidence-bound acceptance), and real
 * git coverage for the candidate workspace.
 */

const AXES_SUMMARY = "test integrity: real assertions. task completeness: done. cleanliness: no dead code.";

const p = (id: string, hypothesis = `hypothesis ${id}`): ImprovementProposal => ({ id, hypothesis });

// ── Fake seams ─────────────────────────────────────────────────────────────

class FakeAuthority {
  readonly begins: { runId: string; workspace: string; requiresReview: boolean; taskPrompt?: string }[] = [];
  readonly finishes: { runId: string; outcome: string }[] = [];
  beginThrows = false;
  failVerified = false;
  failFailedClose = false;

  async begin(input: { runId: string; workspace: string; requiresReview: boolean; taskPrompt?: string }): Promise<void> {
    if (this.beginThrows) throw new Error("authority unavailable");
    this.begins.push(input);
  }

  async finish(input: { runId: string; outcome: "verified" | "failed" }): Promise<void> {
    this.finishes.push(input);
    if (input.outcome === "verified" && this.failVerified) throw new Error("verification gate refused: tests failed");
    if (input.outcome === "failed" && this.failFailedClose) throw new Error("run close exploded");
  }
}

class FakeWorkspace {
  readonly applies: string[] = [];
  readonly commits: string[] = [];
  readonly discards: string[] = [];
  failApply = false;
  discardThrows = false;
  baselineThrows = false;
  commitBehavior: "ok" | "throw" | "not-committed" = "ok";

  async assertBaseline(): Promise<void> {
    if (this.baselineThrows) throw new Error("dirty tree");
  }

  async apply(input: { proposal: ImprovementProposal }): Promise<{ changed: boolean }> {
    this.applies.push(input.proposal.id);
    if (this.failApply) throw new Error("apply exploded");
    return { changed: true };
  }

  async commit(input: { runId: string }): Promise<{ committed: boolean; ref?: string }> {
    this.commits.push(input.runId);
    if (this.commitBehavior === "throw") throw new Error("git commit exploded");
    if (this.commitBehavior === "not-committed") return { committed: false };
    return { committed: true, ref: `ref-${input.runId}` };
  }

  async discard(input: { runId: string }): Promise<void> {
    this.discards.push(input.runId);
    if (this.discardThrows) throw new Error("git clean exploded");
  }
}

function sourceOf(items: readonly (ImprovementProposal | undefined)[]): ProposalSource {
  let cursor = 0;
  return {
    async next() {
      const item = cursor < items.length ? items[cursor] : undefined;
      cursor += 1;
      return item;
    },
  };
}

interface HarnessInput {
  readonly items: readonly (ImprovementProposal | undefined)[];
  readonly measure?: LoopObjective["measure"];
  readonly direction?: "higher" | "lower";
  readonly baselineScore?: number;
  readonly maxIterations?: number;
  readonly maxConsecutiveRejections?: number;
  readonly budgetUsd?: number;
  readonly usageUsd?: () => number;
  readonly failApply?: boolean;
  readonly failVerified?: boolean;
  readonly failFailedClose?: boolean;
  readonly discardThrows?: boolean;
  readonly baselineThrows?: boolean;
  readonly commitBehavior?: "ok" | "throw" | "not-committed";
}

function harness(input: HarnessInput): {
  authority: FakeAuthority;
  workspace: FakeWorkspace;
  run: () => Promise<LoopOutcome>;
} {
  const authority = new FakeAuthority();
  const workspace = new FakeWorkspace();
  if (input.failApply === true) workspace.failApply = true;
  if (input.failVerified === true) authority.failVerified = true;
  if (input.failFailedClose === true) authority.failFailedClose = true;
  if (input.discardThrows === true) workspace.discardThrows = true;
  if (input.baselineThrows === true) workspace.baselineThrows = true;
  if (input.commitBehavior !== undefined) workspace.commitBehavior = input.commitBehavior;
  const options: SelfImprovementLoopOptions = {
    objective: {
      description: "make the suite pass with fewer flaky tests",
      workspace: "/tmp/wf-rsi-objective",
      requiresReview: false,
      ...(input.measure === undefined ? {} : { measure: input.measure }),
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      ...(input.baselineScore === undefined ? {} : { baselineScore: input.baselineScore }),
    },
    proposals: sourceOf(input.items),
    workspace,
    authority,
    limits: {
      maxIterations: input.maxIterations ?? 5,
      ...(input.maxConsecutiveRejections === undefined ? {} : { maxConsecutiveRejections: input.maxConsecutiveRejections }),
      ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd, ...(input.usageUsd === undefined ? {} : { usageUsd: input.usageUsd }) }),
    },
  };
  const loop = createSelfImprovementLoop(options);
  return { authority, workspace, run: loop.run };
}

// ── Bounds and validation ──────────────────────────────────────────────────

test("invalid objectives and limits throw before any proposal is requested", () => {
  const seams = {
    proposals: sourceOf([]),
    workspace: new FakeWorkspace(),
    authority: new FakeAuthority(),
  };
  const base: SelfImprovementLoopOptions = {
    objective: { description: "improve", workspace: "/tmp/wf-rsi-objective", requiresReview: false },
    ...seams,
    limits: { maxIterations: 1 },
  };
  assert.throws(
    () => createSelfImprovementLoop({ ...base, objective: { ...base.objective, description: "  " } }),
    /description must be non-empty/,
  );
  assert.throws(
    () => createSelfImprovementLoop({ ...base, objective: { ...base.objective, workspace: "relative/path" } }),
    /workspace must be absolute/,
  );
  assert.throws(() => createSelfImprovementLoop({ ...base, limits: { maxIterations: 0 } }), /maxIterations/);
  assert.throws(
    () => createSelfImprovementLoop({ ...base, limits: { maxIterations: 1, budgetUsd: 1 } }),
    /usageUsd/,
  );
  assert.equal(seams.proposals === undefined, false, "objective validation happens at composition time");
});

test("a second concurrent loop for the same workspace is refused", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const workspacePath = "/tmp/wf-rsi-concurrent";
  const authority = new FakeAuthority();
  const first = createSelfImprovementLoop({
    objective: { description: "improve", workspace: workspacePath, requiresReview: false },
    proposals: { next: async () => {
      await gate;
      return undefined;
    } },
    workspace: new FakeWorkspace(),
    authority,
    limits: { maxIterations: 3 },
  });
  const inFlight = first.run();
  assert.rejects(
    () => createSelfImprovementLoop({
      objective: { description: "improve", workspace: workspacePath, requiresReview: false },
      proposals: sourceOf([]),
      workspace: new FakeWorkspace(),
      authority: new FakeAuthority(),
      limits: { maxIterations: 1 },
    }).run(),
    /already running for workspace/,
  );
  release?.();
  const outcome = await inFlight;
  assert.equal(outcome.status, "completed");
});

test("the single-instance lock releases the realpath key it acquired (path aliases do not leak it)", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "wf-rsi-lock-base-"));
  const aliasHolder = mkdtempSync(join(tmpdir(), "wf-rsi-lock-alias-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  t.after(() => rmSync(aliasHolder, { recursive: true, force: true }));
  const alias = join(aliasHolder, "workspace-alias");
  symlinkSync(base, alias, "dir");

  const make = (workspace: string) =>
    createSelfImprovementLoop({
      objective: { description: "improve", workspace, requiresReview: false },
      proposals: sourceOf([]),
      workspace: new FakeWorkspace(),
      authority: new FakeAuthority(),
      limits: { maxIterations: 1 },
    });

  // Running under the alias acquires the realpath lock; finishing must release
  // it, or every later loop for the same directory would be refused forever.
  const first = await make(alias).run();
  assert.equal(first.status, "completed");
  const second = await make(alias).run();
  assert.equal(second.status, "completed", "the lock was released after the alias-path run");
  const third = await make(base).run();
  assert.equal(third.status, "completed", "the canonical path shares the released lock slot");
});

// ── The loop ───────────────────────────────────────────────────────────────

test("the first verified candidate is committed and the loop completes without a comparator", async () => {
  const { authority, workspace, run } = harness({ items: [p("c1"), p("c2")] });
  const outcome = await run();
  assert.equal(outcome.status, "completed");
  assert.match(outcome.reason, /first verified candidate accepted/);
  assert.equal(outcome.accepted, 1);
  assert.equal(outcome.rejected, 0);
  assert.equal(outcome.committed.length, 1);
  assert.match(outcome.committed[0]?.ref ?? "", /^ref-rsi/);
  assert.equal(outcome.iterations[0]?.verdict, "accepted");
  // The canonical run lifecycle was driven: begin, then verified finish.
  assert.equal(authority.begins.length, 1);
  assert.deepEqual(authority.finishes.map((entry) => entry.outcome), ["verified"]);
  // P1-2 (adversarial review, pinned): the run's ask that reaches the
  // reviewer is the OPERATOR's objective — never the candidate's own
  // hypothesis, which would be a prompt-injection seam into the backstop gate.
  assert.equal(authority.begins[0]?.taskPrompt, "make the suite pass with fewer flaky tests");
  assert.notEqual(authority.begins[0]?.taskPrompt, "hypothesis c1");
  assert.equal(workspace.discards.length, 0, "an accepted candidate is never discarded");
  assert.equal(outcome.best?.proposalId, "c1");
});

test("a candidate that fails the verification gate is discarded and never committed", async () => {
  const { authority, workspace, run } = harness({
    items: [p("c1"), p("c2")],
    failVerified: true,
    maxIterations: 2,
  });
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /maxIterations \(2\) reached/);
  assert.equal(outcome.accepted, 0);
  assert.equal(outcome.rejected, 2);
  assert.equal(outcome.committed.length, 0);
  assert.equal(outcome.best, undefined);
  assert.equal(workspace.discards.length, 2, "every rejected candidate is discarded");
  assert.equal(workspace.commits.length, 0, "a rejected candidate never commits");
  assert.ok(authority.finishes.some((entry) => entry.outcome === "failed"), "rejected candidates close their run failed");
  assert.match(outcome.iterations[0]?.reason ?? "", /verification gate refused/);
});

test("an unchanged candidate is rejected, closed failed, and discarded", async () => {
  const authority = new FakeAuthority();
  const workspace = new FakeWorkspace();
  workspace.failApply = false;
  const loop = createSelfImprovementLoop({
    objective: { description: "improve", workspace: "/tmp/wf-rsi-no-change", requiresReview: false },
    proposals: sourceOf([p("c1"), undefined]),
    workspace: {
      assertBaseline: async () => undefined,
      apply: async () => ({ changed: false, summary: "candidate produced no change" }),
      commit: async () => {
        throw new Error("commit must not be reached for an unchanged candidate");
      },
      discard: async () => {
        workspace.discards.push("noop");
      },
    },
    authority,
    limits: { maxIterations: 3 },
  });
  const outcome = await loop.run();
  assert.equal(outcome.status, "completed", "the source is exhausted after the rejection");
  assert.equal(outcome.rejected, 1);
  assert.equal(outcome.accepted, 0);
  assert.equal(authority.begins.length, 1);
  assert.deepEqual(authority.finishes.map((entry) => entry.outcome), ["failed"]);
  assert.match(outcome.iterations[0]?.reason ?? "", /no change/);
  void workspace;
});

test("an apply failure is rejected and discarded", async () => {
  const { authority, workspace, run } = harness({ items: [p("c1"), undefined], failApply: true });
  const outcome = await run();
  assert.equal(outcome.status, "completed", "the source is exhausted after the rejection");
  assert.equal(outcome.rejected, 1);
  assert.equal(outcome.accepted, 0);
  assert.deepEqual(authority.finishes.map((entry) => entry.outcome), ["failed"]);
  assert.equal(workspace.discards.length, 1);
  assert.match(outcome.iterations[0]?.reason ?? "", /apply failed/);
});

test("a failed rollback (discard throws) stops the loop and is surfaced, never hidden", async () => {
  const { authority, workspace, run } = harness({
    items: [p("c1"), p("c2")],
    failVerified: true,
    discardThrows: true,
    maxIterations: 3,
  });
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /left the workspace unsafe/);
  assert.match(outcome.reason, /could not be discarded/);
  assert.equal(outcome.rejected, 1, "the loop stops rather than continuing over a mutated tree");
  assert.match(outcome.iterations[0]?.reason ?? "", /rollback incomplete:.*could not be discarded/);
  assert.equal(authority.begins.length, 1, "no further candidate is authorized after a failed rollback");
  assert.equal(workspace.commits.length, 0);
});

test("a failed run close (finish failed throws) stops the loop and is surfaced", async () => {
  const { authority, workspace, run } = harness({
    items: [p("c1"), p("c2")],
    failVerified: true,
    failFailedClose: true,
    maxIterations: 3,
  });
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /left the workspace unsafe/);
  assert.match(outcome.reason, /could not be closed failed/);
  assert.equal(outcome.rejected, 1);
  assert.match(outcome.iterations[0]?.reason ?? "", /rollback incomplete:.*could not be closed failed/);
  assert.equal(authority.begins.length, 1);
  assert.equal(workspace.commits.length, 0);
});

test("a non-improving score is rejected before the verification gate", async () => {
  const { authority, workspace, run } = harness({
    items: [p("c1"), undefined],
    measure: () => 3,
    baselineScore: 10,
    direction: "higher",
  });
  const outcome = await run();
  assert.equal(outcome.rejected, 1);
  assert.equal(authority.finishes.length, 1, "only the failed close ran");
  assert.deepEqual(authority.finishes.map((entry) => entry.outcome), ["failed"]);
  assert.equal(workspace.commits.length, 0);
  assert.match(outcome.iterations[0]?.reason ?? "", /did not improve on incumbent 10/);
});

test("an improving score keeps iterating and commits every verified candidate", async () => {
  const { authority, workspace, run } = harness({
    items: [p("c1"), p("c2"), p("c3")],
    maxIterations: 3,
    measure: ({ iteration }) => 10 + iteration,
    direction: "higher",
  });
  const outcome = await run();
  assert.equal(outcome.status, "stopped", "maxIterations is the bound");
  assert.equal(outcome.accepted, 3);
  assert.equal(outcome.committed.length, 3);
  assert.equal(outcome.best?.proposalId, "c3");
  assert.equal(outcome.best?.score, 13);
  assert.equal(authority.begins.length, 3);
  assert.equal(workspace.commits.length, 3);
  assert.deepEqual(outcome.iterations.map((entry) => entry.score), [11, 12, 13]);
});

test("a lower-is-better objective accepts only decreasing scores", async () => {
  const scores = [12, 8, 9];
  const { authority, run } = harness({
    items: [p("c1"), p("c2"), p("c3"), undefined],
    measure: ({ iteration }) => scores[iteration - 1] ?? Number.POSITIVE_INFINITY,
    direction: "lower",
  });
  const outcome = await run();
  assert.equal(outcome.accepted, 2, "c1 and c2 improve; c3 does not");
  assert.equal(outcome.rejected, 1);
  assert.equal(outcome.best?.score, 8);
  assert.deepEqual(authority.finishes.map((entry) => entry.outcome), ["verified", "verified", "failed"]);
  assert.equal(authority.begins.length, 3);
});

test("maxConsecutiveRejections stops the loop deterministically", async () => {
  const { authority, run } = harness({
    items: [p("c1"), p("c2"), p("c3")],
    failVerified: true,
    maxIterations: 5,
    maxConsecutiveRejections: 2,
  });
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /2 consecutive rejections/);
  assert.equal(outcome.rejected, 2);
  assert.equal(authority.begins.length, 2);
});

test("the cost budget stops the loop before the next proposal", async () => {
  const { authority, run } = harness({
    items: [p("c1"), p("c2")],
    budgetUsd: 1,
    usageUsd: () => 2,
  });
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /budget cap reached/);
  assert.equal(authority.begins.length, 0, "a spent budget mutates nothing");
});

test("a malformed proposal fails closed without beginning a run", async () => {
  const { authority, run } = harness({ items: [{ id: "  ", hypothesis: "missing id" }, p("c2")] });
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /malformed proposal/);
  assert.equal(authority.begins.length, 0);
  assert.equal(outcome.iterations.length, 0);
});

test("authority refusing run begin stops the loop without mutating", async () => {
  const { authority, workspace, run } = harness({ items: [p("c1"), p("c2")] });
  authority.beginThrows = true;
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /authority refused run begin/);
  assert.equal(workspace.applies.length, 0, "no candidate is applied without an authorized run");
  assert.equal(workspace.commits.length, 0);
});

test("a proposal source failure stops the loop", async () => {
  const authority = new FakeAuthority();
  const loop = createSelfImprovementLoop({
    objective: { description: "improve", workspace: "/tmp/wf-rsi-source-error", requiresReview: false },
    proposals: {
      next: async () => {
        throw new Error("model unavailable");
      },
    },
    workspace: new FakeWorkspace(),
    authority,
    limits: { maxIterations: 3 },
  });
  const outcome = await loop.run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /proposal source failed: model unavailable/);
  assert.equal(authority.begins.length, 0);
});

test("a verified candidate that cannot be committed is audited and stops the loop uncommitted", async () => {
  const { workspace, run } = harness({
    items: [p("c1"), p("c2")],
    maxIterations: 3,
    commitBehavior: "throw",
  });
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /could not be committed/);
  assert.equal(outcome.committed.length, 0, "the loop never claims a commit it did not make");
  assert.equal(outcome.iterations.length, 1);
  assert.equal(outcome.iterations[0]?.verdict, "accepted");
  assert.match(outcome.iterations[0]?.reason ?? "", /could not be committed/);
  assert.equal(outcome.iterations[0]?.commitRef, undefined);
  assert.equal(workspace.commits.length, 1);
});

test("a commit that reports not-committed stops the loop fail-closed", async () => {
  const { run } = harness({ items: [p("c1")], commitBehavior: "not-committed" });
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /was not committed/);
  assert.equal(outcome.committed.length, 0);
});

// ── End-to-end: the real run registry gates acceptance on evidence ─────────

interface RepoFixture {
  readonly dir: string;
  readonly cleanup: () => void;
}

function makeGitRepo(prefix: string): RepoFixture {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "loop@example.invalid"]);
  git(["config", "user.name", "Self-Improvement Loop"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "baseline\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function registryHarness(input: { readonly testPassed: boolean }) {
  const repo = makeGitRepo("wf-rsi-registry");
  const tasks: WorkflowTask[] = [
    { id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] },
  ];
  const graph = new TaskGraph(tasks);
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    repo.dir,
  );
  let reviewerCounter = 0;
  const testRuns: string[] = [];
  const registry = createRunRegistry(application, graph, {
    reviewer: (controller) => async (review) => {
      const reviewerRunId = `rsi-reviewer:${(reviewerCounter += 1)}`;
      await controller.begin({
        runId: reviewerRunId,
        title: "Self-improvement reviewer run",
        ...(review.workspace === undefined ? {} : { workspace: review.workspace }),
      });
      await controller.review({
        runId: review.runId,
        reviewerRunId,
        verdict: "approved",
        summary: AXES_SUMMARY,
      });
      return { reviewerRunId, verdict: "approved", recorded: true, summary: AXES_SUMMARY };
    },
    testRunner: async (run) => {
      testRuns.push(run.runId);
      return { passed: input.testPassed, output: input.testPassed ? "all green" : "1 failing: expected 3, got 4" };
    },
  });
  const gitWorkspace = createGitCandidateWorkspace({
    workspace: repo.dir,
    run: createExecFileRunner(),
    mutate: async () => {
      writeFileSync(join(repo.dir, "improvement.txt"), "export const better = true;\n");
    },
  });
  const loop = createSelfImprovementLoop({
    objective: {
      description: "every candidate must pass the hub test command and an independent review",
      workspace: repo.dir,
      requiresReview: true,
    },
    proposals: sourceOf([p("c1"), undefined]),
    workspace: gitWorkspace,
    authority: createAuthorityGate(registry.controller),
    limits: { maxIterations: 4 },
  });
  return { ...repo, graph, registry, loop, testRuns };
}

test("an accepted candidate verifies on fresh reviewer + test evidence, then commits", async (t) => {
  const context = registryHarness({ testPassed: true });
  t.after(context.cleanup);

  const outcome = await context.loop.run();

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.accepted, 1);
  assert.equal(outcome.rejected, 0);
  assert.equal(outcome.committed.length, 1);
  assert.match(outcome.committed[0]?.ref ?? "", /^[0-9a-f]{40}$/, "the commit ref is a real git revision");
  const runTask = context.graph
    .tasks()
    .find((task) => task.title === "Self-improvement candidate c1");
  assert.equal(runTask?.state, "VERIFIED", "the accepted candidate's canonical run is kernel-verified");
  assert.ok(
    context.graph
      .evidence()
      .some((entry) => entry.authority === "environment" && entry.subject === `test:${context.dir}` && entry.result === "passed"),
    "the acceptance rides hub-recorded environment evidence",
  );
  assert.ok(
    context.graph.evidence().some((entry) => entry.authority === "reviewer" && entry.subject === runTaskIdOf(outcome, 0) && entry.result === "passed"),
    "the acceptance rides reviewer evidence",
  );
  assert.equal(
    existsSync(join(context.dir, "improvement.txt")),
    true,
    "the accepted change survives the commit",
  );
  assert.equal(context.testRuns.length, 1, "the hub test command ran for the accepted candidate");
});

test("a rejected candidate's run fails and its change is discarded from the tree", async (t) => {
  const context = registryHarness({ testPassed: false });
  t.after(context.cleanup);

  const outcome = await context.loop.run();

  assert.equal(outcome.status, "completed", "the source is exhausted after the rejection");
  assert.equal(outcome.rejected, 1);
  assert.equal(outcome.accepted, 0);
  assert.equal(outcome.committed.length, 0);
  const runTask = context.graph
    .tasks()
    .find((task) => task.title === "Self-improvement candidate c1");
  assert.equal(runTask?.state, "FAILED", "the rejected candidate's canonical run is closed failed");
  assert.equal(
    existsSync(join(context.dir, "improvement.txt")),
    false,
    "the rejected change is discarded from the workspace",
  );
  assert.match(outcome.iterations[0]?.reason ?? "", /test evidence failed/);
});

// ── Git candidate workspace (real git) ─────────────────────────────────────

test("the git candidate workspace detects, commits, and discards a change", async (t) => {
  const repo = makeGitRepo("wf-rsi-git");
  t.after(repo.cleanup);
  const workspace = createGitCandidateWorkspace({
    workspace: repo.dir,
    run: createExecFileRunner(),
    mutate: async () => {
      writeFileSync(join(repo.dir, "feature.ts"), "export const improved = true;\n");
    },
  });

  const applied = await workspace.apply({ runId: "r1", workspace: repo.dir, proposal: p("c1") });
  assert.equal(applied.changed, true);

  const committed = await workspace.commit({ runId: "r1", workspace: repo.dir, message: "feat: improve the loop" });
  assert.equal(committed.committed, true);
  assert.match(committed.ref ?? "", /^[0-9a-f]{40}$/);
  assert.equal(readFileSync(join(repo.dir, "feature.ts"), "utf8"), "export const improved = true;\n");

  // A further edit (tracked modification + untracked file) is fully reverted.
  writeFileSync(join(repo.dir, "feature.ts"), "mutated after commit\n");
  writeFileSync(join(repo.dir, "stray.txt"), "untracked\n");
  await workspace.discard({ runId: "r1", workspace: repo.dir });
  assert.equal(readFileSync(join(repo.dir, "feature.ts"), "utf8"), "export const improved = true;\n");
  assert.equal(existsSync(join(repo.dir, "stray.txt")), false);
});

test("the git candidate workspace reports no change when the tree is clean", async (t) => {
  const repo = makeGitRepo("wf-rsi-clean");
  t.after(repo.cleanup);
  const workspace = createGitCandidateWorkspace({ workspace: repo.dir, run: createExecFileRunner() });
  const applied = await workspace.apply({ runId: "r2", workspace: repo.dir, proposal: p("c1") });
  assert.equal(applied.changed, false);
});

test("the git candidate workspace refuses a relative workspace at composition time", () => {
  assert.throws(
    () => createGitCandidateWorkspace({ workspace: "relative", run: createExecFileRunner() }),
    /must be an absolute path/,
  );
});

test("a successful commit with a failing rev-parse reports committed without a ref", async () => {
  const calls: string[] = [];
  const workspace = createGitCandidateWorkspace({
    workspace: "/tmp/wf-rsi-revparse",
    run: async (_command, args) => {
      calls.push(args[0] ?? "");
      if (args[0] === "rev-parse") throw new Error("rev-parse unavailable");
      return { stdout: "", stderr: "" };
    },
  });
  const committed = await workspace.commit({ runId: "r3", workspace: "/tmp/wf-rsi-revparse", message: "m" });
  assert.equal(committed.committed, true, "the commit itself succeeded");
  assert.equal(committed.ref, undefined, "the missing ref is reported, not a commit failure");
  assert.deepEqual(calls, ["add", "commit", "rev-parse"]);
});

test("a throwing usageUsd supplier stops the loop fail-closed", async () => {
  const { authority, run } = harness({
    items: [p("c1")],
    budgetUsd: 10,
    usageUsd: () => {
      throw new Error("meter exploded");
    },
  });
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /usage supplier failed/);
  assert.match(outcome.reason, /meter exploded/);
  assert.equal(authority.begins.length, 0, "an unreadable meter authorizes no mutation");
});

test("a throwing onIteration observer is logged, never propagated", async () => {
  const authority = new FakeAuthority();
  const logs: string[] = [];
  const loop = createSelfImprovementLoop({
    objective: { description: "improve", workspace: "/tmp/wf-rsi-observer", requiresReview: false },
    proposals: sourceOf([p("c1")]),
    workspace: new FakeWorkspace(),
    authority,
    limits: { maxIterations: 3 },
    log: (message) => logs.push(message),
    onIteration: () => {
      throw new Error("observer exploded");
    },
  });
  const outcome = await loop.run();
  assert.equal(outcome.status, "completed", "an observability failure does not kill the loop");
  assert.equal(outcome.accepted, 1);
  assert.equal(outcome.iterations.length, 1);
  assert.equal(authority.begins.length, 1);
  assert.ok(
    logs.some((message) => /onIteration observer failed: observer exploded/.test(message)),
    "the observer failure is logged, not silently swallowed",
  );
});

test("a rollback failure names both the run-close and discard failures on the record", async () => {
  const { run } = harness({
    items: [p("c1"), p("c2")],
    failVerified: true,
    failFailedClose: true,
    discardThrows: true,
    maxIterations: 3,
  });
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  const reason = outcome.iterations[0]?.reason ?? "";
  assert.match(reason, /rollback incomplete:.*could not be closed failed/);
  assert.match(reason, /could not be discarded/);
  assert.match(reason, /; /, "both failures are joined, not collapsed to the first");
});

function runTaskIdOf(outcome: LoopOutcome, index: number): string {
  return outcome.iterations[index]?.runId ?? "";
}

test("cooperative cancel stops at the iteration boundary, after the in-flight candidate completes", async () => {
  let cancel = false;
  const authority = new FakeAuthority();
  const loop = createSelfImprovementLoop({
    objective: {
      description: "improve",
      workspace: "/tmp/wf-rsi-cancel",
      requiresReview: false,
      measure: ({ iteration }) => iteration,
    },
    proposals: sourceOf([p("c1"), p("c2"), p("c3")]),
    workspace: new FakeWorkspace(),
    authority,
    limits: { maxIterations: 5 },
    shouldStop: () => cancel,
    // The operator cancels while the first candidate is being recorded; the
    // candidate still completes its commit, and the loop stops before the next.
    onIteration: () => {
      cancel = true;
    },
  });
  const outcome = await loop.run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /cancelled by operator/);
  assert.equal(outcome.accepted, 1, "the in-flight candidate completed before cancel took effect");
  assert.equal(outcome.committed.length, 1, "a boundary cancel never loses a verified commit");
  assert.equal(authority.begins.length, 1, "no further candidate was authorized after cancel");
});

test("a throwing shouldStop predicate stops the loop fail-closed", async () => {
  const authority = new FakeAuthority();
  const workspace = new FakeWorkspace();
  const loop = createSelfImprovementLoop({
    objective: { description: "improve", workspace: "/tmp/wf-rsi-cancel-throw", requiresReview: false },
    proposals: sourceOf([p("c1"), p("c2")]),
    workspace,
    authority,
    limits: { maxIterations: 5 },
    shouldStop: () => {
      throw new Error("cancel probe exploded");
    },
  });
  const outcome = await loop.run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /cancellation check failed.*cancel probe exploded/);
  assert.equal(authority.begins.length, 0, "an unreadable cancel signal authorizes no mutation");
});

test("a failed workspace baseline check stops the loop before any authority is engaged", async () => {
  const { authority, workspace, run } = harness({ items: [p("c1"), p("c2")], baselineThrows: true });
  const outcome = await run();
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /workspace baseline check failed.*dirty tree/);
  assert.equal(authority.begins.length, 0, "no run is begun on an unsafe baseline");
  assert.equal(workspace.applies.length, 0, "no candidate is applied on an unsafe baseline");
  assert.equal(outcome.iterations.length, 0);
});

test("the git workspace refuses a dirty tree or non-repository as a baseline", async (t) => {
  const repo = makeGitRepo("wf-rsi-baseline");
  t.after(repo.cleanup);
  const workspace = createGitCandidateWorkspace({ workspace: repo.dir, run: createExecFileRunner() });

  // Clean baseline passes.
  await workspace.assertBaseline({ workspace: repo.dir });

  // Uncommitted work (tracked modification + untracked file) is refused: the
  // destructive discard must never be able to destroy operator changes.
  writeFileSync(join(repo.dir, "tracked.md"), "operator WIP\n");
  writeFileSync(join(repo.dir, "untracked.txt"), "operator scratch\n");
  await assert.rejects(
    () => workspace.assertBaseline({ workspace: repo.dir }),
    /uncommitted work/,
  );

  execFileSync("git", ["checkout", "--", "."], { cwd: repo.dir, stdio: "ignore" });
  rmSync(join(repo.dir, "tracked.md"), { force: true });
  assert.equal(existsSync(join(repo.dir, "tracked.md")), false);

  const notARepo = mkdtempSync(join(tmpdir(), "wf-rsi-notrepo-"));
  t.after(() => rmSync(notARepo, { recursive: true, force: true }));
  await assert.rejects(
    () => workspace.assertBaseline({ workspace: notARepo }),
    /not a git repository/,
  );
});
