# One-command install + launcher hub auto-spawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run setup` installs Workflow end-to-end; `workflow` self-starts the authority hub via a guarded detached spawn.

**Architecture:** A pure helper in `src/cli/hub-client.ts` resolves spawn candidates (`workflow-hub` on PATH first, `<pkgRoot>/dist/cli/hub.js` fallback) and race-guards spawning with a `spawn.lock` file. `resolveWorkflowHub` keeps its signature; auto-spawn happens only on missing/stale discovery and can be disabled with `WORKFLOW_AUTOHUB=0`. Installer is `scripts/install.mjs` run via the npm `setup` script.

**Tech Stack:** Node 22, node:test, TypeScript (tsx), npm scripts, pnpm (toolbox).

---

### Task 1: Spawn candidate + lock helpers in hub-client

**Files:**
- Modify: `src/cli/hub-client.ts`
- Test: `test/hub-client.test.ts`

- [ ] **Step 1: Write failing tests for both helpers**

Append to `test/hub-client.test.ts` (imports extended as needed):

```ts
import { resolveHubSpawnCandidates } from "../src/cli/hub-client.js";

test("resolveHubSpawnCandidates prefers workflow-hub on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  try {
    writeFileSync(join(dir, "workflow-hub"), "#!/bin/sh\nexit 0\n");
    const candidates = resolveHubSpawnCandidates({ PATH: dir });
    assert.equal(candidates[0].cmd, join(dir, "workflow-hub"));
    assert.deepEqual(candidates[0].args, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHubSpawnCandidates falls back to pkgRoot dist hub", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  try {
    mkdirSync(join(dir, "dist", "cli"), { recursive: true });
    writeFileSync(join(dir, "dist", "cli", "hub.js"), "");
    const candidates = resolveHubSpawnCandidates({ PATH: "" }, dir);
    assert.ok(candidates.some((c) => c.cmd === process.execPath && c.args[0] === join(dir, "dist", "cli", "hub.js")));
    assert.equal(candidates.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/hub-client.test.ts`
Expected: FAIL — `resolveHubSpawnCandidates` not exported.

- [ ] **Step 3: Implement the helpers**

In `src/cli/hub-client.ts` add imports `openSync, closeSync` from `node:fs`, `fileURLToPath` from `node:url`, `dirname` from `node:path`, and:

```ts
export interface SpawnCandidate {
  readonly cmd: string;
  readonly args: string[];
}

export function resolveHubSpawnCandidates(
  env: { PATH?: string },
  pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
): SpawnCandidate[] {
  const candidates: SpawnCandidate[] = [];
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir !== "" && existsSync(join(dir, "workflow-hub"))) {
      candidates.push({ cmd: join(dir, "workflow-hub"), args: [] });
      break;
    }
  }
  const distHub = resolve(pkgRoot, "dist", "cli", "hub.js");
  if (candidates.length === 0 && existsSync(distHub)) {
    candidates.push({ cmd: process.execPath, args: [distHub] });
  }
  return candidates;
}

/** Exclusive `wx` acquire; release closes fd + removes the lock file. */
export function acquireSpawnLock(lockPath: string): (() => void) | undefined {
  try {
    const fd = openSync(lockPath, "wx");
    return () => {
      try {
        closeSync(fd);
      } finally {
        rmSync(lockPath, { force: true });
      }
    };
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/hub-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/hub-client.ts test/hub-client.test.ts
git commit -m "feat(hub-client): spawn candidate resolution + exclusive spawn lock helpers"
```

---

### Task 2: Auto-spawn integration in resolveWorkflowHub

**Files:**
- Modify: `src/cli/hub-client.ts`
- Create: `test/fixtures/autohub-fake-hub.mjs`
- Test: `test/hub-client.test.ts`

- [ ] **Step 1: Write the failing integration tests + fixture**

Create `test/fixtures/autohub-fake-hub.mjs`:

```js
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const token = "t".repeat(64);
const server = createServer((request, response) => {
  if (request.url === "/health" && request.headers.authorization === `Bearer ${token}`) {
    response.statusCode = 200;
    response.end("ok");
    return;
  }
  response.statusCode = 400;
  response.end("bad");
});
server.listen(0, "127.0.0.1", () => {
  const discoveryPath = process.env.FAKE_HUB_DISCOVERY_PATH;
  const delay = Number(process.env.FAKE_HUB_DELAY_MS ?? 0);
  setTimeout(() => {
    mkdirSync(dirname(discoveryPath), { recursive: true });
    writeFileSync(
      discoveryPath,
      JSON.stringify({ hubId: "fake-hub", endpoint: `http://127.0.0.1:${server.address().port}`, token }),
    );
  }, delay);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
```

Add to `test/hub-client.test.ts` (imports extended: `spawn` from `node:child_process`, type `ChildProcess`):

```ts
// Update helper imports
import { resolveWorkflowHub, resolveHubSpawnCandidates, acquireSpawnLock } from "../src/cli/hub-client.js";
import { spawn, type ChildProcess } from "node:child_process";

test("resolveWorkflowHub auto-spawns a detached hub and returns it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "test", "fixtures", "autohub-fake-hub.mjs");
  const children: ChildProcess[] = [];
  const envKey = "FAKE_HUB_DISCOVERY_PATH";
  const original = process.env[envKey];
  process.env[envKey] = resolveHubDiscoveryPath(dir);
  t.after(() => {
    for (const child of children) child.kill("SIGTERM");
    if (original === undefined) delete process.env[envKey];
    else process.env[envKey] = original;
  });

  const resolved = await resolveWorkflowHub({
    discoveryDir: dir,
    spawnFn: (cmd, args, options) => {
      const child = spawn(cmd, args, options);
      children.push(child);
      return child;
    },
    spawnCandidates: [{ cmd: process.execPath, args: [fixture] }],
  });
  assert.equal(typeof resolved.url, "string");
  const discovery = readHubDiscovery(resolveHubDiscoveryPath(dir));
  assert.equal(discovery?.hubId, "fake-hub");
});

test("resolveWorkflowHub waits for another surface's spawn instead of double-spawning", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "test", "fixtures", "autohub-fake-hub.mjs");
  const discoveryPath = resolveHubDiscoveryPath(dir);
  writeFileSync(`${discoveryPath}.spawn.lock`, "locked");
  const envOriginal = { discovery: process.env.FAKE_HUB_DISCOVERY_PATH, delay: process.env.FAKE_HUB_DELAY_MS };
  process.env.FAKE_HUB_DISCOVERY_PATH = discoveryPath;
  process.env.FAKE_HUB_DELAY_MS = "800";
  const otherSurface = spawn(process.execPath, [fixture], { detached: true, stdio: "ignore" });
  t.after(() => {
    otherSurface.kill("SIGTERM");
    if (envOriginal.discovery === undefined) delete process.env.FAKE_HUB_DISCOVERY_PATH;
    else process.env.FAKE_HUB_DISCOVERY_PATH = envOriginal.discovery;
    if (envOriginal.delay === undefined) delete process.env.FAKE_HUB_DELAY_MS;
    else process.env.FAKE_HUB_DELAY_MS = envOriginal.delay;
    rmSync(`${discoveryPath}.spawn.lock`, { force: true });
  });

  const resolved = await resolveWorkflowHub({
    discoveryDir: dir,
    spawnFn: () => { throw new Error("must not spawn"); },
    spawnCandidates: [{ cmd: "x", args: [] }],
    timeoutMs: 10_000,
  });
  assert.equal(typeof resolved.url, "string");
});

test("resolveWorkflowHub fails closed when spawn candidates are empty", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => resolveWorkflowHub({ discoveryDir: dir, spawnCandidates: [] }),
    /npm run hub.*workflow-hub/,
  );
});

test("resolveWorkflowHub without candidates leaves no spawn lock behind", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = resolveHubDiscoveryPath(dir) + ".spawn.lock";

  await assert.rejects(
    () => resolveWorkflowHub({ discoveryDir: dir, spawnCandidates: [{ cmd: "nonexistent-cmd-xyz", args: [] }] }),
  );
  assert.equal(existsSync(lockPath), false);
});

test("WORKFLOW_AUTOHUB=0 restores strict fail-fast without spawning", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = process.env.WORKFLOW_AUTOHUB;
  process.env.WORKFLOW_AUTOHUB = "0";
  t.after(() => {
    if (original === undefined) delete process.env.WORKFLOW_AUTOHUB;
    else process.env.WORKFLOW_AUTOHUB = original;
  });

  await assert.rejects(
    () => resolveWorkflowHub({
      discoveryDir: dir,
      spawnFn: () => { throw new Error("must not spawn"); },
      spawnCandidates: [{ cmd: "x", args: [] }],
    }),
    /npm run hub.*workflow-hub/,
  );
});
```

Adjust the two existing fail tests to pass `{ autohub: false }` explicitly so they stay deterministic in a checkout that has `dist/cli/hub.js` built:

```ts
await assert.rejects(() => resolveWorkflowHub({ discoveryDir: dir, autohub: false }), /npm run hub.*workflow-hub/);
```

- [ ] **Step 2: Run tests; auto-spawn tests fail (functionality missing)**

Run: `node --import tsx --test test/hub-client.test.ts`
Expected: FAIL for the new tests.

- [ ] **Step 3: Implement auto-spawn inside resolveWorkflowHub**

Replace `resolveWorkflowHub` in `src/cli/hub-client.ts` with the implementation below, keeping exported helpers:

```ts
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

// ... existing imports extend: node:url fileURLToPath, fs openSync/statSync/closeSync, path dirname

export interface WorkflowHubResolveOptions {
  readonly discoveryDir?: string;
  readonly autohub?: boolean;
  readonly spawnFn?: (cmd: string, args: string[], options: { detached: boolean; stdio: "ignore"[] }) => ChildProcess;
  readonly spawnCandidates?: SpawnCandidate[];
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

const NO_HUB_MESSAGE =
  "Workflow hub is not running; start the authority daemon with `npm run hub` (source checkout) or `workflow-hub` (installed) before launching a Cline surface";

function autohubEnabled(option: boolean | undefined): boolean {
  if (option !== undefined) return option;
  const env = process.env.WORKFLOW_AUTOHUB;
  return !(env === "0" || env === "false");
}

function resolveTimeout(option: number | undefined): number {
  if (option !== undefined) return option;
  const env = Number(process.env.WORKFLOW_AUTOHUB_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 15_000;
}

async function waitForHub(discoveryPath: string, deadline: number, poll: number): Promise<ResolvedHub | undefined> {
  while (Date.now() < deadline) {
    const discovery = readHubDiscovery(discoveryPath);
    if (discovery !== undefined && (await probeHub(discovery))) {
      return { url: discovery.endpoint, token: discovery.token };
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, poll));
  }
  return undefined;
}

export async function resolveWorkflowHub(
  options: WorkflowHubResolveOptions = {},
): Promise<ResolvedHub> {
  const dir = options.discoveryDir ?? resolve(homedir(), ".workflow");
  const discoveryPath = resolveHubDiscoveryPath(dir);
  const poll = options.pollIntervalMs ?? 250;
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const lockPath = `${discoveryPath}.spawn.lock`;

  const immediate = await waitForHub(discoveryPath, Date.now() + 1, 250);
  if (immediate !== undefined) return immediate;

  if (!autohubEnabled(options.autohub)) {
    rmSync(discoveryPath, { force: true });
    throw new Error(NO_HUB_MESSAGE);
  }

  const candidates = options.spawnCandidates ?? resolveHubSpawnCandidates(process.env);
  if (candidates.length === 0) {
    rmSync(discoveryPath, { force: true });
    throw new Error(NO_HUB_MESSAGE);
  }

  const releaseLock = acquireSpawnLock(lockPath);
  if (releaseLock === undefined) {
    // Another surface is spawning; just wait for its publication.
    const waited = await waitForHub(discoveryPath, deadline, poll);
    if (waited !== undefined) return waited;
    rmSync(discoveryPath, { force: true });
    throw new Error(NO_HUB_MESSAGE);
  }

  try {
    const spawnFn = options.spawnFn ?? nodeSpawn;
    const [candidate] = candidates;
    const child = spawnFn(candidate.cmd, candidate.args, { detached: true, stdio: ["ignore", "ignore", "ignore"] });
    child.on?.("error", () => undefined);
    child.unref?.();
    const resolved = await waitForHub(discoveryPath, deadline, poll);
    if (resolved !== undefined) return resolved;
    rmSync(discoveryPath, { force: true });
    throw new Error(`${NO_HUB_MESSAGE} (auto-spawn attempted via \`${candidate.cmd}\`)`);
  } finally {
    releaseLock();
  }
}
```

- [ ] **Step 4: Run the suite; all hub-client tests pass**

Run: `node --import tsx --test test/hub-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/hub-client.ts test/hub-client.test.ts test/fixtures/autohub-fake-hub.mjs
git commit -m "feat(hub-client): launcher auto-spawns detached workflow-hub with spawn lock"
```

---

### Task 3: One-command installer (`npm run setup`)

**Files:**
- Create: `scripts/install.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the installer**

Create `scripts/install.mjs`:

```js
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function step(label, command, args) {
  console.log(`setup: ${label}`);
  try {
    execFileSync(command, args, { cwd: root, stdio: "inherit" });
  } catch (error) {
    console.error(`setup: ${label} failed (${error instanceof Error ? error.message : error})`);
    process.exit(1);
  }
}

step("pnpm availability check", "pnpm", ["--version"]);
step("npm install", "npm", ["install"]);
step("build", "npm", ["run", "build"]);
step("toolbox install", "pnpm", ["--dir", "mcp-toolbox", "install"]);
step("toolbox build", "pnpm", ["--dir", "mcp-toolbox", "run", "build"]);
step("cline tui build", "node", ["scripts/build-cline-tui.mjs"]);
step("global install", "npm", ["install", "-g", "."]);

console.log("\nInstalled bins: workflow, workflow-hub, workflow-monitor, workflow-shell");
console.log("Run: workflow --cwd <path>  (the hub auto-starts; WORKFLOW_AUTOHUB=0 disables auto-start)");
```

Modify `package.json` — add a `setup` script (insert after `"pretest"`):

```json
"pretest": "node scripts/build-cline-tui.mjs",
"setup": "node scripts/install.mjs",
```

- [ ] **Step 2: Run the installer end-to-end**

Run: `npm run setup`
Expected: each step prints `setup: ...`, then the bins summary; `workflow-hub` on PATH.

- [ ] **Step 3: Verify a single-command launch**

Run: `workflow-hub` (return) — actually verify auto-spawn path: remove `~/.workflow/hub/discovery.json`, then `workflow --help` or launch `workflow-monitor` and confirm the discovery file reappears after the launcher resolves the hub.
Expected: hub self-starts; discovery refreshed.

- [ ] **Step 4: Commit**

```bash
git add scripts/install.mjs package.json
git commit -m "feat(setup): one-command installer (npm install, build, toolbox, cline, global link)"
```

---

### Task 4: Docs (README + HUB.md)

**Files:**
- Modify: `README.md`
- Modify: `docs/HUB.md`

- [ ] **Step 1: Update README Install + Quickstart**

Replace the Install code block in `README.md`:

```markdown
## Install

Requires Node 22+, pnpm (for mcp-toolbox), and (for containment) Linux with bubblewrap.

```sh
npm run setup   # npm install -> build -> toolbox -> vendored cline -> npm i -g .
```
```

Replace Quickstart:

```markdown
## Quickstart

```sh
workflow --cwd /path/to/project   # self-starts the authority hub
workflow-monitor                  # monitoring TUI over the live hub
workflow-shell                    # contained shell
```

The hub auto-starts the first time a surface resolves it and remains detached
for reuse. Set `WORKFLOW_AUTOHUB=0` or use `timeoutMs` (≤0) to restore strict
fail-fast resolution; you can still run the daemon manually with
`workflow-hub` (source checkout: `npm run hub`). An optional systemd user unit
lives at `packaging/workflow-hub.service` for fully-managed startup.
```

- [ ] **Step 2: Update HUB.md with the auto-spawn note**

In `docs/HUB.md`, under **Commands**, append:

```markdown
- Launchers (`workflow`) auto-spawn `workflow-hub` detached when the discovery
  file is missing/stale, guarded by `~/.workflow/hub/discovery.json.spawn.lock`.
  `WORKFLOW_AUTOHUB=0` restores strict fail-fast resolution.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/HUB.md
git commit -m "docs: one-command install + launcher auto-spawn runbook"
```

---

### Task 5: Verification gates + review

- [ ] **Step 1: Run all gates**

```bash
npm run lint
npm test
npm run typecheck
npm run build
```

Expected: all pass.

- [ ] **Step 2: Get the review rubric and run secondary review**

Run `guard_review_rubric --base origin/main`, then (per the repo's workflow-guard
procedure) spawn a reviewer subagent on the rubric's five axes (test integrity,
task completeness, cleanliness, security, platform) and record its verdict via
`record_review`. Fix any P0/P1 findings before closing.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: final verification for packaging autohub"
```

---

## Self-Review Checklist (run after writing)

- **Spec coverage:** Component 1 (installer) -> Task 3; Component 2 (auto-spawn)
  -> Tasks 1-2; Component 3 (docs) -> Task 4; verification -> Task 5.
- **Placeholders:** none — code is inline per task.
- **Type consistency:** `SpawnCandidate`, `WorkflowHubResolveOptions`,
  `resolveHubSpawnCandidates`, `acquireSpawnLock` names match across tasks.
