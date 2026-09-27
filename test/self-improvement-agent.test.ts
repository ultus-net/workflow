import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createAgentDrivenRunLoop,
  createAgentMutator,
  createAgentProposalSource,
  createContainedGitRunner,
  createShellMeasure,
  parseProposalReply,
  parseScalarScore,
  renderPromptTemplate,
  DEFAULT_APPLY_PROMPT_TEMPLATE,
  DEFAULT_PROPOSAL_PROMPT_TEMPLATE,
  type AgentTurnInput,
  type AgentTurnResult,
} from "../src/integrations/self-improvement-agent.js";
import {
  createExecFileRunner,
  createGitCandidateWorkspace,
  type LoopAuthority,
  type LoopIterationRecord,
} from "../src/integrations/self-improvement-loop.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { shellExecutorFor } from "../src/integrations/run-controller.js";
import { taskId } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import type { SelfImprovementSpec } from "../src/integrations/self-improvement-registry.js";

/**
 * Checkpoint F: the production self-improvement loop wiring. Hermetic — the
 * agent turn is a fake, the measure a stub, git runs for real against
 * throwaway repositories. The seams under test are the composition root the
 * hub CLI wires (`createAgentDrivenRunLoop`) and its prompt/parse/measure
 * pieces.
 */

function fakeTurn(handler: (input: AgentTurnInput) => Promise<AgentTurnResult> | AgentTurnResult): {
  turn: (input: AgentTurnInput) => Promise<AgentTurnResult>;
  calls: AgentTurnInput[];
} {
  const calls: AgentTurnInput[] = [];
  return {
    calls,
    turn: async (input) => {
      calls.push(input);
      return await handler(input);
    },
  };
}

function controls(isCancelled: () => boolean = () => false): {
  onIteration: (record: LoopIterationRecord) => void;
  isCancelled: () => boolean;
} {
  return {
    onIteration: (): void => undefined,
    isCancelled,
  };
}

function spec(overrides: Partial<SelfImprovementSpec> = {}): SelfImprovementSpec {
  return { workspace: "/tmp/unused", objective: "reduce flaky tests", maxIterations: 3, ...overrides };
}

function recordingAuthority(): { authority: LoopAuthority; begins: Array<Record<string, unknown>>; finishes: string[] } {
  const begins: Array<Record<string, unknown>> = [];
  const finishes: string[] = [];
  return {
    begins,
    finishes,
    authority: {
      async begin(input) {
        begins.push({ ...input });
      },
      async finish(input) {
        finishes.push(input.outcome);
      },
    },
  };
}

function makeGitRepo(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args: readonly string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "[EMAIL]"]);
  git(["config", "user.name", "Self-Improvement Agent Wiring"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "baseline\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline"]);
  return dir;
}

function gitStatus(dir: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
}

test("renderPromptTemplate substitutes placeholders and fails closed on unknown ones", () => {
  assert.equal(renderPromptTemplate("a {{x}} b", { x: "1" }), "a 1 b");
  assert.throws(() => renderPromptTemplate("a {{missing}} b", {}), /unknown placeholder \{\{missing\}\}/);
  assert.throws(() => renderPromptTemplate("a {{x}} {{leftover", { x: "1" }), /unterminated or malformed placeholder/);
});

test("substituted values may contain {{...}} — they are data, not placeholders", () => {
  assert.equal(
    renderPromptTemplate("say {{x}}", { x: "the template {{magic}} is data" }),
    "say the template {{magic}} is data",
  );
  assert.equal(
    renderPromptTemplate("objective: {{objective}}", { objective: "make {{objective}} true" }),
    "objective: make {{objective}} true",
  );
});

test("parseProposalReply prefers the whole reply, then the last fenced block", () => {
  const fenced = parseProposalReply({
    reply: "thinking...\n```json\n{\"id\": \"first\", \"hypothesis\": \"a\"}\n```\nmore\n```json\n{\"id\": \"second\", \"hypothesis\": \"b\", \"target\": \"src/x.ts\"}\n```",
    fallbackId: "fallback",
  });
  assert.deepEqual(fenced, { id: "second", hypothesis: "b", target: "src/x.ts" });
  const bare = parseProposalReply({ reply: "{\"hypothesis\": \"just an object\"}", fallbackId: "fallback-1" });
  assert.deepEqual(bare, { id: "fallback-1", hypothesis: "just an object" });
  // The whole reply parses first, so an outer object with an embedded fence wins over the fence.
  const outer = parseProposalReply({
    reply: "{\"id\": \"outer\", \"hypothesis\": \"with ```json {\\\"id\\\": \\\"inner\\\", \\\"hypothesis\\\": \\\"x\\\"} ``` inside\"}",
    fallbackId: "fallback-2",
  });
  assert.deepEqual(outer, { id: "outer", hypothesis: "with ```json {\"id\": \"inner\", \"hypothesis\": \"x\"} ``` inside" });
});

test("parseProposalReply fails closed on replies without a parseable proposal", () => {
  assert.throws(() => parseProposalReply({ reply: "no json here", fallbackId: "f" }), /no parseable JSON proposal/);
  assert.throws(() => parseProposalReply({ reply: "{\"id\": \"x\"}", fallbackId: "f" }), /no parseable JSON proposal/);
  assert.throws(() => parseProposalReply({ reply: "{\"hypothesis\": \"   \"}", fallbackId: "f" }), /no parseable JSON proposal/);
});

test("the proposal source renders defaults and parses the reply", async () => {
  const fake = fakeTurn(() => ({ result: "```json\n{\"hypothesis\": \"add a guard\"}\n```", costUsd: 0.01 }));
  const source = createAgentProposalSource({ turn: fake.turn, workspace: "/repo" });
  const proposal = await source.next({
    iteration: 2,
    objective: "zero lint warnings",
    accepted: 1,
    rejected: 1,
    best: { proposalId: "p1", score: 4 },
    history: [
      {
        iteration: 1,
        proposalId: "p1",
        hypothesis: "h",
        changed: true,
        runId: "r1",
        verdict: "accepted",
        reason: "candidate verified and committed",
        observedAt: "now",
      },
    ],
  });
  assert.deepEqual(proposal, { id: "proposal-2", hypothesis: "add a guard" });
  const prompt = fake.calls[0]?.prompt ?? "";
  assert.match(prompt, /zero lint warnings/);
  assert.match(prompt, /iteration: 2/);
  assert.match(prompt, /incumbent best: p1 \(score 4\)/);
  assert.match(prompt, /#1 accepted p1 — candidate verified and committed/);
  assert.equal(fake.calls[0]?.workspace, "/repo");
  assert.equal(fake.calls[0]?.kind, "proposal");
});

test("the proposal source honors a template override and propagates turn failures", async () => {
  const fake = fakeTurn(() => ({ result: "{\"hypothesis\": \"h\"}", costUsd: 0 }));
  const source = createAgentProposalSource({ turn: fake.turn, workspace: "/repo", promptTemplate: "CUSTOM {{objective}}" });
  await source.next({ iteration: 1, objective: "obj", accepted: 0, rejected: 0, best: undefined, history: [] });
  assert.equal(fake.calls[0]?.prompt, "CUSTOM obj");
  const failing = createAgentProposalSource({
    turn: async () => {
      throw new Error("agent down");
    },
    workspace: "/repo",
  });
  await assert.rejects(
    failing.next({ iteration: 1, objective: "o", accepted: 0, rejected: 0, best: undefined, history: [] }),
    /agent down/,
  );
});

test("the agent mutator renders the apply prompt and defers change detection to git", async () => {
  const fake = fakeTurn(() => ({ result: "done", costUsd: 0.02 }));
  const mutate = createAgentMutator({ turn: fake.turn, objective: "ship it" });
  const result = await mutate({
    runId: "rsi:1:abc",
    workspace: "/repo",
    proposal: { id: "p", hypothesis: "add guard", target: "src/g.ts" },
  });
  assert.equal(result, undefined, "the git status check, not the agent, decides whether the tree changed");
  const prompt = fake.calls[0]?.prompt ?? "";
  assert.match(prompt, /Candidate hypothesis: add guard/);
  assert.match(prompt, /Candidate target: src\/g\.ts/);
  assert.match(prompt, /workspace at \/repo/);
  assert.equal(fake.calls[0]?.runId, "rsi:1:abc");
  assert.equal(fake.calls[0]?.kind, "apply");
  const unspecified = createAgentMutator({ turn: fake.turn, objective: "ship it" });
  await unspecified({ runId: "r", workspace: "/repo", proposal: { id: "p", hypothesis: "h" } });
  assert.match(fake.calls[1]?.prompt ?? "", /Candidate target: \(unspecified\)/);
  assert.match(DEFAULT_APPLY_PROMPT_TEMPLATE, /\{\{hypothesis\}\}/);
});

test("parseScalarScore accepts only a single finite number", () => {
  assert.equal(parseScalarScore("42\n"), 42);
  assert.equal(parseScalarScore("3.5"), 3.5);
  assert.equal(parseScalarScore("-2"), -2);
  assert.equal(parseScalarScore("1e3"), 1000);
  assert.throws(() => parseScalarScore(""), /not a single finite number/);
  assert.throws(() => parseScalarScore("12 tests passed"), /not a single finite number/);
});

test("createShellMeasure runs the command in the workspace and parses the score", async () => {
  const calls: Array<{ command: string; cwd: string }> = [];
  const measure = createShellMeasure({
    shell: async (command, cwd) => {
      calls.push({ command, cwd });
      return " 7\n";
    },
    command: "echo 7",
    workspace: "/repo",
  });
  assert.equal(await measure({ iteration: 1 }), 7);
  assert.deepEqual(calls, [{ command: "echo 7", cwd: "/repo" }]);
  const failing = createShellMeasure({
    shell: async () => {
      throw new Error("command crashed");
    },
    command: "broken",
    workspace: "/repo",
  });
  await assert.rejects(async () => failing({ iteration: 1 }), /command crashed/);
});

test("the contained git runner passes constant commands and stages commit messages inside .git", async (t) => {
  const fakeCwd = mkdtempSync(join(tmpdir(), "wf-rsi-contained-"));
  mkdirSync(join(fakeCwd, ".git"), { recursive: true });
  t.after(() => rmSync(fakeCwd, { recursive: true, force: true }));
  const commands: string[] = [];
  const runner = createContainedGitRunner({
    shell: async (command) => {
      commands.push(command);
      return "ok";
    },
    authorName: "Workflow Self-Improvement Loop",
    authorEmail: "[EMAIL]",
  });
  await runner("git", ["status", "--porcelain"], { cwd: fakeCwd });
  await runner("git", ["add", "-A"], { cwd: fakeCwd });
  await runner("git", ["reset", "--hard", "HEAD"], { cwd: fakeCwd });
  assert.deepEqual(commands, ["git status --porcelain", "git add -A", "git reset --hard HEAD"]);

  await runner("git", ["commit", "-m", "self-improvement(p): fix; rm -rf $HOME `id`"], { cwd: fakeCwd });
  assert.equal(commands.length, 4);
  const commitCommand = commands[3] ?? "";
  assert.match(
    commitCommand,
    /^git -c user\.name='[^']+' -c user\.email='[^']+' -c core\.hooksPath=\/dev\/null commit --no-verify -F '[^']+\.msg'$/,
    "identity + hook hardening ride on -c flags; the message travels via -F, never as a shell-interpolated string",
  );
  assert.match(commitCommand, /\.git\/rsi-message-/, "the message file is staged inside the workspace .git, the path the sandbox mounts");
  assert.equal(readdirSync(join(fakeCwd, ".git")).length, 0, "the staged message file is removed after the attempt");
  await assert.rejects(runner("git", ["push", "origin"], { cwd: fakeCwd }), /refuses unexpected git invocation/);
  await assert.rejects(
    runner("git", ["clean", "-fd"], { cwd: fakeCwd }),
    /refuses unexpected git invocation/,
    "the destructive git clean left the runner's constant set: the discard is restore-based so the guard's destructive-operation policy never denies the loop's rollback",
  );
});

test("discard restores the baseline without git clean: tracked reverts, untracked removed by exact enumerated path", async (t) => {
  const repo = makeGitRepo(t, "wf-rsi-discard-restore");
  const { authority } = recordingAuthority();
  let measureCalls = 0;
  const fake = fakeTurn((input) => {
    if (input.kind === "proposal") {
      if (fake.calls.filter((call) => call.kind === "proposal").length === 1) {
        return { result: "{\"id\": \"bad\", \"hypothesis\": \"h\"}", costUsd: 0.01 };
      }
      return { result: "{\"id\": \"good\", \"hypothesis\": \"h2\"}", costUsd: 0.01 };
    }
    if (input.kind === "apply" && fake.calls.filter((call) => call.kind === "apply").length === 1) {
      // The first (rejected) candidate edits a tracked file AND leaves an
      // untracked artifact behind — the exact shape that made `git clean -fd`
      // the old rollback and tripped the guard's destructive-operation denial
      // live.
      writeFileSync(join(repo, "README.md"), "candidate change\n");
      writeFileSync(join(repo, "scratch-artifact.txt"), "untracked\n");
    }
    if (input.kind === "apply" && fake.calls.filter((call) => call.kind === "apply").length === 2) {
      writeFileSync(join(repo, "feature.txt"), "accepted candidate\n");
    }
    return { result: "applied", costUsd: 0.01 };
  });
  const runLoop = createAgentDrivenRunLoop({
    authority,
    turn: fake.turn,
    gitRun: createExecFileRunner(),
    measure: { shell: async () => (measureCalls++ === 0 ? "4\n" : "6\n"), command: "measure" },
  });
  const outcome = await runLoop(spec({ workspace: repo, maxIterations: 2, baselineScore: 5 }), controls());
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /maxIterations \(2\) reached/);
  assert.equal(outcome.accepted, 1, `outcome was: ${JSON.stringify(outcome).slice(0, 300)}`);
  assert.equal(outcome.rejected, 1, `outcome was: ${JSON.stringify(outcome).slice(0, 300)}`);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "baseline\n", "the rejected candidate's tracked edit reverted");
  assert.ok(!existsSync(join(repo, "scratch-artifact.txt")), "the untracked candidate artifact is removed by exact path");
  assert.ok(existsSync(join(repo, "feature.txt")), "the accepted candidate (second apply) stays committed");
});
test("the contained commit path completes on the real containment backend end to end", async (t) => {
  const repo = makeGitRepo(t, "wf-rsi-contained-e2e");
  // Remove the fixture's repo-local identity: the contained commit must rely
  // on the runner's `git -c` identity, proving the sandbox-clearing residual
  // is actually handled.
  execFileSync("git", ["config", "--unset", "user.email"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "--unset", "user.name"], { cwd: repo, stdio: "ignore" });
  const graph = new TaskGraph([
    { id: taskId("interactive"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] },
  ]);
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    repo,
  );
  const shellTaskId = taskId("contained-shell:probe");
  application.addTask({ id: shellTaskId, title: "contained shell probe", dependencies: [], requiredEvidence: [] });
  application.transition(shellTaskId, "IN_PROGRESS");
  application.selectActiveTask(shellTaskId);
  const shell = shellExecutorFor(application, undefined, true);
  const workspace = createGitCandidateWorkspace({
    workspace: repo,
    run: createContainedGitRunner({
      shell: async (command, cwd) => shell(command, cwd, undefined),
      authorName: "Workflow Self-Improvement Loop",
      authorEmail: "[EMAIL]",
    }),
  });
  await workspace.assertBaseline({ workspace: repo });
  writeFileSync(join(repo, "feature.txt"), "contained commit\n");
  const applied = await workspace.apply({ runId: "rsi:e2e:contained", workspace: repo, proposal: { id: "p", hypothesis: "add a file" } });
  assert.equal(applied.changed, true);
  const result = await workspace.commit({ runId: "rsi:e2e:contained", workspace: repo, message: "self-improvement(p): contained commit end to end" });
  assert.equal(result.committed, true, "the contained commit must actually complete (P0 pin: message file inside .git, identity via -c)");
  assert.ok(result.ref);
  assert.equal(gitStatus(repo), "", "the tree is clean after the commit");
  const log = execFileSync("git", ["log", "-1", "--format=%an <%ae> %s"], { cwd: repo, encoding: "utf8" });
  assert.match(log, /Workflow Self-Improvement Loop/);
  assert.match(log, /contained commit end to end/);
});

test("the agent-driven loop accepts, verifies, and commits a candidate end to end", async (t) => {
  const repo = makeGitRepo(t, "wf-rsi-agent-ok");
  const { authority, begins, finishes } = recordingAuthority();
  const fake = fakeTurn((input) => {
    if (input.kind === "proposal") {
      return { result: "{\"id\": \"good\", \"hypothesis\": \"add feature file\"}", costUsd: 0.01 };
    }
    if (fake.calls.filter((call) => call.kind === "apply").length === 1) {
      writeFileSync(join(repo, "feature.txt"), "x\n");
    }
    return { result: "applied", costUsd: 0.01 };
  });
  const runLoop = createAgentDrivenRunLoop({
    authority,
    turn: fake.turn,
    gitRun: createExecFileRunner(),
    measure: { shell: async () => "5\n", command: "measure" },
  });
  const outcome = await runLoop(spec({ workspace: repo, maxIterations: 2 }), controls());
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /maxIterations \(2\) reached/);
  assert.equal(outcome.accepted, 1);
  assert.equal(outcome.rejected, 1);
  assert.equal(outcome.committed.length, 1);
  assert.ok(outcome.committed[0]?.ref);
  assert.deepEqual(finishes, ["verified", "failed"], "the accepted candidate closed verified; the no-change candidate closed failed");
  assert.equal(begins[0]?.requiresReview, true, "an unspecified requiresReview defaults to the review gate");
  assert.equal(begins[0]?.taskPrompt, "reduce flaky tests", "the run ask is the operator objective, not the hypothesis");
  assert.ok(readFileSync(join(repo, "feature.txt"), "utf8").length > 0, "the accepted candidate stays committed");
  assert.equal(gitStatus(repo), "", "the rejected candidate was discarded");
});

test("the loop stops at the budget cap using accumulated turn cost", async (t) => {
  const repo = makeGitRepo(t, "wf-rsi-agent-budget");
  const { authority } = recordingAuthority();
  const fake = fakeTurn((input) => {
    if (input.kind === "proposal") return { result: "{\"hypothesis\": \"h\"}", costUsd: 0.01 };
    writeFileSync(join(repo, "f.txt"), "x\n");
    return { result: "applied", costUsd: 0.01 };
  });
  const runLoop = createAgentDrivenRunLoop({
    authority,
    turn: fake.turn,
    gitRun: createExecFileRunner(),
    measure: { shell: async () => "1\n", command: "measure" },
  });
  const outcome = await runLoop(
    spec({ workspace: repo, maxIterations: 5, budgetUsd: 0.015, requiresReview: false }),
    controls(),
  );
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /budget cap reached/);
  assert.equal(outcome.accepted, 1, "the first candidate was accepted before the cap");
});

test("operator cancel stops the loop at the iteration boundary", async (t) => {
  const repo = makeGitRepo(t, "wf-rsi-agent-cancel");
  const { authority } = recordingAuthority();
  const fake = fakeTurn(() => {
    throw new Error("no turn should run after cancel");
  });
  const runLoop = createAgentDrivenRunLoop({ authority, turn: fake.turn, gitRun: createExecFileRunner() });
  const outcome = await runLoop(spec({ workspace: repo, requiresReview: false }), controls(() => true));
  assert.equal(outcome.status, "stopped");
  assert.equal(outcome.reason, "cancelled by operator");
  assert.equal(fake.calls.length, 0);
});

test("a failing proposal turn stops the loop without mutating the workspace", async (t) => {
  const repo = makeGitRepo(t, "wf-rsi-agent-failclosed");
  const { authority } = recordingAuthority();
  const runLoop = createAgentDrivenRunLoop({
    authority,
    turn: async () => {
      throw new Error("agent down");
    },
    gitRun: createExecFileRunner(),
  });
  const outcome = await runLoop(spec({ workspace: repo, requiresReview: false }), controls());
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /proposal source failed.*agent down/);
  assert.equal(outcome.iterations.length, 0);
  assert.equal(gitStatus(repo), "", "no mutation happened");
});

test("an authority refusal stops the loop before any mutation", async (t) => {
  const repo = makeGitRepo(t, "wf-rsi-agent-auth");
  const runLoop = createAgentDrivenRunLoop({
    authority: {
      async begin() {
        throw new Error("refused");
      },
      async finish() {
        throw new Error("unreachable");
      },
    },
    turn: fakeTurn(() => ({ result: "{\"hypothesis\": \"h\"}", costUsd: 0 })).turn,
    gitRun: createExecFileRunner(),
  });
  const outcome = await runLoop(spec({ workspace: repo, requiresReview: false }), controls());
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /authority refused run begin/);
  assert.equal(gitStatus(repo), "");
});

test("a baseline score and direction gate the comparator", async (t) => {
  const repo = makeGitRepo(t, "wf-rsi-agent-baseline");
  const { authority, finishes } = recordingAuthority();
  const fake = fakeTurn((input) => {
    if (input.kind === "proposal") return { result: "{\"hypothesis\": \"halve it\"}", costUsd: 0 };
    writeFileSync(join(repo, "f.txt"), "x\n");
    return { result: "applied", costUsd: 0 };
  });
  const runLoop = createAgentDrivenRunLoop({
    authority,
    turn: fake.turn,
    gitRun: createExecFileRunner(),
    measure: { shell: async () => "5\n", command: "measure" },
  });
  const outcome = await runLoop(
    spec({ workspace: repo, maxIterations: 1, baselineScore: 10, direction: "lower", requiresReview: false }),
    controls(),
  );
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.reason, /maxIterations \(1\) reached/);
  assert.equal(outcome.accepted, 1);
  assert.equal(finishes[0], "verified");
});

test("the prompt prefix is prepended to every loop turn", async (t) => {
  const repo = makeGitRepo(t, "wf-rsi-agent-prefix");
  const { authority } = recordingAuthority();
  const fake = fakeTurn(() => ({ result: "{\"hypothesis\": \"h\"}", costUsd: 0 }));
  const runLoop = createAgentDrivenRunLoop({
    authority,
    turn: fake.turn,
    gitRun: createExecFileRunner(),
    promptPrefix: "<orientation>\n",
  });
  await runLoop(spec({ workspace: repo, maxIterations: 1, requiresReview: false }), controls());
  for (const call of fake.calls) {
    assert.ok(call.prompt.startsWith("<orientation>\n"), `every turn carries the prefix: ${call.kind}`);
  }
  assert.match(DEFAULT_PROPOSAL_PROMPT_TEMPLATE, /\{\{objective\}\}/);
  assert.match(DEFAULT_PROPOSAL_PROMPT_TEMPLATE, /\{\{history\}\}/);
});
// W098 (criterion 1, cache-bust audit): the proposal prompt cacheable prefix.
// Provider prompt caches are keyed on the longest shared token PREFIX across
// calls. The loop-state counters (iteration/accepted/rejected/best) change
// every iteration, so they must sit AFTER the append-only history - putting
// them before the history busts the cache right before the bulk of every
// prompt. The history is a prefix-superset across iterations (formatHistory
// serializes append-only), so history-then-counters makes the cacheable
// prefix grow monotonically.

test("W098: the proposal prompt keeps the growing history ahead of the changing counters", async () => {
  const fake = fakeTurn(() => ({ result: '{"hypothesis": "next"}', costUsd: 0.01 }));
  const source = createAgentProposalSource({ turn: fake.turn, workspace: "/repo" });
  await source.next({
    iteration: 3,
    objective: "obj",
    accepted: 1,
    rejected: 1,
    best: undefined,
    history: [
      { iteration: 1, proposalId: "p1", hypothesis: "h1", changed: true, runId: "r1", verdict: "accepted", reason: "verified", observedAt: "now" },
      { iteration: 2, proposalId: "p2", hypothesis: "h2", changed: false, runId: "r2", verdict: "rejected", reason: "not verified", observedAt: "now" },
    ],
  });
  const prompt = fake.calls[0]?.prompt ?? "";
  const countersAt = prompt.indexOf("iteration: 3");
  const acceptedAt = prompt.indexOf("accepted candidates: 1");
  const bestAt = prompt.indexOf("incumbent best: none yet");
  const firstHistoryAt = prompt.indexOf("#1 accepted");
  assert.ok(firstHistoryAt !== -1, "the history must render");
  assert.ok(countersAt !== -1 && acceptedAt !== -1 && bestAt !== -1, "the counters must render");
  assert.ok(countersAt > firstHistoryAt && acceptedAt > firstHistoryAt && bestAt > firstHistoryAt, "the changing counters must sit AFTER the append-only history (provider prefix-cache discipline)");
  const taskAt = prompt.indexOf("Task: propose");
  const historyHeaderAt = prompt.indexOf("iteration history:");
  assert.ok(taskAt !== -1 && historyHeaderAt !== -1, "the task block and history header must render");
  assert.ok(taskAt < historyHeaderAt, "the stable task block must precede the growing history");
});
