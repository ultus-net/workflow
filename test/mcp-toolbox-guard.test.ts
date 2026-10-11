import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defaultToolboxGuardServerPath, guardDistIsStale, guardInputFromToolCall, guardPolicyEvidence } from "../src/integrations/mcp-toolbox-guard.js";
import { createGuardFactsResolver, createWorkflowGuardMcpProvider } from "../src/integrations/mcp-toolbox-guard.js";

const serverPath = resolve(process.cwd(), "mcp-toolbox", "apps", "workflow-guard-mcp", "dist", "server.js");

function ensureBuilt(): void {
  if (existsSync(serverPath) && !guardDistIsStale(process.cwd())) return;
  execFileSync("pnpm", ["--dir", "mcp-toolbox", "--filter", "workflow-guard-mcp", "run", "build"], { stdio: "inherit" });
}

// ── W120/C2: the fleet-mount dist-freshness gate ────────────────────────────
// C2 made the HUB/SEAT guard in-process (statically linked; a guardless hub is
// now impossible by construction — see the provider test below and
// test/guard-policy-drift.test.ts). The vendored app is STILL built and mounted
// as the agent-facing MCP tool, so its build must not be stale. existsSync
// alone let a stale vendored-guard dist serve pre-change policy: the
// build-when-missing semantics rebuild only on absence, so a src change after
// the last build leaves the mounted seat executing pre-change policy
// (LESS-0010's en-route hazard). `defaultToolboxGuardServerPath` refuses a
// missing or stale build; the test's self-healing rebuild closes the fresh
// case.

test("W120: guardDistIsStale classifies a fixture dist older than its src", () => {
  const root = mkdtempSync(join(tmpdir(), "w120-stale-"));
  const dist = join(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "dist");
  const src = join(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "src");
  mkdirSync(dist, { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(join(dist, "server.js"), "old");
  writeFileSync(join(src, "policy.ts"), "new");
  // The default mtimes are creation-ordered (dist then src) — make the
  // staleness explicit so the pin tests the comparison, not the clock.
  const newer = new Date(Date.now() + 60_000);
  utimesSync(join(src, "policy.ts"), newer, newer);
  assert.equal(guardDistIsStale(root), true, "a src file newer than the dist is stale");
});

test("W120: guardDistIsStale classifies a fresh dist as not stale", () => {
  const root = mkdtempSync(join(tmpdir(), "w120-fresh-"));
  const dist = join(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "dist");
  const src = join(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "src");
  mkdirSync(dist, { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(join(dist, "server.js"), "built");
  writeFileSync(join(src, "policy.ts"), "source");
  const newer = new Date(Date.now() + 120_000);
  utimesSync(join(dist, "server.js"), newer, newer);
  assert.equal(guardDistIsStale(root), false, "a dist at least as new as every src file is fresh");
});

test("W120: the fleet guard mount refuses a stale build, naming the remedy", () => {
  const root = mkdtempSync(join(tmpdir(), "w120-runtime-"));
  const dist = join(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "dist");
  const src = join(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "src");
  mkdirSync(dist, { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(join(dist, "server.js"), "old");
  writeFileSync(join(src, "policy.ts"), "new");
  const newer = new Date(Date.now() + 60_000);
  utimesSync(join(src, "policy.ts"), newer, newer);
  assert.throws(
    () => defaultToolboxGuardServerPath({ root }),
    /stale/,
    "a stale build must fail closed at the mount (the mounted seat cannot silently serve pre-change policy)",
  );
  assert.throws(
    () => defaultToolboxGuardServerPath({ root }),
    /toolbox:build/,
    "the error names the recorded remedy",
  );
});

test("W120: the real tree's dist is fresh (the repo-level pin; self-heals via ensureBuilt's staleness rebuild)", () => {
  ensureBuilt();
  assert.equal(
    guardDistIsStale(process.cwd()),
    false,
    "the checked-out dist must not predate the vendored src (existsSync alone let a stale seat execute pre-change policy)",
  );
});

// The missing-dist branch (guardDistIsStale → false) is the not-built error's
// job — a pin so a regression to `true` cannot conflate the two error classes.
test("W120: a missing dist is not staleness (the not-built error governs)", () => {
  const root = mkdtempSync(join(tmpdir(), "w120-missing-"));
  mkdirSync(join(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "src"), { recursive: true });
  writeFileSync(join(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "src", "policy.ts"), "source");
  assert.equal(guardDistIsStale(root), false, "a missing dist is the not-built error's job, not staleness");
  assert.throws(
    () => defaultToolboxGuardServerPath({ root }),
    /not built/,
    "the not-built error is preserved verbatim (the two error classes stay distinct)",
  );
});

test("guardPolicyEvidence maps decisions onto normalized MCP evidence", () => {
  const allow = guardPolicyEvidence({ decision: "allow", policy: "shell.safe", reason: "ok" }, 3);
  assert.equal(allow.result, "passed");
  assert.equal(allow.authority, "mcp");
  assert.equal(allow.subject, "policy:shell.safe");
  assert.equal(allow.mutationEpoch, 3);

  const deny = guardPolicyEvidence({ decision: "deny", policy: "shell.destructive", reason: "no" }, 4);
  assert.equal(deny.result, "failed");
});

test("C2: the guard provider answers in-process without spawning a child", async (t) => {
  const provider = await createWorkflowGuardMcpProvider();
  t.after(() => provider.close());

  const capabilities = await provider.capabilities();
  assert.deepEqual(capabilities.map((cap) => cap.name).sort(), ["guard_check", "guard_status"]);

  const allowed = await provider.guardCheck({ action: "shell", command: "ls -la" });
  assert.equal(allowed.decision, "allow");

  // A destructive command the policy denies, assembled at runtime so this
  // test file does not itself contain the flagged literal.
  const destructive = ["rm", "-rf", "/"].join(" ");
  const denied = await provider.guardCheck({ action: "shell", command: destructive });
  assert.equal(denied.decision, "deny");

  const status = await provider.guardStatus();
  assert.equal(status.mode, "policy-advisor");

  // The in-process dispatch seam answers identically, and an unknown
  // capability fails closed rather than resolving permissively.
  assert.deepEqual(await provider.invoke("guard_check", { action: "shell", command: "ls -la" }), allowed);
  await assert.rejects(provider.invoke("no_such_capability", {}), /no capability/);
});

// ── Plan Task G2: shared tool-call → guard-input mapping ────────────────────

test("guardInputFromToolCall maps every host family to guard actions", () => {
  // Cline hook surface
  assert.deepEqual(guardInputFromToolCall("execute_command", { command: "git status" }), { action: "shell", command: "git status" });
  assert.deepEqual(guardInputFromToolCall("write_to_file", { path: "src/a.ts", content: "let x = 1;" }), { action: "file_write", path: "src/a.ts", content: "let x = 1;" });
  // ACP approval surface
  assert.deepEqual(guardInputFromToolCall("run_commands", { commands: ["git status", { command: "make", args: ["build"] }] }), { action: "shell", command: "git status; make build" });
  assert.deepEqual(guardInputFromToolCall("replace_in_file", { path: "a.ts", diff: "@@ -1 +1 @@" }), { action: "file_write", path: "a.ts", patchText: "@@ -1 +1 @@" });
  // OpenCode surface — edit/write must carry the content, never an empty payload
  assert.deepEqual(guardInputFromToolCall("edit", { filePath: "src/a.ts", newString: "let y = 2;" }), { action: "file_write", path: "src/a.ts", content: "let y = 2;" });
  assert.deepEqual(guardInputFromToolCall("write", { filePath: "src/b.ts", content: "export {};" }), { action: "file_write", path: "src/b.ts", content: "export {};" });
  // Hub-implemented fs server — a delegated write hits the same write policy
  assert.deepEqual(guardInputFromToolCall("fs/write_text_file", { path: "/repo/src/b.ts", content: "export {};" }, "/repo"), { action: "file_write", path: "/repo/src/b.ts", content: "export {};", workspaceRoot: "/repo" });
  // Delegated reads are not guard-gated (the guard has no read action — the
  // same as direct reads on every surface)
  assert.equal(guardInputFromToolCall("fs/read_text_file", { path: "/repo/a.ts" }), undefined);
  assert.deepEqual(guardInputFromToolCall("apply_patch", { patchText: "*** Update File: x" }), { action: "file_write", patchText: "*** Update File: x" });
  assert.deepEqual(guardInputFromToolCall("bash", { command: "echo hi" }), { action: "shell", command: "echo hi" });
  // Network tools reach the guard with the target URL
  assert.deepEqual(guardInputFromToolCall("webfetch", { url: "https://example.internal" }), { action: "network", command: "https://example.internal" });
  // Unmapped tools stay out of the guard entirely
  assert.equal(guardInputFromToolCall("search_codebase", { query: "x" }), undefined);
  // workspaceRoot scoping applies to every mapped action
  assert.deepEqual(guardInputFromToolCall("write", { filePath: "a.ts", content: "x" }, "/repo"), { action: "file_write", path: "a.ts", content: "x", workspaceRoot: "/repo" });
});

// ── W090: the seat supplies workspace-derivable guard facts (frontier G2) ───
// The frontier assessment's single largest correction: the hub feeds the
// vendored core no facts, so protected-branch discipline is dead in
// hub-seated sessions and the W087 fact mode never engages. The provider
// enriches guarded calls with workspace-derivable facts; caller-supplied
// facts always win; a missing workspace enriches nothing.

function initTempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "workflow-w090-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "seed.txt"), "base\n");
  execFileSync("git", ["add", "seed.txt"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
  return repo;
}

test("W090: resolveGuardFacts discovers the branch and the live runtime-config root", async () => {
  const repo = initTempRepo();
  const home = mkdtempSync(join(tmpdir(), "workflow-w090-home-"));
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });

  const facts = await createGuardFactsResolver({ homeDir: home })(repo);
  assert.equal(facts.currentBranch, "main");
  assert.deepEqual(facts.protectedBranches, ["main", "master"]);
  assert.deepEqual(facts.liveConfigPaths, [join(home, ".config", "opencode")]);
});

test("W090: facts fail open — git failure and an absent runtime-config root omit, never guess", async () => {
  const plain = mkdtempSync(join(tmpdir(), "workflow-w090-plain-"));
  const home = mkdtempSync(join(tmpdir(), "workflow-w090-barehome-"));
  const resolver = createGuardFactsResolver({
    homeDir: home,
    runGit: async () => {
      throw new Error("git unavailable");
    },
  });
  const facts = await resolver(plain);
  assert.equal(facts.currentBranch, undefined);
  assert.deepEqual(facts.protectedBranches, ["main", "master"]);
  assert.equal(facts.liveConfigPaths, undefined);
  // Detached HEAD (empty `git branch --show-current` output) omits too.
  const detached = await createGuardFactsResolver({ homeDir: home, runGit: async () => "" })(plain);
  assert.equal(detached.currentBranch, undefined);
});

test("W090: hub-seated writes on a protected branch are denied; feature branches and caller-supplied facts win", async (t) => {
  const repo = initTempRepo();
  const home = mkdtempSync(join(tmpdir(), "workflow-w090-home2-"));
  const provider = await createWorkflowGuardMcpProvider({
    facts: createGuardFactsResolver({ homeDir: home }),
  });
  t.after(() => provider.close());

  const onMain = await provider.guardCheck({ action: "file_write", path: "src/a.ts", workspaceRoot: repo, content: "x" });
  assert.equal(onMain.decision, "deny");
  assert.equal(onMain.policy, "protected-branch-write");

  execFileSync("git", ["switch", "-c", "feat/branch-facts"], { cwd: repo, stdio: "ignore" });
  const onFeature = await provider.guardCheck({ action: "file_write", path: "src/a.ts", workspaceRoot: repo, content: "x" });
  assert.equal(onFeature.decision, "allow");

  // Caller-supplied facts win over discovery — the discriminating shape: the
  // repo sits on a feature branch (discovery would allow), but the caller
  // declares the protected branch, so the deny must come from the CALLER's
  // fact.
  const callerSupplied = await provider.guardCheck({
    action: "file_write",
    path: "src/a.ts",
    workspaceRoot: repo,
    content: "x",
    currentBranch: "main",
  });
  assert.equal(callerSupplied.decision, "deny");
  assert.equal(callerSupplied.policy, "protected-branch-write");
});

test("W090: the live-root fact engages T0 on the write lane through the seat", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "workflow-w090-t0-"));
  const bareHome = mkdtempSync(join(tmpdir(), "workflow-w090-t0bare-"));
  const withFacts = await createWorkflowGuardMcpProvider({
    facts: async () => ({ liveConfigPaths: [repo] }),
  });
  // Deterministic fact-less baseline: a bare home omits liveConfigPaths, so
  // this provider runs legacy segment mode regardless of the host layout.
  const withoutFacts = await createWorkflowGuardMcpProvider({
    facts: createGuardFactsResolver({ homeDir: bareHome }),
  });
  t.after(() => withFacts.close());
  t.after(() => withoutFacts.close());

  // A write under the declared live root is T0 with facts…
  const t0 = await withFacts.guardCheck({ action: "shell", command: `touch ${join(repo, "scratch.txt")}`, workspaceRoot: repo });
  assert.equal(t0.decision, "deny");
  assert.equal(t0.policy, "guard-tamper");
  // …and plain baseline-allow without them (the pre-W090 hub behavior).
  const legacy = await withoutFacts.guardCheck({ action: "shell", command: `touch ${join(repo, "scratch.txt")}`, workspaceRoot: repo });
  assert.equal(legacy.decision, "allow");
});

test("W090: enrichment is strictly input-workspace-driven — no facts for workspaceRoot-less calls", async (t) => {
  const repo = initTempRepo();
  let resolverCalls = 0;
  const provider = await createWorkflowGuardMcpProvider({
    workspace: repo,
    facts: async (workspaceRoot) => {
      resolverCalls += 1;
      return createGuardFactsResolver({ homeDir: mkdtempSync(join(tmpdir(), "workflow-w090-spyhome-")) })(workspaceRoot);
    },
  });
  t.after(() => provider.close());
  // The hub shape (provider carries `workspace`), but the call carries no
  // workspaceRoot (the containment seat's shape): enriching it from the
  // provider workspace would bind branch facts to the hub root while
  // executing in a per-call cwd — the removed vector. The resolver must not
  // be consulted at all.
  const decision = await provider.guardCheck({ action: "shell", command: "echo hi" });
  assert.equal(decision.decision, "allow");
  assert.equal(resolverCalls, 0);
});

test("W090: with a live runtime config present, project drafts classify as T2 (the designed flip)", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "workflow-w090-t2-"));
  const homeWithRoot = mkdtempSync(join(tmpdir(), "workflow-w090-t2home-"));
  mkdirSync(join(homeWithRoot, ".config", "opencode"), { recursive: true });
  const homeWithoutRoot = mkdtempSync(join(tmpdir(), "workflow-w090-t2bare-"));

  const withRoot = await createWorkflowGuardMcpProvider({
    facts: createGuardFactsResolver({ homeDir: homeWithRoot }),
  });
  const withoutRoot = await createWorkflowGuardMcpProvider({
    facts: createGuardFactsResolver({ homeDir: homeWithoutRoot }),
  });
  t.after(() => withRoot.close());
  t.after(() => withoutRoot.close());

  const tool = ["open", "code"].join("");
  // Legacy segment mode (no usable live-root fact): the draft write is tamper.
  const without = await withoutRoot.guardCheck({ action: "file_write", path: `.${tool}/agents/x.md`, workspaceRoot: repo, content: "x" });
  assert.equal(without.decision, "deny");
  assert.equal(without.policy, "guard-tamper");
  // Fact mode (a usable runtime-config root declared): the same draft is T2.
  const withFacts = await withRoot.guardCheck({ action: "file_write", path: `.${tool}/agents/x.md`, workspaceRoot: repo, content: "x" });
  assert.equal(withFacts.decision, "allow");
});
