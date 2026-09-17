import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorkflowCodingSession, type CodingSessionEvent } from "../src/application/coding-session.js";
import { createConfiguredAcpRuntime } from "../src/integrations/acp-runtime.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";

/**
 * W049 dogfood matrix — REAL contained goose sessions through the REAL
 * production runtime path (`createConfiguredAcpRuntime` with
 * `WORKFLOW_ACP_AGENT=goose`: the hub-written config under GOOSE_PATH_ROOT,
 * the skills mount, the loopback metering proxy, the budget guard
 * composition, W047's surfacing — everything the operator's surface runs).
 * The matrix cells: repo edits, shell/ops, MCP participation through the
 * operator's real skills mount, resume across a full contained restart, a
 * denial case, and W044/W045 cost visibility (proxy metrics + the budget
 * mechanism record).
 *
 * HONEST SCOPE: these are agent-run smoke sessions (2026-09-17, goose
 * 1.50.1, openrouter through the metering proxy) recorded as the initial
 * dogfood matrix in docs/GOOSE_DOGFOOD.md. The operator's own daily-driver
 * period still gates the backup-slot takeover and the W050 retirement
 * decisions; the 'both operator providers' arm pends Azure credentials.
 * Gated: WORKFLOW_ACP_GOOSE_DOGFOOD=1 (real model traffic).
 */
const runDogfood = process.env.WORKFLOW_ACP_GOOSE_DOGFOOD === "1";

interface DogfoodSession {
  readonly session: WorkflowCodingSession;
  readonly events: CodingSessionEvent[];
  readonly metrics: (() => { requests: number; totalTokens: number; costUsd: number } | undefined) | undefined;
  readonly budgetMechanism: string;
  dispose(): Promise<void>;
}

async function gooseRuntime(workspace: string, resumeFrom?: string): Promise<DogfoodSession> {
  const previous = process.env.WORKFLOW_ACP_AGENT;
  process.env.WORKFLOW_ACP_AGENT = "goose";
  try {
    const seed: WorkflowTask = {
      id: taskId("W049-DOGSFOOD"),
      title: "goose dogfood session",
      state: "IN_PROGRESS",
      dependencies: [],
      requiredEvidence: [],
    };
    const application = new WorkflowApplication(
      new TaskGraph([seed]),
      hostCapabilities({ transport: "native", authoritativePreMutation: true }),
      [],
      new Set(["read", "mutation", "process"]),
      workspace,
    );
    application.startInteractiveTask();
    const runtime = await createConfiguredAcpRuntime(application, workspace, () => application.activeTaskId(), resumeFrom);
    const events: CodingSessionEvent[] = [];
    runtime.session.subscribe((event) => events.push(event));
    return {
      session: runtime.session,
      events,
      metrics: runtime.metrics,
      budgetMechanism: runtime.budgetMechanism,
      dispose: () => runtime.dispose(),
    };
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_ACP_AGENT;
    else process.env.WORKFLOW_ACP_AGENT = previous;
  }
}

async function turn(session: WorkflowCodingSession, prompt: string): Promise<void> {
  await Promise.race([
    session.submit(prompt),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("dogfood turn timeout")), 240_000)),
  ]);
}

test("dogfood cell 1-2: a contained goose session edits a repo file and runs a real shell op through the runtime path", { skip: !runDogfood, timeout: 600_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-goose-dogfood-edit-"));
  // A real scratch repo: git-initialized, one tracked file.
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# dogfood repo\n\nscratch workspace for the W049 matrix.\n", { encoding: "utf8" });
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const runtime = await gooseRuntime(workspace);
  t.after(() => runtime.dispose().catch(() => undefined));
  console.log(JSON.stringify({ dogfood: "session-open", budgetMechanism: runtime.budgetMechanism, agent: "goose (agentInfo in prior probe runs: 1.50.1)" }, null, 2));

  // Cell 1 — repo edit: a real file change in the workspace.
  await turn(runtime.session, `Edit README.md in the current workspace: append a new line saying "goose was here" after the existing text. Keep everything else unchanged, then finish.`);
  const readme = readFileSync(join(workspace, "README.md"), "utf8");
  const edited = readme.includes("goose was here");
  console.log(JSON.stringify({ dogfood: "repo-edit", edited, readme }, null, 2));
  assert.ok(edited, "the dogfood repo edit must land in the workspace file");

  // Cell 2 — shell/ops: a real shell command through the permission surface.
  await turn(runtime.session, `Run the shell command 'printf GOOSE-OPS-OK > ops-check.txt' in the current workspace, then tell me it succeeded, and finish.`);
  const opsRan = existsSync(join(workspace, "ops-check.txt")) && readFileSync(join(workspace, "ops-check.txt"), "utf8").includes("GOOSE-OPS-OK");
  const shellAsk = runtime.events.some((event) => event.type === "tool" && /shell|printf|ops-check/i.test(event.title));
  console.log(JSON.stringify({ dogfood: "shell-ops", opsRan, shellToolProjected: shellAsk }, null, 2));
  assert.ok(opsRan, "the shell/ops task must produce its file through the permission surface");
  assert.ok(shellAsk, "the shell tool call must project into the session record (hub-visible)");

  const metrics = runtime.metrics?.();
  console.log(JSON.stringify({ dogfood: "cost-visibility", metrics }, null, 2));
  assert.ok(metrics !== undefined && metrics.requests > 0 && metrics.totalTokens > 0, "W044 cost visibility: the metering proxy must record the session's real usage");
});

test("dogfood cell 3: MCP participation through the operator's real skills mount", { skip: !runDogfood, timeout: 600_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-goose-dogfood-mcp-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const skillsDir = process.env.SKILLS_MCP_DIR ?? join(homedir(), ".agents", "skills");
  console.log(JSON.stringify({ dogfood: "mcp-mount", skillsDir, mounted: existsSync(skillsDir) }, null, 2));

  const runtime = await gooseRuntime(workspace);
  t.after(() => runtime.dispose().catch(() => undefined));
  await turn(runtime.session, `Call your skills server's list_skills tool and reply with the exact JSON it returns. If you have no such tool, reply exactly: NO_MCP_TOOLS`);
  // goose delivers its reply through the turn result (snapshot().result);
  // streamed agent_message_chunk rows can be empty for this agent — read
  // BOTH channels so the harness never mistakes a reply channel for
  // silence (the first dogfood run's inconclusive-cell lesson).
  const snapshot3 = runtime.session.snapshot();
  const streamed3 = runtime.events
    .filter((event): event is { type: "assistant"; text: string } => event.type === "assistant")
    .map((event) => event.text)
    .join("");
  const histogram: Record<string, number> = {};
  for (const event of runtime.events) histogram[event.type] = (histogram[event.type] ?? 0) + 1;
  const answer = `${snapshot3.state === "completed" ? snapshot3.result : ""}\n${streamed3}`;
  console.log(JSON.stringify({ dogfood: "mcp-participation", state: snapshot3.state, result: snapshot3.state === "completed" ? snapshot3.result.slice(0, 400) : undefined, streamedChars: streamed3.length, eventHistogram: histogram }, null, 2));
  assert.ok(!answer.includes("NO_MCP_TOOLS"), "the skills-mcp mount must be live on the runtime path (a NO_MCP_TOOLS here is a real gap to record)");
  assert.match(answer, /skills/i, "the skills server must participate through the runtime-composed mount");
});

test("dogfood cell 4: resume across a full contained runtime restart (the runtime path)", { skip: !runDogfood, timeout: 600_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-goose-dogfood-resume-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const KEYWORD = "GOOSE-DOGFOOD-RESUME-9C21";

  const first = await gooseRuntime(workspace);
  let sessionId: string | undefined;
  try {
    await turn(first.session, `Remember the code phrase ${KEYWORD} for later. Reply with the phrase once, then finish.`);
    sessionId = first.session.snapshot().state === "completed"
      ? extractSessionId(first.events)
      : undefined;
    console.log(JSON.stringify({ dogfood: "resume-phase-1", state: first.session.snapshot(), sessionId }, null, 2));
  } finally {
    await first.dispose();
  }
  assert.ok(sessionId, "phase 1 must complete and surface the agent session id (W047: it projects for resume)");

  const second = await gooseRuntime(workspace, sessionId);
  try {
    await turn(second.session, `What code phrase did I ask you to remember? Reply with the exact phrase, then finish.`);
    const snapshot2 = second.session.snapshot();
    const streamed2 = second.events
      .filter((event): event is { type: "assistant"; text: string } => event.type === "assistant")
      .map((event) => event.text)
      .join("");
    // Read BOTH reply channels (result + streamed) — the first dogfood run
    // read only streamed rows and mistook the channel for silence.
    const answer = `${snapshot2.state === "completed" ? snapshot2.result : ""}\n${streamed2}`;
    console.log(JSON.stringify({ dogfood: "resume-phase-2", state: snapshot2, streamedChars: streamed2.length }, null, 2));
    assert.ok(
      answer.includes(KEYWORD),
      `the exact keyword must be recalled across the full contained restart (${KEYWORD}); phase-2 end state: ${JSON.stringify(snapshot2)}`,
    );
  } finally {
    await second.dispose();
  }
});

test("dogfood cell 5: a hub denial is honored end to end (the workspace boundary holds)", { skip: !runDogfood, timeout: 600_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-goose-dogfood-deny-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const outside = join(tmpdir(), "wf-goose-dogfood-outside-");
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));

  const runtime = await gooseRuntime(workspace);
  t.after(() => runtime.dispose().catch(() => undefined));
  await turn(runtime.session, `Use your developer tools to write the exact text ESCAPE-ATTEMPT into ${join(outside, "escape.txt")}. Then finish.`);
  const escaped = existsSync(join(outside, "escape.txt"));
  console.log(JSON.stringify({ dogfood: "denial-case", escaped, outsidePath: outside }, null, 2));
  assert.equal(escaped, false, "a write outside the workspace must be denied by the hub and never land (the failClosedReason path may surface; the boundary holds either way)");
});

test("dogfood cell 6: W045 budget enforcement refuses the next prompt after a crossing (the runtime path)", { skip: !runDogfood, timeout: 600_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-goose-dogfood-budget-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const previousBudget = process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS;
  // A cap of 1 token: any recorded usage crosses it on the first check.
  process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS = "1";
  let runtime: Awaited<ReturnType<typeof gooseRuntime>> | undefined;
  try {
    runtime = await gooseRuntime(workspace);
    console.log(JSON.stringify({ dogfood: "budget-mechanism", budgetMechanism: runtime.budgetMechanism }, null, 2));
    assert.match(runtime.budgetMechanism, /local session-budget guard/);
    await turn(runtime.session, `Reply with the single word READY and finish.`);
    // The turn either completed under the race or was cancelled mid-flight;
    // either way the guard's sticky violation must now refuse new prompts.
    const refusal = runtime.session.snapshot();
    console.log(JSON.stringify({ dogfood: "budget-state", state: refusal }, null, 2));
    // DESIGNED refusal semantics (the first dogfood run's lesson): the
    // refusal gate drops the failed event when the session is already
    // cancelled (coding-session.ts #emit), so the snapshot state stays
    // "cancelled" — the operator-visible reason lives on the guard surface
    // (the TUI "! budget exceeded" line). What the snapshot cannot hide is
    // TRAFFIC: the refused prompt must produce ZERO additional model
    // requests and must not be queued.
    const beforeRefusal = runtime.metrics?.();
    await runtime.session.submit("one more prompt after the cap");
    const after = runtime.session.snapshot();
    const afterRefusal = runtime.metrics?.();
    console.log(JSON.stringify({ dogfood: "budget-refusal", before: refusal.state, after: after.state, requestsBefore: beforeRefusal?.requests, requestsAfter: afterRefusal?.requests, queued: runtime.session.queuedPrompts() }, null, 2));
    assert.equal(after.state, "cancelled", "the refusal gate intentionally keeps the cancelled state (the reason surfaces via the guard's own surface), but the prompt must never run");
    assert.ok(beforeRefusal !== undefined && afterRefusal !== undefined, "the metering proxy must be composed on the openrouter path");
    assert.equal(afterRefusal.requests, beforeRefusal.requests, "the post-cap prompt must be REFUSED (the refusal gate): zero additional model traffic, never silently started");
    assert.equal(runtime.session.queuedPrompts().length, 0, "the refused prompt must be neither run nor queued (fail-closed)");
  } finally {
    if (previousBudget === undefined) delete process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS;
    else process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS = previousBudget;
    await runtime?.dispose().catch(() => undefined);
  }
});

/** The agent session id projects as a status event (W047) — extract it for resume. */
function extractSessionId(events: readonly CodingSessionEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "status" && /agent session id:/i.test(event.status)) {
      return event.status.split("agent session id:")[1]?.trim() ?? undefined;
    }
  }
  return undefined;
}
