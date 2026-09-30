<!-- Ledger fragment: opened 2026-09-30 as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### OpenCode v2 ACP live-probe harness: version-aware launch args (landed) (2026-09-30)

**Source:** operator escalation "Fix the OpenCode ACP live-probe harness for
opencode v2"; GitHub issue #284.

**Diagnosis (verified live, 2026-09-30).** The host carries opencode v2.0.10
(`opencode --version` -> `opencode v2.0.10`). On v2, `opencode acp --pure` and
`opencode acp --cwd <dir>` are UNKNOWN flags: v2 does not error, it prints its
CLI help page to **stdout** (`DESCRIPTION\n  Start an Agent Client Protocol
server ...`). The first line `DESCRIPTION` is not JSON, so the ACP NDJSON
decoder rejects it (`invalid ACP NDJSON: Unexpected token 'D'`) and every
harness turn dies at spawn before any model call. Standalone `opencode acp` on
v2 frames cleanly (initialize -> newSession -> prompt -> `stopReason
end_turn`).

**The connector was already v2-correct.** `src/integrations/acp-runtime.ts`
`opencodeAcpArgs(majorVersion)` returns `["acp", "--pure"]` for major < 2 and
`["acp"]` otherwise; `opencodeMajorVersion(executable)` probes `--version`; and
the working directory is carried by the launch config (`workspace`), never a
`--cwd` flag (see `createOpencodeRuntime`). Only the probe harness was stale,
hardcoding the v1 `acp --pure --cwd <dir>` shape.

**The fix.** New `test/opencode-probe-helpers.ts` mirrors the connector:

- `opencodeProbeArgs(executable)` -> `opencodeAcpArgs(await
  opencodeMajorVersion(executable))`, the version-aware args (used by probes
  that build their own contained launch config);
- `spawnOpencodeAcp(cwd, extraEnv?)` -> resolves the binary as
  `process.env.WORKFLOW_OPENCODE_BIN ?? "opencode"`, spawns it with the
  version-aware args, sets the child cwd through spawn options, and pipes
  stdio.

The five stale probes now launch through the helper, and the blanket `--cwd`
is gone from opencode arms:

| Test | Was | Now |
|---|---|---|
| `acp-real-probe.test.ts` | `spawn("opencode", ["acp", "--cwd", cwd])` | `spawnOpencodeAcp(cwd)`; cline arm keeps its `--acp ... --cwd` CLI shape |
| `acp-opencode-subagent-probe.test.ts` | `["acp", "--pure", "--cwd", cwd]` | `spawnOpencodeAcp(cwd)` |
| `acp-opencode-resume-probe.test.ts` | `["acp", "--pure", "--cwd", workspace]` | `spawnOpencodeAcp(workspace)` |
| `acp-opencode-mcp-mount-probe.test.ts` | `["acp", "--pure", "--cwd", workspace]` | `spawnOpencodeAcp(workspace, extraEnv)` |
| `acp-mutation-probe.test.ts` | `["acp", "--cwd", cwd]` | `spawnOpencodeAcp(cwd)` |

The cline arm of `acp-real-probe.test.ts` is behavior-unchanged: it still
appends `--cwd` (cline's `--acp` accepts it). No `src/` change was needed
(confirmed): the connector already dropped `--pure` for v2 and never used
`--cwd`.

**LIVE opencode v2 verification (2026-09-30).** `WORKFLOW_ACP_REAL=1` with the
operator's OpenRouter key as `OPENROUTER_API_KEY`, running
`test/acp-real-probe.test.ts`:

- opencode arm: PASS. `agentInfo.name = "OpenCode"`, `agentInfo.version =
  "2.0.10"`, `protocolVersion = 1`, live read turn completed,
  `stopReason = "end_turn"`.
- cline arm: PASS too (ambient cline 3.0.62 headless with `CLINE_API_KEY`):
  `agentInfo.name = "cline"`, version `3.0.62`, `protocolVersion = 1`,
  `stopReason = "end_turn"` (the read tool call was denied by the probe's
  fail-closed permission default, which is the expected probe behavior).
- TAP: `# tests 2 / # pass 2 / # fail 0`.

**Verification hygiene.** `npm run lint` exit 0; `npm run typecheck` exit 0
(unpiped); non-gated fast suites `test/tui-cli.test.ts` +
`test/acp-runtime-args.test.ts` 7/7.

**Deviations (recorded honestly).**

- A sixth opencode probe, `test/acp-opencode-metered-probe.test.ts`, carried
  the same stale `args: ["acp", "--pure"]` (it builds its own contained
  launch config). It is NOT in the operator's enumerated five, but it is the
  same v2 bug and would print help to stdout on v2, so it was fixed too, via
  the helper's `opencodeProbeArgs`. Gated; not run live here (needs bwrap).
- `test/acp-opencode-ask-probe.test.ts` already spawned `["acp"]` (no
  `--pure`/`--cwd`) and was left unchanged.
