# Guard Corpus Map — plugin adversarial cases to hub-side homes

Plan Task G6. The plugin's adversarial regression corpus
(`opencode-workflow-guard/test/test.mts`, ~hundreds of cases across ~18
policy modules) is the asset that must not be lost in the migration to the
control plane. This map inventories each policy family and states where the
case lives hub-side today, what remains probe work, and what is a
**documented hole** — corpus cases that cannot be expressed at the hub are
listed, not silently dropped.

Legend: **Ported** = hub-side equivalent exists and is tested. **Probe** =
needs a gated real-agent probe to carry over. **Hole** = not expressible at
the hub layer today; documented honestly.

| Corpus family (plugin cases) | Hub-side home | Status |
|---|---|---|
| Cline adapter fail-closed on malformed commands/reads/patches (empty batches, ambiguous fields, unmapped tools) | `src/adapters/cline.ts` + `test/cline-adapter.test.ts`, `test/adapter-conformance.test.ts` | **Ported** |
| ACP adapter fail-closed (malformed permission events, locations, subjects) + spawn classification | `src/adapters/acp.ts` + `test/acp-adapter.test.ts`, `test/acp-permission.test.ts` | **Ported** |
| Destructive-command policy (rm, force push, base64 pipes, script laundering, compound shell) | `guardCheck` in the vendored `workflow-guard-mcp` enforced by the hub on every surface (plan G2) + `test/hub-guard-interception.test.ts` | **Ported** (hub denies on policy; guard dispatcher owns the verb/matcher corpus) |
| Shell matching evasion: wrapper/brace wrappers, chained commands (`true && git push`), cluster-CLI option smuggling, pager detection | `workflow-guard-mcp`'s shell-safety/destructive policies, evaluated at `/before-tool`, `/bash`, and the ACP resolver | **Ported** (the matchers live in the vendored guard server — the corpus's evasion cases are its tests, kept alive in the toolbox) |
| Symlink path bypasses (ancestor resolution, dangling symlinks, symlinked worktree exclusions) | Hub workspace confinement (`pathWithinWorkspace`, canonical-existing-path) + `workflow-fs-exec-mcp` `resolveWithinWorkspace` with lstat-based ancestor walk and full-final-symlink resolution (`test/hub-client.test.ts` fs-bounds, incl. the dangling-final-symlink regression — caught as a live P0 by review on 2026-09-15 and fixed the same day) | **Ported** |
| Git write boundaries (external repos, protected branches, `git -C` escapes) | Guard `git` policy at `/before-tool` + `/bash` containment; worktree tools exist hub-side | **Probe** (needs gated real-agent runs to claim enforced parity per agent) |
| Settings tamper (`allow-live` escape, settings file writes) | Hub owns all settings; the agent never sees the real key (metering proxy) and its HOME is the scratch jail | **Ported by architecture** (the escape surface no longer exists on contained runs) |
| Secrets/credential policy | `credentials` capability default-deny; guard secrets policy at `/before-tool`; contained processes start with an empty environment | **Ported** |
| Task-list gating (no silent deletion, single/parent task focus, all-done verification) | Kernel task graph + `TASK_NOT_IN_PROGRESS` denies; `SKILL_DELIVERY_REQUIRED`; evidence freshness | **Ported** (superset: the kernel enforces transitions the plugin could only check) |
| Stale evidence / mutation freshness (parent-child sessions) | Kernel mutation epochs + per-task skill-read freshness | **Ported** |
| Compaction hooks (`experimental.session.compacting` bridge) | **Hole** — no ACP equivalent (plan G7 documented regression); the compaction ↔ memory bridge stays on the plugin surface until ACP compaction signaling stabilizes | **Hole** |
| Policy 24 claims-vs-evidence journal | `recordCompletionClaim` + `completionClaims()` (plan G5), observability-only | **Ported** |
| Worktree/checkpoint lifecycle guards | Hub-side worktree/run-registry lifecycle; scheduler fail-closed fire semantics | **Ported** (registry tests) |
| Learner-profile/learning policies | `learning-mcp` (toolbox) + `src/pedagogy/*` with tests | **Ported** |
| `permission.ask` journaling | Hub journals its own permission resolutions natively (reviewer/budget/claim journals) | **Ported** |

**Holes, stated plainly (not silently dropped):**

1. **Compaction-time context events** — the plugin gated memory flush and
   stale-write fingerprints at compaction; the hub cannot see or gate ACP
   compaction (gap G7). Acceptance: documented as a regression on ACP
   surfaces; revisited when the ACP compaction RFD stabilizes.
2. **In-session host-event fidelity** — cases that assert the host fires
   `tool.execute.before` with exact field shapes carry over only through
   per-agent probes (`acp-cline-tool-matrix` pattern). Until a probe runs
   for a pinned agent version, that agent is capped `advisory`
   (`docs/HOST_ADAPTERS.md`).
3. **Plugin-internal circuit-breaker heuristics** (repeated-failure
   escalation inside one host process) — the hub's fail-closed seams make
   retry storms bounded (deny → model retries against the same gate), but
   per-session escalation counters are not yet ported; scheduled-run budget
   caps bound the unattended case.

**Probe status (gated, credentials required — all ran live 2026-09-16):** B3
subagent probe (`test/acp-cline-subagent-probe.test.ts` — Red verdict in
`docs/HOST_ADAPTERS.md`: spawn tool call and permission invisible to the
hub); G1 opencode ask-config probe (`test/acp-opencode-ask-probe.test.ts` —
pass, denial-honor invariant); C1 scheduled real-agent turn
(`test/hub-scheduled-turn-probe.test.ts` — pass, full chain through the
hub's HTTP routes: fire → contained ACP turn → review gate + test evidence);
the MCP-config mount probe (`test/acp-cline-mcp-mount-probe.test.ts` — ran
against the vendored pinned entry and recorded a negative finding: the agent
honors none of the candidate scratch-home settings paths, `NO_MCP_TOOLS`;
the F1/G3 hub-owned MCP-config mounts stay deferred); the OpenCode
conformance probes (`test/acp-opencode-subagent-probe.test.ts` — Green
verdict: the `task` spawn projected and permission-gated at the hub;
`test/acp-opencode-mcp-mount-probe.test.ts` — positive on both hub-written
config surfaces, `list_skills` returned the fixture skill, F1/G3 unblocked
on OpenCode; `test/acp-opencode-resume-probe.test.ts` — model context
restored across restart, exact keyword recalled); tool-matrix probes
re-run per pinned Cline bump. All probes skip without their env gate;
evidence and verdicts live in the docs referenced above.
