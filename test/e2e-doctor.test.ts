import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The `workflow doctor` e2e (TSX lane) — W143. W076's verb driven the way an
 * operator actually runs it (`node --import tsx src/cli/workflow.ts doctor`
 * from the repo root), with every state read/write confined to a directed
 * mkdtemp HOME so nothing touches the operator's real state (the W128
 * e2e conventions, e.g. test/e2e-packaged-seat.test.ts:45-57).
 *
 * What this file goes DEEPER than (never duplicating):
 *   - test/webapp-bundle-dist.test.ts W125 pins the COMPILED dispatcher
 *     (`node dist/cli/workflow.js doctor`) only loosely (banner + exit 0|1);
 *   - test/compiled-bins-smoke.test.ts W126 explicitly does NOT re-cover the
 *     dispatcher+doctor ("is W125's smoke and is not re-covered here") and its
 *     only doctor row is the `doctor --help` usage contract (line 364);
 *   - test/e2e-packaged-seat.test.ts W128 pins the PACKAGED bin's doctor
 *     loosely (stdout banner, exit 0|1 are both honest);
 *   - test/doctor.test.ts and test/probe-verdict-register.test.ts pin the
 *     checks IN-PROCESS (imported functions, injected fetch/home seams).
 *   None of them drives the SOURCE-lane verb end to end and pins the rendered
 *   per-check sections, the register tally, the armed-gate clause, or the
 *   per-condition exit codes — that is this file's seat.
 *
 * Grounding (read before pinning, LESS-0054 observe-first): the verb dispatch
 * and its exit rule (src/cli/workflow.ts:124-131 — exit 1 only when a check
 * has status "fail", warns are expected states); the check implementations
 * (src/cli/doctor.ts:60-348); the register loader's fail-closed discipline and
 * its module-derived package-root seat (src/integrations/probe-verdicts.ts:76-83
 * and 179-197); the real register this repo ships
 * (docs/PROBE_VERDICTS.json); doctor's origin (TASKS.md W076). Every pin
 * below was OBSERVED first via the exact invocation recorded per test; the
 * register tally and fleet expectations are DERIVED from the repo's own
 * register/manifest files at runtime (both are durable committed records), so
 * the pins stay honest when those append-only files grow.
 *
 * FINDINGS recorded (observed, NOT fixed — this file only reports):
 *   F-1  The register seat is NOT reachable from the CLI: checkProbeVerdicts
 *        is called with no options (src/cli/doctor.ts:344) and resolves its
 *        root from the doctor module's own location
 *        (probeVerdictsPackageRoot, probe-verdicts.ts:76-78), so neither
 *        HOME, cwd, nor --cwd can redirect it, and runDoctor never forwards
 *        DoctorOptions.root to it (only checkFleetPayload gets root). The
 *        corrupt-register fail-closed shape is therefore pinned at the
 *        programmatic seat (a tsx child importing src/cli/doctor.ts), while
 *        the CLI-side proof that the seat IS the repo register is the tally
 *        match below (test 2's detail derives from docs/PROBE_VERDICTS.json
 *        and matches the CLI rendering byte for byte).
 *   F-2  The armed-gate count counts REGISTER ROWS, not distinct gates: the
 *        report says "N gate(s) armed now" where N is
 *        `verdicts.filter(env[gate] === "1").length` (doctor.ts:225) while
 *        the named list is Set-deduped (doctor.ts:233). arming
 *        WORKFLOW_ACP_GOOSE_METERED alone — one gate named by TWO register
 *        rows (acp-goose-metered-openrouter green + acp-goose-metered-azure
 *        blocked) — renders "2 gate(s) armed now:
 *        WORKFLOW_ACP_GOOSE_METERED": two gates claimed, one gate named.
 *        Honest fix would count the deduped set; recorded, not fixed.
 *   F-3  Observed wording quirk (pinned verbatim, cosmetic): counts render
 *        as "1 agent prefs" / "1 servers" — plural noun with a singular
 *        count (doctor.ts:74 and :79's templates).
 *   F-4  The cline availability seam has no *_BIN override in
 *        listWebAgents — availability resolves the ambient `which cline`
 *        (cline-launch.ts:62-74), unlike opencode/goose which honor
 *        WORKFLOW_OPENCODE_BIN/WORKFLOW_GOOSE_BIN first (web-agents.ts:34-55).
 *        A directed cline-free seat therefore has to be crafted on the child
 *        PATH (test 3), and an operator's cline availability can never be
 *        driven from env alone.
 *
 * SAFETY CONTRACT (LESS-0051): no agent or PTY spawns; no build, install, or
 * network; the only network-shaped traffic is the doctor's own localhost
 * /health probes against http://127.0.0.1:1 (a dead loopback port that
 * refuses immediately — the same dead-port shape test/doctor.test.ts pins
 * through the injected fetch seam); every state write lands in a mkdtemp
 * tree; every spawn is a short-lived one-shot process (the doctor verb
 * always exits; spawnSync is safe for it) run through the TSX lane only
 * (`node --import tsx …src/cli/workflow.ts`, never dist, never npm run
 * build — a parallel wave owns the compiled seat this session).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = join(repoRoot, "src", "cli", "workflow.ts");
const REGISTER_PATH = join(repoRoot, "docs", "PROBE_VERDICTS.json");
const MANIFEST_PATH = join(repoRoot, "assets", "opencode-fleet", "manifest.json");
const FLEET_ASSETS = join(repoRoot, "assets", "opencode-fleet");

interface RegisterRecord {
  readonly id: string;
  readonly gate: string;
  readonly result: string;
}

interface ProbeVerdictsFile {
  readonly version: number;
  readonly updated: string;
  readonly verdicts: readonly RegisterRecord[];
}

interface FleetManifestFile {
  readonly version: number;
  readonly entries: readonly {
    readonly id: string;
    readonly kind: "agent" | "command" | "doc";
    readonly file: string;
    readonly sha256: string;
  }[];
}

const register = JSON.parse(readFileSync(REGISTER_PATH, "utf8")) as ProbeVerdictsFile;
const fleetManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as FleetManifestFile;

/** Every gate the register names — deleted from each child's env so the
 * "no gates armed" pins cannot be skewed by an ambient operator gate. */
const REGISTER_GATES = [...new Set(register.verdicts.map((verdict) => verdict.gate))];

/** The doctor's availability seams and credential sources: deleted first so
 * a provisioned variant can then set exactly what it pins, and an uninstalled
 * variant observes no ambient credential. WORKFLOW_OPENCODE_SERVER_HOME is
 * the topology check's env seam (doctor.ts:143) and must never leak the
 * operator's discovery seat into a scoped run. */
const STRIPPED_ENV_KEYS = [
  "WORKFLOW_UPSTREAM_KEY",
  "CLINE_API_KEY",
  "AZURE_FOUNDRY_ENDPOINT",
  "AZURE_FOUNDRY_API_KEY",
  "AZURE_FOUNDRY_MODEL",
  "WORKFLOW_GOOSE_PROVIDER",
  "WORKFLOW_GOOSE_MODEL",
  "GOOSE_MODEL",
  "WORKFLOW_OPENCODE_BIN",
  "WORKFLOW_GOOSE_BIN",
  "WORKFLOW_CLINE_BIN",
  "WORKFLOW_OPENCODE_SERVER_HOME",
  ...REGISTER_GATES,
];

const tally = { green: 0, red: 0, negative: 0, pending: 0, blocked: 0 } as Record<string, number>;
for (const verdict of register.verdicts) tally[verdict.result] = (tally[verdict.result] ?? 0) + 1;
const openVerdicts = register.verdicts.filter((verdict) => verdict.result === "pending" || verdict.result === "blocked");
const blockedCount = register.verdicts.filter((verdict) => verdict.result === "blocked").length;

/** The register detail line the doctor must render (doctor.ts:231-233),
 * derived from the repo's register file — appended rows flow through. */
function registerDetail(armedGates: readonly string[]): string {
  const armedRows = armedGates.length === 0
    ? []
    : register.verdicts.filter((verdict) => armedGates.includes(verdict.gate));
  const armedNames = [...new Set(armedRows.map((verdict) => verdict.gate))];
  const armedClause = armedRows.length === 0
    ? "no gates armed"
    : `${armedRows.length} gate(s) armed now: ${armedNames.join(", ")}`;
  return `${register.verdicts.length} verdicts — ${tally.green} green, ${tally.red} red, ${tally.negative} negative, ${tally.pending} pending, ${tally.blocked} blocked; ${armedClause}` +
    " — register: docs/PROBE_VERDICTS.json; dated write-ups: docs/HOST_ADAPTERS.md";
}

const REGISTER_FIX = "pending rows: run a gated probe with WORKFLOW_<GATE>=1 node --import tsx --test test/<probe>.test.ts; blocked rows: the missing operator environment/credential is named in the register row's blocker — record every dated verdict in docs/PROBE_VERDICTS.json and docs/HOST_ADAPTERS.md" +
  ` (${openVerdicts.length} still open: ${openVerdicts.slice(0, 4).map((verdict) => verdict.id).join(", ")}${openVerdicts.length > 4 ? ", …" : ""}` +
  `; ${blockedCount} blocked on the operator environment)`;

interface DoctorRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

/** Runs the doctor verb through the TSX lane with a directed HOME (and an
 * optional directed workspace via the launcher's own --cwd seam,
 * src/cli/workflow.ts:86 + src/cli/tui-args.ts:3-8). The child inherits the
 * ambient env minus the stripped keys, plus the caller's additions. */
function runDoctor(input: { home: string; workspace?: string; set?: Readonly<Record<string, string>> }): DoctorRun {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: input.home };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(input.set ?? {})) env[key] = value;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI_ENTRY, "doctor", ...(input.workspace === undefined ? [] : ["--cwd", input.workspace])],
    { cwd: repoRoot, env, encoding: "utf8", timeout: 120_000 },
  );
  assertSpawnHonest(result, "workflow doctor");
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** The spawn-honesty asserts every run shares: a clean spawn and a self-exit
 * (never a signal, never a timeout kill) with one of the doctor's honest
 * exits (0 = pass/warn rows only; 1 = at least one fail row; anything else
 * is a crash of the source lane). */
function assertSpawnHonest(result: SpawnSyncReturns<string>, label: string): void {
  assert.equal(result.error, undefined, `${label}: spawned cleanly (${result.error?.message ?? "no spawn error"})`);
  assert.equal(result.signal, null, `${label}: exits by itself, not killed by ${result.signal}`);
  assert.ok(
    result.status === 0 || result.status === 1,
    `${label}: exit ${result.status} — the doctor's honest exits are 0 (pass/warn) and 1 (fail rows); anything else is a crash. stdout: ${result.stdout.slice(0, 400)} stderr: ${result.stderr.slice(0, 400)}`,
  );
}

/** Asserts the expected report lines appear in ORDER (each needle found after
 * the previous one), with the observed stdout in the failure message. */
function assertReportOrder(stdout: string, needles: readonly string[]): void {
  let index = 0;
  for (const needle of needles) {
    const at = stdout.indexOf(needle, index);
    assert.ok(
      at !== -1,
      `expected report row after position ${index}: ${needle}\n--- observed stdout ---\n${stdout}`,
    );
    index = at + needle.length;
  }
}

/** A directed tree: one mkdtemp root holding a `home/` (the redirected HOME)
 * and a `workspace/` (the --cwd target) — nothing outside it is read for
 * state or written to. Fully provisioned means: the vendored fleet payload
 * copied byte-identical into the host config dirs and the workspace docs
 * (so compareFleet sees 15/15 current), fake agent binaries for the three
 * availability seams, and an executable `cline` on the child's PATH (the
 * cline availability check resolves the ambient `which cline`, unlike
 * opencode/goose which honor their *_BIN overrides — web-agents.ts:34-55,
 * cline-launch.ts:62-74). */
function doctorTree(context: test.TestContext, provisioned: boolean): { home: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "doctor-e2e-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  if (provisioned) {
    const agentsDir = join(home, ".config", "opencode", "agents");
    const commandsDir = join(home, ".config", "opencode", "commands");
    const docsDir = join(workspace, "docs", "agents");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(commandsDir, { recursive: true });
    mkdirSync(docsDir, { recursive: true });
    for (const entry of fleetManifest.entries) {
      const sourceDir = entry.kind === "agent" ? "agents" : entry.kind === "command" ? "commands" : "docs";
      const target = entry.kind === "agent" ? agentsDir : entry.kind === "command" ? commandsDir : docsDir;
      copyFileSync(join(FLEET_ASSETS, sourceDir, entry.file), join(target, entry.file));
    }
    writeFileSync(join(home, "fake-opencode"), "");
    writeFileSync(join(home, "fake-goose"), "");
    mkdirSync(join(home, "pathbin"), { recursive: true });
    writeFileSync(join(home, "pathbin", "cline"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { home, workspace };
}

/** The env additions that make the three agent-credential checks observe a
 * provisioned machine: the *_BIN overrides point at the fake binaries (the
 * opencode/goose presence seams) and the canonical upstream key env satisfies
 * every credential-presence read (upstream-key.ts:21). The fake cline rides
 * the child's PATH instead (F-4: cline has no *_BIN availability seam in
 * listWebAgents). */
function provisionedEnv(tree: { home: string }): Readonly<Record<string, string>> {
  return {
    PATH: `${join(tree.home, "pathbin")}:${process.env.PATH ?? ""}`,
    WORKFLOW_OPENCODE_BIN: join(tree.home, "fake-opencode"),
    WORKFLOW_GOOSE_BIN: join(tree.home, "fake-goose"),
    WORKFLOW_UPSTREAM_KEY: "doctor-e2e-dummy-key",
  };
}

test("doctor e2e (TSX lane): the honest uninstalled shape against a directed empty HOME — every section pinned, exit 1", (context) => {
  // The exact invocation (home/workspace are per-run mkdtemp trees):
  //   node --import tsx src/cli/workflow.ts doctor --cwd <mkdtemp-workspace>
  // with HOME=<mkdtemp-home> and every credential seam stripped. Observed
  // 2026-09-25; the only machine-dependent row is containment (pinned to its
  // three honest shapes, never a specific status).
  const tree = doctorTree(context, false);
  const run = runDoctor({ home: tree.home, workspace: tree.workspace });
  assert.equal(run.status, 1, "the uninstalled doctor exits 1: the fleet payload is a fail row on a fresh home");
  assert.equal(run.stderr, "", "the honest report is stdout's alone — no error output");
  assert.ok(run.stdout.startsWith("Workflow doctor — the local setup, stated honestly:\n\n"),
    "the report opens with the rendered header (doctor.ts:352)");

  // The empty-HOME settings row: honest "not created yet" pass, path named.
  assert.ok(run.stdout.includes(
    `  ✓ settings documents: no global settings yet (created on first write) — ${join(tree.home, ".config", "workflow", "settings.json")}\n`,
  ), run.stdout);

  // The three agent-credential rows: fail with the reason as BOTH the detail
  // and the fix (observed: the fix line repeats the reason verbatim), never
  // a credential value (the reasons name file/env seams only).
  const opencodeReason = "needs the opencode binary and an OpenRouter key (CLINE_API_KEY, ~/.config/workflow/cline-api-key, or ~/.local/share/opencode/auth.json)";
  const gooseReason = "needs the goose binary (aaif-goose/goose or WORKFLOW_GOOSE_BIN) and provider credentials (OpenRouter upstream key CLINE_API_KEY or ~/.config/workflow/cline-api-key, or AZURE_FOUNDRY_ENDPOINT + AZURE_FOUNDRY_API_KEY + model via WORKFLOW_GOOSE_MODEL/GOOSE_MODEL/AZURE_FOUNDRY_MODEL)";
  const clineReason = "needs the cline binary and CLINE_API_KEY (or ~/.config/workflow/cline-api-key)";
  assertReportOrder(run.stdout, [
    `  ✗ agent credentials: OpenCode: OpenCode unavailable — ${opencodeReason}`,
    `      fix: ${opencodeReason}`,
    `  ✗ agent credentials: Goose: Goose unavailable — ${gooseReason}`,
    `      fix: ${gooseReason}`,
    `  ✗ agent credentials: Cline: Cline unavailable — ${clineReason}`,
    `      fix: ${clineReason}`,
  ]);

  // Hub: the fresh-home warn (no discovery file), fix names the remedy.
  assertReportOrder(run.stdout, [
    "  ! hub daemon: no hub discovery file — scheduled runs and run gates need the hub daemon (`workflow hub`)",
    "      fix: start the hub daemon: workflow hub",
  ]);

  // Topology: the warn names the directed workspace (--cwd), never cwd.
  assertReportOrder(run.stdout, [
    `  ! server topology gateway: no topology daemon for this workspace (${tree.workspace}) — the stock web UI tab and live MCP/stats reads have nothing to answer`,
    "      fix: start it when you want the topology: workflow tui (or the hub, which owns the daemon)",
  ]);

  // Containment: machine-dependent by design — pass (bwrap at the compiled-in
  // path), linux-warn (missing bwrap), or the non-Linux policy-only passthrough.
  assert.ok(
    run.stdout.includes("  ✓ containment backend: bubblewrap present at /usr/bin/bwrap — contained launches run the enforced filesystem boundary") ||
    run.stdout.includes("  ! containment backend: linux is enforced-capable, but bwrap was not found at /usr/bin/bwrap — contained agent launches will fail closed at spawn") ||
    / {2}! containment backend: no process isolation on .+ — launches run with policy gating only/.test(run.stdout),
    `containment row must state one of its three honest shapes — stdout: ${run.stdout}`,
  );

  // Register: the repo register's tally, derived from docs/PROBE_VERDICTS.json
  // and matched byte for byte — this is also the CLI-side proof that the
  // register seat is the repo file (F-1's observational half).
  const expectedRegisterRow = `  ${openVerdicts.length > 0 ? "!" : "✓"} probe verdict register: ${registerDetail([])}\n`;
  assert.ok(run.stdout.includes(expectedRegisterRow), `expected register row:\n${expectedRegisterRow}\n--- stdout ---\n${run.stdout}`);
  if (openVerdicts.length > 0) {
    assert.ok(run.stdout.includes(`      fix: ${REGISTER_FIX}\n`), `expected register fix line — stdout: ${run.stdout}`);
  }

  // Fleet: with an empty HOME and an empty workspace, EVERY manifest entry is
  // missing (agent/command under <home>/.config/opencode, docs under
  // <workspace>/docs/agents) — the honest "not installed" FAIL that makes the
  // run exit 1.
  const manifestIds = fleetManifest.entries.map((entry) => entry.id);
  const expectedFleetRow = `  ✗ fleet payload (agents · commands · docs): 0/${manifestIds.length} entries current — missing: ${manifestIds.join(", ")}\n`;
  assert.ok(run.stdout.includes(expectedFleetRow), `expected fleet row:\n${expectedFleetRow}\n--- stdout ---\n${run.stdout}`);
  const fleetFix = run.stdout.split("\n").find((line) => line.startsWith("      fix: workflow install fleet; or by hand: cp '"));
  assert.ok(fleetFix !== undefined, `the fleet fail must carry the two-way fix — stdout: ${run.stdout}`);
  assert.equal((fleetFix.match(/cp '/g) ?? []).length, manifestIds.length,
    "the fix carries one hand-install cp per manifest entry");
  // The empty-workspace shape has no "differs" rows: no --force qualifier on
  // the installer remedy and no repo-docs clause in the fix (both belong to
  // the drift branch — pinned deterministically in the drift test below;
  // earlier mis-pin, observed honestly: with an empty workspace NOTHING
  // differs, so the fix is just the installer + the hand cp list).
  assert.ok(!fleetFix.includes("--force"), `no differs rows -> no --force qualifier — fix: ${fleetFix}`);
  assert.ok(!fleetFix.includes("differing repo docs are NEVER overwritten"),
    `no differs rows -> no repo-docs clause — fix: ${fleetFix}`);
  const lastEntry = fleetManifest.entries[fleetManifest.entries.length - 1];
  assert.ok(lastEntry !== undefined && fleetFix.endsWith(`'${join(tree.workspace, "docs", "agents", lastEntry.file)}'`),
    `the fix ends with the last entry's hand cp — fix: ${fleetFix}`);

  // Guard posture: no host config in a fresh home — honest pass.
  assert.ok(run.stdout.includes(
    `  ✓ guard enforcement posture: no host config document at ${join(tree.home, ".config", "opencode", "opencode.jsonc")} — nothing to flag; hub-launched sessions carry the guard at launch, raw host launches are the operator's own surface\n`,
  ), run.stdout);

  // The report ends with a blank line (renderDoctorReport's trailing "").
  assert.ok(run.stdout.endsWith("\n\n"), `the report closes with a blank line — stdout tail: ${JSON.stringify(run.stdout.slice(-80))}`);
});

test("doctor e2e (TSX lane): the register rendering matches the repo register and renders armed gates honestly", (context) => {
  // Two spawns on an uninstalled tree (only the register row is at stake):
  // first THREE gates armed (two pending rows + one gate shared by a green
  // and a blocked row), then the SINGLE shared gate (F-2's row-count quirk).
  const tree = doctorTree(context, false);
  const armed = runDoctor({
    home: tree.home,
    workspace: tree.workspace,
    set: {
      WORKFLOW_ACP_OPENCODE_METERED: "1",
      WORKFLOW_ACP_OPENCODE_SKILLS: "1",
      WORKFLOW_ACP_GOOSE_METERED: "1",
    },
  });
  const expectedArmedRow = `  ! probe verdict register: ${registerDetail([
    "WORKFLOW_ACP_OPENCODE_METERED",
    "WORKFLOW_ACP_OPENCODE_SKILLS",
    "WORKFLOW_ACP_GOOSE_METERED",
  ])}\n`;
  assert.ok(armed.stdout.includes(expectedArmedRow),
    `expected armed register row (derived from the register file):\n${expectedArmedRow}\n--- stdout ---\n${armed.stdout}`);

  // F-2 observed: WORKFLOW_ACP_GOOSE_METERED is named by two register rows
  // (acp-goose-metered-openrouter green, acp-goose-metered-azure blocked), so
  // arming it renders "2 gate(s) armed now" while naming ONE gate. The pin is
  // the observed truth (LESS-0054); the finding is recorded in the header, not
  // fixed here.
  const shared = runDoctor({ home: tree.home, workspace: tree.workspace, set: { WORKFLOW_ACP_GOOSE_METERED: "1" } });
  const expectedSharedRow = `  ! probe verdict register: ${registerDetail(["WORKFLOW_ACP_GOOSE_METERED"])}\n`;
  assert.ok(shared.stdout.includes(expectedSharedRow),
    `expected the shared-gate quirk verbatim ("2 gate(s) armed now: WORKFLOW_ACP_GOOSE_METERED"):\n${expectedSharedRow}\n--- stdout ---\n${shared.stdout}`);
});

test("doctor e2e (TSX lane): a fully provisioned directed HOME renders every satisfiable check green and exits 0", (context) => {
  // Provisioned = fleet payload installed byte-identical (15/15 current),
  // fake agent binaries + the canonical upstream key env (all three
  // credential rows pass), no host config, no hub/topology state. Warns stay
  // honest (hub, topology, register) and do NOT fail the run — the exit-0
  // half of workflow.ts:129-131's rule.
  const tree = doctorTree(context, true);
  const run = runDoctor({ home: tree.home, workspace: tree.workspace, set: provisionedEnv(tree) });
  assert.equal(run.status, 0, `the provisioned doctor exits 0 — stdout: ${run.stdout}`);
  assert.equal(run.stderr, "", "no error output");
  assertReportOrder(run.stdout, [
    `  ✓ settings documents: no global settings yet (created on first write) — ${join(tree.home, ".config", "workflow", "settings.json")}`,
    "  ✓ agent credentials: OpenCode: OpenCode is available (advisory launch)",
    "  ✓ agent credentials: Goose: Goose is available (contained launch)",
    "  ✓ agent credentials: Cline: Cline is available (contained launch)",
    "  ! hub daemon: no hub discovery file",
    "  ! server topology gateway: no topology daemon for this workspace",
    `  ✓ fleet payload (agents · commands · docs): ${fleetManifest.entries.length}/${fleetManifest.entries.length} entries installed and matching the committed manifest`,
    `  ✓ guard enforcement posture: no host config document at ${join(tree.home, ".config", "opencode", "opencode.jsonc")}`,
  ]);
  const expectedRegisterRow = `  ${openVerdicts.length > 0 ? "!" : "✓"} probe verdict register: ${registerDetail([])}\n`;
  assert.ok(run.stdout.includes(expectedRegisterRow), `register row unchanged by provisioning — stdout: ${run.stdout}`);
});

test("doctor e2e (TSX lane): fleet payload drift is a warn with the never-overwrite fix, not a fail", (context) => {
  // Drift branch, deterministically: the provisioned tree's workspace doc is
  // edited (a write confined to the mkdtemp tree) -> that entry flips
  // current -> differs, the check WARNS (nothing missing), the installer
  // remedy carries NO --force qualifier (only agent/command diffs earn it —
  // doctor.ts:286), and the fix names the docs-never-overwritten honesty.
  // Warns are expected states, so the run still exits 0.
  const tree = doctorTree(context, true);
  const lessonsTarget = join(tree.workspace, "docs", "agents", "lessons.md");
  writeFileSync(lessonsTarget, "# doctor-e2e: a local edit the vendored copy does not carry\n");
  const run = runDoctor({ home: tree.home, workspace: tree.workspace, set: provisionedEnv(tree) });
  assert.equal(run.status, 0, `doc-only drift is a warn, never a fail — stdout: ${run.stdout}`);
  const expectedDriftRow = `  ! fleet payload (agents · commands · docs): ${fleetManifest.entries.length - 1}/${fleetManifest.entries.length} entries current — differs from the vendored version: doc:lessons (agents/commands: a local edit or an older copy; docs: repo-owned living files)\n`;
  assert.ok(run.stdout.includes(expectedDriftRow),
    `expected drift row:\n${expectedDriftRow}\n--- stdout ---\n${run.stdout}`);
  const fleetFix = run.stdout.split("\n").find((line) => line.startsWith("      fix: workflow install fleet"));
  assert.ok(fleetFix !== undefined, `the drift warn carries the remedy — stdout: ${run.stdout}`);
  assert.equal(fleetFix, "      fix: workflow install fleet; differing repo docs are NEVER overwritten by the installer — reconcile them by hand",
    `doc-only drift: no --force, and the docs honesty is the fix's second clause — fix: ${fleetFix}`);
});

test("doctor e2e (TSX lane): unparseable settings fail the settings row and flip the exit to 1", (context) => {
  // Same provisioned tree, plus one corrupt global settings document: the
  // settings row alone flips the exit 0 -> 1 (attribution via the
  // provisioned baseline above).
  const tree = doctorTree(context, true);
  mkdirSync(join(tree.home, ".config", "workflow"), { recursive: true });
  writeFileSync(join(tree.home, ".config", "workflow", "settings.json"), "{not json");
  const run = runDoctor({ home: tree.home, workspace: tree.workspace, set: provisionedEnv(tree) });
  assert.equal(run.status, 1, `corrupt settings alone must flip the exit to 1 — stdout: ${run.stdout}`);
  assertReportOrder(run.stdout, [
    "  ✗ settings documents: settings documents do not parse:",
    "      fix: fix the JSON in ~/.config/workflow/settings.json (or the workspace overlay) — the control plane fails closed on unparseable settings",
  ]);
  // The credentials stayed provisioned; ONLY the settings row failed.
  assert.ok(run.stdout.includes("  ✓ agent credentials: OpenCode: OpenCode is available (advisory launch)"), run.stdout);
});

test("doctor e2e (TSX lane): crafted global + workspace overlay settings render the parse detail", (context) => {
  // The workspace overlay rides the --cwd seam: <workspace>/.workflow/
  // settings.json (settingsPaths, workflow-settings.ts:190-196). Both scopes
  // parse -> the detail names both documents with their counts (F-3: the
  // singular-vs-plural wording is pinned verbatim as observed).
  const tree = doctorTree(context, true);
  mkdirSync(join(tree.home, ".config", "workflow"), { recursive: true });
  writeFileSync(join(tree.home, ".config", "workflow", "settings.json"), JSON.stringify({
    version: 1,
    mcpServers: [
      { name: "guard", enabled: true, transport: "stdio", command: "node", args: ["x"] },
      { name: "tools", enabled: false, transport: "stdio", command: "node" },
    ],
    agents: { opencode: { model: "doctor-e2e-model", autoCompact: true } },
  }));
  mkdirSync(join(tree.workspace, ".workflow"), { recursive: true });
  writeFileSync(join(tree.workspace, ".workflow", "settings.json"), JSON.stringify({
    version: 1,
    mcpServers: [{ name: "guard", enabled: false, transport: "stdio", command: "node" }],
    agents: { goose: { model: "doctor-e2e-goose", mode: "ask" } },
  }));
  const run = runDoctor({ home: tree.home, workspace: tree.workspace, set: provisionedEnv(tree) });
  assert.equal(run.status, 0, `parsed settings do not fail the run — stdout: ${run.stdout}`);
  assert.ok(run.stdout.includes(
    `  ✓ settings documents: global parses (2 mcp servers, 1 agent prefs) at ${join(tree.home, ".config", "workflow", "settings.json")}; workspace overlay parses (1 servers, 1 agent prefs)\n`,
  ), run.stdout);
});

test("doctor e2e (TSX lane): stale hub discovery fails the hub row and flips the exit to 1", (context) => {
  // A discovery file under the directed HOME pointing at a dead LOOPBACK port
  // (127.0.0.1:1 — refused immediately, no network): the hub row goes fail
  // with the endpoint named and the stale-file remedy. This is the real
  // fetch path (no fetchImpl seam exists in the CLI) — observed instantly.
  const tree = doctorTree(context, true);
  mkdirSync(join(tree.home, ".workflow", "hub"), { recursive: true });
  writeFileSync(join(tree.home, ".workflow", "hub", "discovery.json"), JSON.stringify({
    hubId: "doctor-e2e-hub",
    endpoint: "http://127.0.0.1:1",
    token: "doctor-e2e-token",
  }));
  const run = runDoctor({ home: tree.home, workspace: tree.workspace, set: provisionedEnv(tree) });
  assert.equal(run.status, 1, `the stale hub row alone must flip the exit to 1 — stdout: ${run.stdout}`);
  assertReportOrder(run.stdout, [
    "  ✗ hub daemon: stale hub discovery at http://127.0.0.1:1 — nothing answered /health",
    "      fix: delete the stale discovery file (~/.workflow/hub/discovery.json) and start the hub daemon: workflow hub",
  ]);
});

test("doctor e2e (TSX lane): stale topology discovery fails the topology row and flips the exit to 1", (context) => {
  // The topology discovery file is keyed per workspace under the directed
  // HOME (opencodeServerDiscoveryPath = <home>/.workflow/opencode-server/
  // ws-<sha256(workspace).slice(0,12)>.json); a stale gateway on the dead
  // loopback port is a fail row naming the gateway URL.
  const tree = doctorTree(context, true);
  const tag = `ws-${createHash("sha256").update(tree.workspace).digest("hex").slice(0, 12)}`;
  const stateHome = join(tree.home, ".workflow", "opencode-server");
  mkdirSync(stateHome, { recursive: true });
  writeFileSync(join(stateHome, `${tag}.json`), JSON.stringify({
    protocol: 1,
    pid: 4242,
    workspace: tree.workspace,
    gatewayUrl: "http://127.0.0.1:1",
    tuiUsername: "tui",
    tuiPassword: "doctor-e2e-pw",
  }));
  const run = runDoctor({ home: tree.home, workspace: tree.workspace, set: provisionedEnv(tree) });
  assert.equal(run.status, 1, `the stale topology row alone must flip the exit to 1 — stdout: ${run.stdout}`);
  assertReportOrder(run.stdout, [
    "  ✗ server topology gateway: stale topology discovery at http://127.0.0.1:1 — nothing answered",
    "      fix: the daemon exited; restart it (workflow tui) or delete the stale discovery file under ~/.workflow/opencode-server",
  ]);
});

test("doctor e2e (TSX lane): a workflow-guard plugins entry warns the posture row without failing the run", (context) => {
  // The host config document under the directed HOME registers the old
  // plugin posture -> warn + the operator-edit fix, and the run still exits 0
  // (warns are expected states — workflow.ts:129-131).
  const tree = doctorTree(context, true);
  mkdirSync(join(tree.home, ".config", "opencode"), { recursive: true });
  writeFileSync(join(tree.home, ".config", "opencode", "opencode.jsonc"), "{\n  \"model\": \"doctor-e2e\",\n  \"plugins\": [\"workflow-guard-mcp\"]\n}\n");
  const run = runDoctor({ home: tree.home, workspace: tree.workspace, set: provisionedEnv(tree) });
  assert.equal(run.status, 0, `the posture warn must not fail the run — stdout: ${run.stdout}`);
  assertReportOrder(run.stdout, [
    "  ! guard enforcement posture: the host config still registers the workflow-guard plugin (\"plugins\": [\"workflow-guard-mcp\"]); the control-plane aim is plugin-free enforcement at launch, and raw-launch parity is not yet probe-verified",
    "      fix: once the plugin-parity probe records its verdict (docs/PROBE_VERDICTS.json + docs/HOST_ADAPTERS.md), remove the plugins entry — an operator edit in the host config; the control plane never rewrites that file",
  ]);
});

test("doctor e2e (TSX lane): the corrupt register seat is unreachable from the CLI — the fail-closed path is pinned at the programmatic seat (tsx child)", (context) => {
  // F-1: through the CLI verb the register seat resolves from the doctor
  // module's package root (probe-verdicts.ts:76-83) — HOME/cwd/--cwd cannot
  // point it elsewhere, and runDoctor (doctor.ts:344) passes no root. The
  // fail-closed shapes ARE reachable programmatically: a tsx child imports
  // src/cli/doctor.ts with a crafted package root and pins what the check
  // (and its rendered fix) do on (a) malformed JSON and (b) a MISSING
  // register — both must be loud fails, never an empty list or a silent
  // pass. The child mirrors the CLI's own exit rule (workflow.ts:131) so the
  // fail-loud exit is exercised too.
  const root = mkdtempSync(join(tmpdir(), "doctor-e2e-register-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const driverPath = join(root, "render-register.mjs");
  writeFileSync(driverPath, [
    "const { checkProbeVerdicts } = await import(\"" + join(repoRoot, "src", "cli", "doctor.ts") + "\");",
    "const check = checkProbeVerdicts({ root: process.argv[2] });",
    "console.log(JSON.stringify({ status: check.status, detail: check.detail, fix: check.fix ?? null }));",
    "process.exitCode = check.status === \"fail\" ? 1 : 0;",
    "",
  ].join("\n"));

  const child = (registerRoot: string): { stdout: string; stderr: string; status: number | null } => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.WORKFLOW_OPENCODE_SERVER_HOME;
    const result = spawnSync(process.execPath, ["--import", "tsx", driverPath, registerRoot], {
      cwd: repoRoot, env, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(result.error, undefined, `tsx child spawned cleanly (${result.error?.message ?? "no spawn error"})`);
    assert.equal(result.signal, null, "the tsx child exits by itself");
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  };

  // (a) Malformed JSON: fail-closed with the parse error surfaced and the
  // repair named — the loud failure the CLI can never show (F-1).
  const corrupt = mkdtempSync(join(tmpdir(), "doctor-e2e-corrupt-"));
  context.after(() => rmSync(corrupt, { recursive: true, force: true }));
  mkdirSync(join(corrupt, "docs"), { recursive: true });
  writeFileSync(join(corrupt, "docs", "PROBE_VERDICTS.json"), "{not json");
  const corruptRun = child(corrupt);
  assert.equal(corruptRun.status, 1, "the corrupt register must exit 1 (fail-closed), not 0");
  const corruptParsed = JSON.parse(corruptRun.stdout) as { status: string; detail: string; fix: string | null };
  assert.equal(corruptParsed.status, "fail");
  assert.match(corruptParsed.detail, /^the probe verdict register failed validation \(fail-closed\): invalid probe verdict register: /,
    `the parse error is surfaced verbatim — detail: ${corruptParsed.detail}`);
  assert.equal(corruptParsed.fix, "repair docs/PROBE_VERDICTS.json — version 1, one dated row per gate (host/version, probe file, gate, result, posture, evidence); probe files and cited evidence must exist");
  assert.equal(corruptRun.stderr, "", "the fail is rendered, not a thrown stack");

  // (b) Missing register (ENOENT): also a loud fail — a missing register is
  // drift, never an empty gate list.
  const absent = mkdtempSync(join(tmpdir(), "doctor-e2e-absent-"));
  context.after(() => rmSync(absent, { recursive: true, force: true }));
  mkdirSync(join(absent, "docs"), { recursive: true });
  const absentRun = child(absent);
  assert.equal(absentRun.status, 1, "the missing register must exit 1 (fail-closed), not 0");
  const absentParsed = JSON.parse(absentRun.stdout) as { status: string; detail: string; fix: string | null };
  assert.equal(absentParsed.status, "fail");
  assert.match(absentParsed.detail, /^the probe verdict register failed validation \(fail-closed\): cannot read the probe verdict register at /,
    `the ENOENT is surfaced verbatim — detail: ${absentParsed.detail}`);
  assert.match(absentParsed.detail, /ENOENT: no such file or directory/);
  assert.equal(absentParsed.fix, "repair docs/PROBE_VERDICTS.json — version 1, one dated row per gate (host/version, probe file, gate, result, posture, evidence); probe files and cited evidence must exist");
});
