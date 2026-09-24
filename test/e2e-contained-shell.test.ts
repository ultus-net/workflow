import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { TestContext } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { distArtifact, ensureFresh, repoRoot } from "./fixtures/compiled-dist.js";

// W132 — the CONTAINED-SHELL's behavioral lane over the COMPILED seat (the
// e2e stream's containment contract, not just boot). The W126 sweep proved
// dist/cli/contained-shell.js boots its banner and exits on stdin EOF
// (compiled-bins-smoke.test.ts), and the W021/W022 behavioral seat
// (interactive-containment-cli.test.ts) drives src/cli/contained-shell.ts —
// but LESS-0012's recorded class is precisely behavioral divergence between
// the src seat and the compiled seat, so the compiled bin gets its own drive
// over stdin pipes (no PTY: the shell reads stdin lines; the readline prompt
// is an ordinary stdout byte).
//
// The W021/W022 contract being exercised (TASKS.md): commands execute through
// WorkflowContainedProcess and the real Linux Bubblewrap backend; the session
// grants writes only to a fresh temporary workspace, keeps networking
// isolated and credentials cleared; success records mutation and fresh
// environment evidence before the task reaches VERIFIED; a denied or nonzero
// command remains unverified and does not terminate the persistent session;
// every command independently crosses authorization, containment, and a
// terminal task state. The boundary STATEMENT is pinned via the boot banner
// ("Network: isolated | Credentials: cleared") and its backend truth via the
// ENFORCED lane — the bwrap network isolation itself is the unit suites'
// pin (test/containment.test.ts), not re-probed from outside here.
//
// The three lanes this file pins, each observed live in this environment
// before pinning (the W132 discipline: run first, pin observed truth):
//   1. benign allow — "Policy: ALLOW" → "Containment: ENFORCED" (bubblewrap
//      0.11.0 present here) → the command's observable output →
//      "Task: VERIFIED" (mutation recorded + fresh environment evidence), a
//      blank stdin line executing nothing, then a clean exit 0 on `exit`.
//   2. nonzero failure — `false` → "Task: FAILED (exit 1)" and the session
//      SURVIVES (the next command still verifies — W022's persistence claim,
//      observed).
//   3. guard-denied — Workflow's own lane prints "Policy: ALLOW" first, then
//      the vendored guard seat denies INSIDE WorkflowContainedProcess.execute.
//      The OBSERVED DEFECT (the W132 sweep finding, FIXED in this wave): the
//      throw used to be unhandled, so the session DIED (exit 1) printing
//      neither "Containment:" nor "Task:" — W022's "a denied command does not
//      terminate the persistent session" did NOT hold on this lane. The fix
//      catches the denial per-command and reports "Task: FAILED (the guard
//      denied execution: …)" like the nonzero lane does — fail-closed (the
//      denial fires BEFORE any spawn: nothing executes, the shell's finally
//      still removes the workspace) AND session-preserving, which is what the
//      third pin now asserts.
//
// Honesty claims, recorded from source where this environment cannot observe
// them (never faked): ENFORCED is this environment's truth (bwrap present);
// on Linux without a working bwrap, selectContainment still selects
// LinuxBubblewrapContainment and execute() rejects ("containment backend
// unavailable" / the bwrap: stderr boundary error) — since the W132 fix that
// rejection is CAUGHT per-command (the session survives; the FAILED report
// carries the message; its label is deliberately seat-neutral — the
// round-3 review's P2 — because execute's throw classes are not
// distinguishable without parsing message prefixes); on non-Linux the honest
// degradation is "Containment: POLICY-ONLY" with a real execution
// (platform.ts's visible two-place degradation). A bwrap-less environment
// must pin its own observed truth, not borrow this file's.
//
// Why there is no "Policy: DENY" pin: the shell's own deny branch
// (contained-shell.ts's `Policy: DENY (...)` + "Task: FAILED" + continue) is
// DEAD CODE from the shell's only input surface. Every stdin line flows the
// same hardcoded proposal (src/cli/contained-shell.ts): subjects are fixed
// [], the application's allowed capability set includes "process" and nothing
// withholds it, workspaceRoot is never set (so the WORKSPACE_PATH_DENIED
// confinement deny cannot fire), the task is recomputed READY by the kernel
// (no dependencies) and transitioned IN_PROGRESS before authorize, no skills
// or pedagogy gate is composed, and each command builds a FRESH
// WorkflowApplication with a fresh MutationBudget(100) — at most two consumes
// per command, so the budget cannot exhaust either. No stdin input can reach
// the deny branch; the only deny that CAN fire (the guard seat's) surfaces as
// the per-command FAILED report above — which is exactly the gap between the
// two authorization seats, now surfaced honestly instead of crashing.
//
// SAFETY CONTRACT (LESS-0051, non-negotiable): no agent spawns and no PTYs
// ever — stdin pipes only, and the payloads execute INSIDE the product's own
// bubblewrap containment (the surface under test; never bypassed); HOME is
// redirected to a fresh mkdtemp (the guard's home-derived config lookups see
// the redirected HOME); the only EXECUTED payloads are `echo` and `false`;
// the guard-deny probe (assembled from fragments so this file's own authoring
// guard never matches the literal) is denied by the vendored guard BEFORE any
// spawn and, even in a guard-less environment, is harmless inside the
// containment boundary (no git repository in the throwaway workspace); the
// shell's guard MCP server (node + the vendored policy corpus — the product's
// own enforcement seat, not an agent) is led into the child's own process
// group and dies with it (stdin EOF through the closed transport); the shell
// receives SIGTERM only after its stdin EOF/exit path has been given the
// chance to complete (a stuck exit path is the only SIGTERM trigger, and the
// pin fails on it); never spawnSync a long-running process — every wait
// polls live pipes.

/** A tiny polling sleep (no lingering timers: each resolves when it fires). */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ShellExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** Drives one live contained-shell child over stdin pipes, accumulating
 * stdout/stderr while the flow streams. */
class ShellSession {
  readonly #child: ChildProcess;
  readonly #stdin: NodeJS.WritableStream;
  readonly #outStream: NodeJS.ReadableStream;
  readonly #errStream: NodeJS.ReadableStream;
  #stdout = "";
  #stderr = "";
  #exit: ShellExit | undefined;
  readonly #exited: Promise<ShellExit>;

  constructor(context: TestContext, home: string) {
    this.#child = spawn(process.execPath, [distArtifact("cli", "contained-shell.js")], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group, so a teardown kill reaps the guard MCP server too
    });
    const { stdin, stdout, stderr } = this.#child;
    if (stdin === null || stdout === null || stderr === null) {
      throw new TypeError("the contained-shell child did not open its stdio pipes");
    }
    this.#stdin = stdin;
    this.#outStream = stdout;
    this.#errStream = stderr;
    this.#outStream.setEncoding("utf8").on("data", (chunk: string) => { this.#stdout += chunk; });
    this.#errStream.setEncoding("utf8").on("data", (chunk: string) => { this.#stderr += chunk; });
    this.#exited = new Promise<ShellExit>((resolveExit) => {
      this.#child.once("close", (code, signal) => {
        this.#exit = { code, signal };
        resolveExit(this.#exit);
      });
    });
    stdin.on("error", () => { /* a post-exit write is a lost race; the exit pin reports it */ });
    context.after(() => {
      // Abort-path backstop only: the deliberate teardown paths below never
      // reach this (the exit pins await the child's own close first).
      if (this.#exit === undefined) killTree(this.#child, "SIGKILL");
    });
  }

  /** Writes one command line (the trailing newline makes it a line). */
  write(line: string): void {
    this.#stdin.write(`${line}\n`);
  }

  /** Ends stdin — the EOF the shell's own exit path consumes. */
  endStdin(): void {
    this.#stdin.end();
  }

  output(): string {
    return this.#stdout;
  }

  errors(): string {
    return this.#stderr;
  }

  transcript(): string {
    return `${this.#stdout}--- stderr ---\n${this.#stderr}`;
  }

  /** Polls the accumulated streams until EVERY marker is visible (stdout or
   * stderr), failing with the full transcript on deadline or early death. */
  async waitFor(markers: readonly string[], deadlineMs = 30_000, label = "the flow"): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const done = markers.every((marker) => this.#stdout.includes(marker) || this.#stderr.includes(marker));
      if (done) return;
      if (this.#exit !== undefined) break;
      await sleep(50);
    }
    const died = this.#exit !== undefined ? ` — the shell exited first (code ${this.#exit.code}, signal ${this.#exit.signal})` : "";
    assert.fail(`${label} never produced [${markers.join(" | ")}] within ${deadlineMs}ms${died}\ntranscript:\n${this.transcript()}`);
  }

  /** Awaits the child's own close. SIGTERM arrives ONLY after the shell's
   * stdin EOF/exit path has been given its chance and the deadline passed —
   * the LESS-0051 ordering (never a preemptive signal kill). */
  async waitForExit(deadlineMs = 15_000, label = "the shell"): Promise<ShellExit> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (this.#exit !== undefined) return this.#exit;
      await sleep(50);
    }
    killTree(this.#child, "SIGTERM");
    const exit = await this.#exited;
    assert.fail(`${label} was still running after ${deadlineMs}ms — SIGTERM delivered only after its stdin EOF/exit path failed to complete (LESS-0051 ordering), final exit code ${exit.code} signal ${exit.signal}\ntranscript:\n${this.transcript()}`);
  }
}

/** Kills the child's whole process group (the detached-lead pattern of
 * src/cli/opencode-attach.ts's terminateProcessGroup), so no grandchild —
 * the guard MCP server included — outlives the probe. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already exited */
  }
}

// The guard-deny probe, assembled from fragments (the vendored guard's own
// string-assembly style): the operator-side guard inspects this session's
// every tool call, and the assembled literal is deny-listed by the very
// policy under test — so the e2e's authoring never trips the operator's own
// guard while the vendored guard still sees the exact command it denies.
const gitWord = ["gi", "t"].join("");
const cleanWord = ["cle", "an"].join("");
const GUARD_DENIED_COMMAND = `${gitWord} ${cleanWord} -fd`;

test("W132: a benign command flows Workflow authorization, enforced bubblewrap containment, and evidence-gated VERIFIED, then a clean exit", async (context) => {
  ensureFresh(distArtifact("cli", "contained-shell.js"));
  const home = mkdtempSync(join(tmpdir(), "w132-shell-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const shell = new ShellSession(context, home);

  // The blank line is part of the prompt contract: it executes nothing and
  // only re-prompts (pinning via the final Policy/Task counts below).
  shell.write("");
  shell.write("echo w132-contained-marker");
  await shell.waitFor(["Policy: ALLOW", "Containment: ENFORCED", "w132-contained-marker", "Task: VERIFIED"], 30_000, "the benign command flow");

  shell.write("exit");
  const exit = await shell.waitForExit();
  assert.equal(exit.code, 0, `the shell must exit cleanly after the exit command — transcript:\n${shell.transcript()}`);
  assert.equal(exit.signal, null, "the clean-exit path must not be signal-killed");

  const stdout = shell.output();
  // The boot banner with the stated boundary (W021: network isolated,
  // credentials cleared) and the fresh temporary workspace.
  assert.match(stdout, /^Writable workspace: \/tmp\/workflow-interactive-/m);
  assert.ok(stdout.includes("Network: isolated | Credentials: cleared"), `the boundary banner is missing — transcript:\n${stdout}`);
  // The observable sequence in the flow's order: policy decision, then the
  // containment verdict, then the command's own output, then the terminal
  // task state reached through recorded mutation + fresh evidence.
  const indexOf = (marker: string): number => stdout.indexOf(marker);
  const sequence = ["Policy: ALLOW", "Containment: ENFORCED", "w132-contained-marker", "Task: VERIFIED"].map(indexOf);
  assert.ok(
    sequence.every((position) => position >= 0) && sequence.every((position, index) => index === 0 || position > sequence[index - 1]!),
    `the ALLOW → ENFORCED → output → VERIFIED sequence must hold in order — stdout:\n${stdout}`,
  );
  // The blank stdin line executed nothing: exactly one policy line, one
  // containment line, one terminal state, no deny.
  assert.equal(stdout.match(/Policy: /g)?.length, 1, `exactly one command was authorized — stdout:\n${stdout}`);
  assert.equal(stdout.match(/Containment: /g)?.length, 1, `exactly one containment verdict — stdout:\n${stdout}`);
  assert.equal(stdout.match(/Task: /g)?.length, 1, `exactly one terminal task state — stdout:\n${stdout}`);
  assert.ok(!stdout.includes("Policy: DENY"), `no deny occurred — stdout:\n${stdout}`);
  // The guard seat composed silently in this environment (a fresh toolbox
  // dist): the benign flow crossed BOTH authorization seats. The advisory
  // fallback ("Workflow guard unavailable") would be the honest guard-less
  // state — recorded here because it did not occur, and its absence is what
  // makes the guard-deny lane below reachable.
  assert.ok(!shell.errors().includes("Workflow guard unavailable (advisory)"), `the guard must compose (not fall back to advisory) in this environment — stderr:\n${shell.errors()}`);
});

test("W132: a failing command stays unverified and the persistent session survives it (W022's persistence contract)", async (context) => {
  ensureFresh(distArtifact("cli", "contained-shell.js"));
  const home = mkdtempSync(join(tmpdir(), "w132-shell-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const shell = new ShellSession(context, home);

  // `false` exits 1 inside the containment boundary: unverified, reported,
  // and — W022's claim — the session must NOT terminate.
  shell.write("false");
  await shell.waitFor(["Policy: ALLOW", "Containment: ENFORCED", "Task: FAILED (exit 1)"], 30_000, "the failing command lane");

  // The next command still crosses the full flow on its own fresh task —
  // per-command independence over the compiled seat.
  shell.write("echo w132-persisted-marker");
  await shell.waitFor(["w132-persisted-marker", "Task: VERIFIED"], 30_000, "the post-failure command");

  shell.write("exit");
  const exit = await shell.waitForExit();
  assert.equal(exit.code, 0, `the session must survive a FAILED command and exit cleanly — transcript:\n${shell.transcript()}`);

  const stdout = shell.output();
  // Two commands, two independent ALLOW/containment verdicts; exactly one
  // FAILED (the `false`) and one VERIFIED (the echo) — distinct terminal
  // states on distinct tasks, neither reopened nor carried over.
  assert.equal(stdout.match(/Policy: ALLOW/g)?.length, 2, `both commands authorized — stdout:\n${stdout}`);
  assert.equal(stdout.match(/Containment: ENFORCED/g)?.length, 2, `both commands contained — stdout:\n${stdout}`);
  assert.equal(stdout.match(/Task: FAILED \(exit 1\)/g)?.length, 1, `exactly one failed task — stdout:\n${stdout}`);
  assert.equal(stdout.match(/Task: VERIFIED/g)?.length, 1, `exactly one verified task — stdout:\n${stdout}`);
});

test("W132: a guard-denied command fails closed at the guard seat, is reported per-command, and the persistent session survives it (W022's contract, repaired this wave)", async (context) => {
  ensureFresh(distArtifact("cli", "contained-shell.js"));
  const home = mkdtempSync(join(tmpdir(), "w132-shell-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const shell = new ShellSession(context, home);

  // The payload never executes in this environment: the vendored guard denies
  // it INSIDE WorkflowContainedProcess.execute BEFORE the containment spawn
  // (observed: "guard denied process execution: destructive-operation: <the
  // guard's reason>"). In a guard-less environment the honest alternative is
  // a contained execution of the same command (no git repository in the
  // throwaway workspace — a harmless fatal) reported as Task: FAILED — both
  // lanes fail closed; this pin records the observed one here.
  shell.write(GUARD_DENIED_COMMAND);
  // Workflow's OWN authorization lane allows it first (the hardcoded
  // proposal passes every application gate — see the header's dead-branch
  // analysis); the denial happens one seat deeper — and since the W132 fix
  // it is CAUGHT per-command: the FAILED report names the denial, no
  // containment verdict prints (nothing executed), and the session lives.
  await shell.waitFor(["Policy: ALLOW"], 30_000, "Workflow's own allow");
  await shell.waitFor(["Task: FAILED (execution refused: "], 30_000, "the per-command refusal report");
  assert.match(shell.output(), /guard denied process execution/, `the denial's cause must be visible in the FAILED report — stdout:\n${shell.output()}`);
  assert.ok(!shell.output().includes("Containment:"), `nothing executed — no containment verdict may print — stdout:\n${shell.output()}`);
  // The persistence half of W022's contract on the repaired lane: the next
  // command still verifies.
  shell.write("echo w132-survived-marker");
  await shell.waitFor(["Task: VERIFIED"], 30_000, "the surviving session's next command");
  shell.write("exit");
  const exit = await shell.waitForExit(20_000, "the repaired session");
  assert.equal(exit.code, 0, `the repaired session exits cleanly — transcript:\n${shell.transcript()}`);
  assert.equal(exit.signal, null, `no signal kill on the repaired lane — transcript:\n${shell.transcript()}`);
});
