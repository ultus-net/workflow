# Pre-trust parsing audit — W051

**Audit date:** 2026-09-19
**Scope:** Workflow-owned startup and session-open paths in the TUI, browser launcher, hub, ACP runtimes, skills/toolbox delivery, instruction ingestion, and workspace scans.
**Incident class:** Anthropic's “everything before the trust dialog” class: project-local configuration, hooks, skills, or discovery inputs must not be parsed or executed before operator trust is established.

## Trust-state definitions

- **Post-trust:** the read occurs after the Workflow surface has been started by the operator and/or after a tool proposal has passed the Workflow authorization boundary.
- **Pre-trust-but-inert:** metadata or fixed operator/runtime state is read before an agent turn, but it cannot execute project-local content or add model-visible project content by itself.
- **Pre-trust-and-consequential:** project-local content is parsed, executed, mounted, or made model-visible before the trust boundary. No Workflow-owned path in this audit remains in this category.

## Inventory

| Surface / read path | Code reference | Input | Trust state | Finding / ordering evidence |
|---|---|---|---|---|
| TUI workspace argument resolution | `src/cli/tui-args.ts:3-9` | CLI argument string | Pre-trust-but-inert | Resolves a path only; it does not stat, enumerate, open, parse, or execute the workspace. |
| Universal TUI startup | `src/cli/universal-tui.tsx:18-50` | CLI/env and the selected workspace path | Pre-trust-but-inert | Builds the application and composes the selected driver. No workspace file is opened by Workflow before the driver boundary. |
| Stock ACP TUI startup | `src/cli/acp-tui.tsx:29-60` | CLI workspace path and hub/runtime state | Pre-trust-but-inert | Creates the canonical session task, then creates the contained ACP runtime. Workflow does not parse project-local files here. |
| Browser launcher/service | `src/cli/web-service.ts:34-72` | Workspace path, fixed seed tasks, generated web bundle | Pre-trust-but-inert | Constructs the application and loopback server. Project-local workspace content is not read during service startup. Agent runtime creation occurs only when a web session is requested. |
| Universal driver selection | `src/cli/driver-registry.ts:52-93` | Driver name and workspace path | Pre-trust-but-inert | Selects/composes a driver; no project-local config parser is invoked by Workflow. Authorization remains in the composed session. |
| Hub discovery and lock state | `src/cli/hub-client.ts:27-31`, `src/integrations/workflow-hub.ts:159-160` | `~/.workflow` discovery/lock files | Pre-trust-but-inert | Reads Workflow-owned operator state, not project-local input. Discovery JSON is transport metadata and is not used as executable configuration. |
| Hub scheduler and review provenance | `src/cli/hub.ts:106-145`, `src/integrations/hub-scheduler.ts:180-194`, `src/integrations/review-provenance-store.ts:48-61` | `~/.workflow` scheduler/provenance state | Pre-trust-but-inert | Reads hub-owned state. Records are validated/fail closed; no workspace instructions or hooks are executed during startup. |
| Toolbox discovery and persistent MCP settings | `src/cli/mcp-settings.ts` (deleted by W050 C3) | Vendored `mcp-toolbox/apps/*/dist/server.js` paths and `~/.workflow` MCP JSON | N/A | **Removed-by-W050.** The module and its test were retired with the patched-Cline TUI launcher (it had no remaining `src` consumer); the retained stock-ACP connector configures MCP independently (`src/adapters/acp-subprocess.ts`). The pre-trust-but-inert finding for this row no longer applies because the reader no longer exists. |
| Skills directory mount resolution | `src/integrations/acp-runtime.ts:548-562` | Explicit `SKILLS_MCP_DIR` or `~/.agents/skills`; built server existence | Pre-trust-but-inert | Checks configured operator skill state and prepares a read-only delivery mount. It does not open `SKILL.md`; `realpathSync` is used only for mount topology. The mount is not the workspace and is not executed by Workflow. |
| Skills-mcp process startup | `mcp-toolbox/apps/skills-mcp/src/server.ts:21-33`, `:136` | Skills directory path and environment | Pre-trust-but-inert | Server startup computes paths and registers tools but does not scan or parse skills. No project-local file is read until an explicit `list_skills` or `read_skill` tool call. |
| Skills discovery | `mcp-toolbox/apps/skills-mcp/src/server.ts:79-103`, `mcp-toolbox/apps/skills-mcp/src/skills.ts:37-57` | Configured skills directory `SKILL.md` metadata | Post-trust | Discovery happens in response to an explicit MCP tool call after the agent session exists; it is not startup/session-open parsing. Screening and level gating occur before delivery. |
| Skills content delivery | `mcp-toolbox/apps/skills-mcp/src/server.ts:118-132`, `mcp-toolbox/apps/skills-mcp/src/skills.ts:107-111` | One named `SKILL.md` | Post-trust | Content is read only for an explicit named tool call, with name validation, level enforcement, and screening. |
| Startup skills level-map parse | `src/cli/universal-tui.tsx:50`, `src/cli/ink-tui.tsx:141`, `src/pedagogy/skill-gating.ts:103-108` | Operator `levels.json` in `SKILLS_MCP_DIR` or `~/.agents/skills` | Pre-trust-but-inert | Parsed at startup via `resolveSkillsLevelMap`; validated as string arrays and fail-closed (a malformed map throws, refusing ungated startup). It configures required/unlocked skill *names* only — no skill content is read and nothing executes. If an operator points `SKILLS_MCP_DIR` at a workspace, the parsed file is workspace-local JSON, still inert by construction. Covered by an ordering test. |
| AGENTS.md / SKILL.md ingestion by Workflow | Repository-wide search; no Workflow reader exists | Project-local instruction files | Pre-trust-and-consequential | **Not present in Workflow-owned code.** Workflow does not ingest either file at startup/session-open. The files may be read by the selected stock agent; that is an external black-box behavior not controlled by this repository's parser. |
| Project-local agent config (`opencode.json`, `.claude/settings.json`, hooks, goose config) | `src/integrations/opencode-agent-config.ts:21-85`, `src/integrations/goose-agent-config.ts:179-198`, `src/integrations/acp-runtime.ts:141-205`, `:433-482` | Hub-generated per-runtime config | Pre-trust-but-inert | Workflow writes generated config under `~/.workflow/acp-home`, sets OpenCode `--pure`, and gives goose a hub-generated `GOOSE_PATH_ROOT`. It does not read project-local agent config. The selected external agent may independently inspect its workspace during its own startup; see residual risk below. |
| ACP filesystem reads and directory scans | `src/integrations/acp-session.ts:500-561` | Absolute path supplied in an ACP tool request | Post-trust | Authorization and guard checks complete before `readFile`/`readdir`; relative paths fail closed. This is a tool-call path, not startup parsing. |
| Workspace scans by toolbox servers | `mcp-toolbox/apps/*/src` | Workspace path supplied to a toolbox tool | Post-trust | Toolbox adapters are request-driven. Their workspace reads occur only after the MCP tool call reaches the running server; no toolbox app scans the workspace at module startup. |
| Persistent Workflow state | `src/application/persistence.ts:44-70`, `src/integrations/project-memory.ts` | Hub/operator state outside workspace | Pre-trust-but-inert | Reads are Workflow-owned state, not project-local instructions. Parsed records are validated and treated as untrusted assertions; no record is executed as code. |

## Consequential findings and disposition

No Workflow-owned pre-trust-and-consequential parse or execution was found. The existing ordering is safe for the owned paths: project-local filesystem access is behind ACP authorization (`src/integrations/acp-session.ts:518-558`), skills are lazy and request-driven (`mcp-toolbox/apps/skills-mcp/src/server.ts:79-96`), and generated agent configuration is written from Workflow-owned values rather than loaded from the workspace (`src/integrations/acp-runtime.ts:151-159`, `:433-443`).

The external-agent boundary remains a residual risk. OpenCode, goose, or the retained stock-ACP Cline connector can choose to inspect project-local files as part of their own process startup after Workflow launches them. Workflow cannot prove or reorder code inside those binaries without changing their surfaces or claiming a stronger containment/trust status. This audit therefore does not change any advisory/enforced status. A follow-up should add an explicit operator trust handshake plus an agent-specific pre-trust launch mode, subject to live probes; that is intentionally not implemented here because no existing trust-dialog API exists and inventing one would change surface semantics.

## Regression coverage

`test/pretrust-parsing-audit.test.ts` contains a fixture workspace whose poisoned project-local config and instruction files are created as *directory canaries*: `existsSync` succeeds but any open-and-read throws `EISDIR`, so a covered helper that reintroduces a pre-trust read fails loudly. What the tests actually prove:

- **Startup inventory (test 1):** `resolveTuiWorkspace`, `resolveDriverName`/`parseUniversalArgs`, `meteredOpencodeConfig`, and `resolveSkillsMountFor` complete without reading any of the six poisoned fixtures. (The legacy `collectToolboxMcpServers`/`readUserMcpSettings` reads are no longer asserted: `src/cli/mcp-settings.ts` was removed by W050, see the inventory row.)
- **Skills level map (test 2):** startup `levels.json` parsing is reachable only through `resolveSkillsLevelMap`, which resolves to `undefined` when absent and throws on malformed JSON (fail-closed).
- **Skills content (test 3):** composing the skills-mcp delivery mount does not read a `SKILL.md` canary.

What the tests do **not** prove:

- They are not universal fs instrumentation. A read swallowed by `try/catch` (e.g. `readFileOrUndefined`) would not be caught, so "no helper anywhere opened these files by any mechanism" is not established — only that the covered helpers, all of which propagate read errors, do not open them.
- **Skills discovery is not regression-tested.** Test 3 proves the mount composition does not read skill content; the actual discovery scan lives in the `list_skills` handler (`mcp-toolbox/apps/skills-mcp/src/server.ts:79-95`, `skills.ts:37-57`), is source-referenced only, and runs in response to an explicit post-trust MCP tool call.
- Entrypoints whose startup composes a live driver or agent subprocess are not covered (see criterion 3 below).

## Acceptance status

- Inventory table: complete for Workflow-owned paths identified by source search; external agent internals are separately called out. The toolbox discovery/persistent-MCP-settings row is recorded as removed-by-W050 rather than silently dropped.
- Consequential pre-trust Workflow parsing/execution: none found; no fix required. External-agent residual risk is recorded above.
- Ordering regression tests: **PARTIAL.** Covered inventory rows: TUI workspace argument resolution; universal driver selection (argument/driver resolution only, not driver composition); skills directory mount resolution; project-local agent config (OpenCode mount composition only); startup skills level-map parse. Uncovered rows remain: universal TUI startup; stock ACP TUI startup; browser launcher/service; hub discovery and lock state; hub scheduler and review provenance; skills-mcp process startup; skills discovery and content delivery (server handler); ACP filesystem reads (post-trust tool-call path); workspace scans by toolbox servers; persistent Workflow state; and the driver-composition half of universal driver selection. These entrypoints compose live runtimes/subprocesses and need either a process-level harness or per-runtime probes; a follow-up should add them (or record each as accepted residual) so criterion 3 can move from PARTIAL to met.
